/**
 * abap_debug — the ABAP debugger capture.
 *
 * A stopped debuggee holds a work process plus the request that ran it, so a one-shot capture
 * completes the whole debugger loop inside ONE tool call: arm breakpoints → long-poll the listener
 * on the stateless client → run the trigger → attach on one stateful session, opened on the
 * debuggee's application server (SAP attaches from no other) → follow that ONE run from stop to stop
 * (read, step, `stepContinue`) → release → always remove the capture's breakpoints and the listener.
 * With `interactive: true`, src/tools/debug-session.ts runs the same capture up to its first stop
 * and keeps the program waiting there between calls.
 * See docs/adt-debugger-protocol.md.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeObjectType, objectUrl } from '../abap/object-types.js';
import { runUnitTests } from '../adt/abap-unit.js';
import {
  contextServer,
  createDebugIdentity,
  type Debuggee,
  DebuggerSession,
  type DebugIdentity,
  type DebugListenResult,
  debuggerErrorSubType,
  debuggerErrorText,
  endSession,
  findListenerConflict,
  listDebugStatements,
  listenUntil,
  openSessionOnServer,
  openSessionsAhead,
  type PinnedSession,
  type SessionsAhead,
  stopListener,
} from '../adt/debugger.js';
import { AdtApiError } from '../adt/errors.js';
import type { AdtHttpClient } from '../adt/http.js';
import { isHostRelativeODataPath } from '../adt/odata-path.js';
import { searchObjects } from '../adt/repository.js';
import { getSessionUser, isPlausibleSapUser } from '../adt/session-user.js';
import type { SapConnection, ToolContext } from './connection.js';
import {
  type ArmedBreakpoints,
  armBreakpoints,
  armInRun,
  type BreakpointLocation,
  DebugInputError,
  disarm,
  type EventLocation,
  newResolutionCache,
  type ResolutionCache,
  resolveFunctionGroup,
  resolveLineTarget,
  type StopTarget,
  unsetRunEvents,
} from './debug-arm.js';
import { BackgroundWork, stillRunning } from './debug-background.js';
import {
  collectStops,
  type FirstStop,
  type Inspection,
  type StepMode,
  type StepUntil,
  type WatchItem,
} from './debug-follow.js';
import type { DebugInput } from './debug-input.js';
import { leftoversOf, recordArmed, removeLeftovers, settleArmed } from './debug-leftovers.js';
import {
  AHEAD_BUDGET_MS,
  type CallBudget,
  callDeadline,
  DEFAULT_LIMITS,
  type DebugLimits,
  MAX_TOTAL_STEPS,
  planCallBudget,
  RELEASE_BUDGET_MS,
  timings,
} from './debug-limits.js';
import {
  activeCount,
  type DebugEntry,
  entryOf,
  holderOf,
  nextDebugId,
  ownerOf,
  removeEntry,
  setEntry,
} from './debug-registry.js';
import { debuggeePosition } from './debug-view.js';
import { errorResult, type ToolResult, textResult, toolJson } from './result.js';

export type { SapConnection } from './connection.js';
export { setDebugTimingsForTests, setResultBudgetForTests } from './debug-limits.js';

const DEFAULT_TIMEOUT_SECONDS = 60;

type DebugTrigger = 'unittest' | 'http' | 'none';

export interface DebugRequest {
  type: string;
  name: string;
  /** The top-level line first, then `breakpoints`: all armed for the same run. */
  locations: BreakpointLocation[];
  /** The event breakpoints of `breakpoints`, then the top-level `exceptionClass`. */
  events: EventLocation[];
  trigger: DebugTrigger;
  triggerName?: string;
  url?: string;
  variables: string[];
  /** Steps after each stop. */
  steps: number;
  stepMode: StepMode;
  /** The steps end early once this holds. */
  until?: StepUntil;
  /** Watchpoints, set in the run at its first stop. */
  watch: WatchItem[];
  timeoutSeconds: number;
  /** The inspection's time budget, within the server's ceiling. */
  maxSeconds?: number;
  /** The result's size budget, within the server's ceiling. */
  maxResultKB?: number;
}

/** The `watch` items of a call: variables upper-cased, one watchpoint each. */
function readWatch(raw: unknown): WatchItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { variable, condition, hits } = item as Record<string, unknown>;
    const name = trimmed(variable)?.toUpperCase();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const where = trimmed(condition);
    return [{ variable: name, ...(where ? { condition: where } : {}), hits: typeof hits === 'number' ? hits : 1 }];
  });
}

const trimmed = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** A line/method breakpoint from the top-level `line` or a `breakpoints` item (type/name default to the top level). */
function readLocation(raw: Record<string, unknown>, type: string, name: string): BreakpointLocation | undefined {
  const line = typeof raw.line === 'number' ? raw.line : undefined;
  const method = trimmed(raw.method);
  if (line === undefined && method === undefined) return undefined;
  const include = trimmed(raw.include)?.toLowerCase();
  const ownType = trimmed(raw.type);
  const condition = trimmed(raw.condition);
  return {
    type: ownType ? normalizeObjectType(ownType) : type,
    name: (trimmed(raw.name) ?? name).toUpperCase(),
    ...(line !== undefined ? { line } : {}),
    ...(method ? { method } : {}),
    ...(include ? { include } : {}),
    ...(condition ? { condition } : {}),
    hits: typeof raw.hits === 'number' ? raw.hits : 1,
  };
}

/** An exception, message or statement breakpoint from a `breakpoints` item. */
function readEvent(raw: Record<string, unknown>): EventLocation | undefined {
  const hits = typeof raw.hits === 'number' ? raw.hits : 1;
  const exceptionClass = trimmed(raw.exceptionClass)?.toUpperCase();
  if (exceptionClass) return { kind: 'exception', exceptionClass, hits };
  const statement = trimmed(raw.statement)?.toUpperCase().replace(/\s+/g, ' ');
  if (statement) return { kind: 'statement', statement, hits };
  if (raw.message && typeof raw.message === 'object') {
    const message = raw.message as Record<string, unknown>;
    return {
      kind: 'message',
      id: String(message.id ?? '')
        .trim()
        .toUpperCase(),
      number: String(message.number ?? '')
        .trim()
        .padStart(3, '0'),
      type: String(message.type ?? '')
        .trim()
        .toUpperCase(),
      hits,
    };
  }
  return undefined;
}

function readRequest(args: Record<string, unknown>, type: string, name: string): DebugRequest {
  const str = (key: string): string | undefined => trimmed(args[key]);
  const variables = Array.isArray(args.variables)
    ? (args.variables as unknown[]).map((v) => String(v).trim().toUpperCase()).filter(Boolean)
    : [];
  const top = name.trim().toUpperCase();
  const extra = Array.isArray(args.breakpoints) ? (args.breakpoints as unknown[]) : [];
  const locations = [args, ...extra].flatMap((raw) => {
    const location =
      raw && typeof raw === 'object' ? readLocation(raw as Record<string, unknown>, type, top) : undefined;
    return location ? [location] : [];
  });
  const events = extra.flatMap((raw) => {
    const event = raw && typeof raw === 'object' ? readEvent(raw as Record<string, unknown>) : undefined;
    return event ? [event] : [];
  });
  const exceptionClass = str('exceptionClass')?.toUpperCase();
  if (exceptionClass) events.push({ kind: 'exception', exceptionClass, hits: 1 });
  const until = readUntil(args.until);
  return {
    type,
    name: top,
    locations,
    events,
    trigger: (str('trigger') as DebugTrigger | undefined) ?? 'unittest',
    ...(str('triggerName') ? { triggerName: str('triggerName')?.toUpperCase() } : {}),
    ...(str('url') ? { url: str('url') } : {}),
    variables: [...new Set(variables)],
    // `until` without `steps`: step until it holds, within the budgets.
    steps: typeof args.steps === 'number' ? args.steps : until ? MAX_TOTAL_STEPS : 0,
    stepMode: (str('stepMode') as StepMode | undefined) ?? 'over',
    ...(until ? { until } : {}),
    watch: readWatch(args.watch),
    timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
    ...(typeof args.maxSeconds === 'number' ? { maxSeconds: args.maxSeconds } : {}),
    ...(typeof args.maxResultKB === 'number' ? { maxResultKB: args.maxResultKB } : {}),
  };
}

/** `until`: a line and/or a variable whose change ends the steps. */
export function readUntil(raw: unknown): StepUntil | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { line, changed } = raw as Record<string, unknown>;
  const variable = trimmed(changed)?.toUpperCase();
  const until: StepUntil = {
    ...(typeof line === 'number' ? { line } : {}),
    ...(variable ? { changed: variable } : {}),
  };
  return until.line !== undefined || until.changed ? until : undefined;
}

/** The request of a validated abap_debug call. */
export function readDebugRequest(input: DebugInput): DebugRequest {
  const type = input.type ? normalizeObjectType(input.type) : '';
  return readRequest(input as Record<string, unknown>, type, input.name ?? '');
}

/**
 * The SAP user to debug: the session's own logon user, never a caller-supplied one. SAP names it
 * first, inside this very session (systeminformation). Where the release lacks that resource
 * (SAP_BASIS 7.50 and older) only SAP_USER counts, and only behind Basic or cookie authentication,
 * where it IS the logon user. An empty or wrong `requestUser` makes SAP's listener match nothing
 * (or someone else's run), so unknown means refuse.
 */
export async function resolveDebugUser(conn: SapConnection): Promise<string | undefined> {
  const fromSap = await getSessionUser(conn.http);
  if (fromSap) return fromSap;
  const known = (conn.logonUser ?? '').trim().toUpperCase();
  return isPlausibleSapUser(known) ? known : undefined;
}

// ─── Trigger ───────────────────────────────────────────────────────

type TriggerPlan =
  | { kind: 'unittest'; objectUrl: string; label: string }
  | { kind: 'http'; url: string; label: string }
  | { kind: 'none'; label: string };

type TriggerOutcome = { status: 'completed'; result: Record<string, unknown> } | { status: 'failed'; error: string };

/** The ABAP Unit object type of `name` — exact repository match on CLAS, PROG or FUGR. */
async function resolveUnitTestObjectType(conn: SapConnection, name: string): Promise<string> {
  const matches = (await searchObjects(conn.http, name, 20))
    .filter((result) => result.name.toUpperCase() === name)
    .map((result) => result.type.split('/')[0] ?? '')
    .filter((type) => ['CLAS', 'PROG', 'FUGR'].includes(type));
  const types = [...new Set(matches)];
  if (types.length === 1) return types[0] as string;
  throw new DebugInputError(
    types.length === 0
      ? `triggerName ${name} is not a class, program or function group this system knows.`
      : `triggerName ${name} is ambiguous (${types.join(', ')}).`,
  );
}

async function planTrigger(conn: SapConnection, req: DebugRequest, cache: ResolutionCache): Promise<TriggerPlan> {
  if (req.trigger === 'none') return { kind: 'none', label: 'none (run it yourself as the same SAP user)' };
  if (req.trigger === 'http') {
    if (!req.url) throw new DebugInputError('trigger="http" needs url (a host-relative OData path).');
    if (!isHostRelativeODataPath(req.url)) {
      throw new DebugInputError(
        'trigger="http" url must be a host-relative OData path on the connected system — "/sap/opu/odata4/…" or "/sap/opu/odata/sap/<SRV>/…"; absolute URLs and other paths are rejected.',
      );
    }
    return { kind: 'http', url: req.url, label: `GET ${req.url}` };
  }
  // Without a top-level object, the first breakpoint's object runs its unit tests.
  const object = req.type && req.name ? { type: req.type, name: req.name } : req.locations[0];
  let name = req.triggerName ?? object?.name;
  let type = req.triggerName ? await resolveUnitTestObjectType(conn, req.triggerName) : object?.type;
  if (!type || !name) {
    throw new DebugInputError(
      'trigger="unittest" needs the unit-test object: triggerName (a CLAS, PROG or FUGR), or a CLAS/PROG/FUNC breakpoint object.',
    );
  }
  if (type === 'FUNC') {
    name = await resolveFunctionGroup(conn, name, cache);
    type = 'FUGR';
  }
  if (!['CLAS', 'PROG', 'FUGR'].includes(type)) {
    throw new DebugInputError(`trigger="unittest" runs ABAP Unit for CLAS, PROG or FUGR (got "${type}").`);
  }
  return { kind: 'unittest', objectUrl: objectUrl(type, name), label: `ABAP Unit ${type} ${name}` };
}

interface RunningTrigger {
  settled: Promise<TriggerOutcome>;
}

/** `session`: pinned ahead of the run — the unit tests, and so the debuggee, run on its server. */
function startTrigger(
  conn: SapConnection,
  plan: TriggerPlan,
  fetchTimeoutMs: number,
  session?: AdtHttpClient,
): RunningTrigger | undefined {
  const options = { fetchTimeoutMs };
  let run: Promise<Record<string, unknown>>;
  if (plan.kind === 'unittest') {
    run = runUnitTests(session ?? conn.http, plan.objectUrl, options).then((result) => ({
      outcome: result.outcome,
      ...result.summary,
    }));
  } else if (plan.kind === 'http') {
    run = conn.http
      .get(plan.url, undefined, options)
      .then((resp) => ({ statusCode: resp.statusCode, responseBytes: Buffer.byteLength(resp.body ?? '') }));
  } else {
    return undefined;
  }
  return {
    settled: run.then(
      (result): TriggerOutcome => ({ status: 'completed', result }),
      (err): TriggerOutcome => ({ status: 'failed', error: err instanceof Error ? err.message : String(err) }),
    ),
  };
}

/**
 * A refusal SAP answered leaves nothing attached — a 4xx, or its "cannot attach" exception
 * (`invalidDebuggee`, sent as a 500); a transport failure leaves the state unknown.
 */
function attachDefinitelyFailed(err: unknown): boolean {
  if (!(err instanceof AdtApiError)) return false;
  return (err.statusCode >= 400 && err.statusCode < 500) || debuggerErrorSubType(err) === 'invalidDebuggee';
}

/**
 * SAP attaches in non-exclusive mode when every work process it allows for exclusive debugging is
 * taken (`rdisp/wpdbug_max_no`), for users with debug change authorization only. There the program
 * rolls out after each debugger interaction, which commits its open database work — no capture
 * may do that, so the program is released at once.
 */
const NON_EXCLUSIVE_ERROR =
  "SAP attached in non-exclusive mode: every work process SAP allows for exclusive debugging is in use (profile parameter rdisp/wpdbug_max_no), and in this mode each debugger step commits the program's open database changes. The capture let the program run on at once, without inspecting it. Retry when a debugging work process is free — an Eclipse or ADAM debug session that ends frees one.";
const NON_EXCLUSIVE_NOTE = 'the run was released at its first stop without inspection (non-exclusive debugging)';

/** What `inspect` leaves behind: the inspection, and the attached session when the caller keeps it. */
export interface Attachment extends Inspection {
  session?: DebuggerSession;
  sessionHttp?: AdtHttpClient;
}

/**
 * Attach to the caught debuggee from a session on its application server, then `follow` the run.
 * Afterwards the run is released and the session ended — unless `keep()` says the caller holds on
 * to both (an interactive session).
 */
export async function inspect(
  run: CaptureRun,
  debuggee: Debuggee,
  budget: CallBudget,
  follow: (session: DebuggerSession, first: FirstStop, inspection: Inspection) => Promise<void>,
  keep: () => boolean = () => false,
): Promise<Attachment> {
  const { conn, identity, warnings } = run;
  const ready = run.attachedFrom;
  const inspection: Attachment = { attached: false, stops: [], hits: new Map() };
  if (debuggee.attachImpossible) {
    if (ready) await endSession(ready, { deadline: Date.now() + RELEASE_BUDGET_MS });
    return {
      ...inspection,
      error:
        'SAP reports this debuggee cannot be attached (IS_ATTACH_IMPOSSIBLE), e.g. it runs on another application server.',
    };
  }
  const { deadline } = budget;
  let pinned: PinnedSession;
  try {
    pinned = ready
      ? { http: ready, instance: debuggee.instance, probes: 0 }
      : await openSessionOnServer(conn.http, debuggee.instance, { deadline });
  } catch (err) {
    return { ...inspection, error: `Could not open a debugger session: ${debuggerErrorText(err)}` };
  }
  const sessionHttp = pinned.http;
  const session = new DebuggerSession(sessionHttp, identity, { deadline });
  let attachState: 'none' | 'attached' | 'unknown' = 'unknown';
  try {
    const attach = await session.attach(debuggee.id);
    attachState = 'attached';
    inspection.attached = true;
    if (attach.nonExclusive) {
      // Every further debugger interaction would commit the program's work: release it untouched.
      if (run.armed) unsetRunEvents(run.armed, NON_EXCLUSIVE_NOTE);
      inspection.error = NON_EXCLUSIVE_ERROR;
      return inspection;
    }
    if (attach.postMortem) warnings.push('SAP attached a post-mortem (short dump) session — inspection only.');
    await run.clearExternal();
    if (run.armed && !attach.postMortem) await armInRun(session, run.armed, run.armedIds, warnings);
    await follow(
      session,
      {
        reachedBreakpoints: attach.reachedBreakpoints.map((bp) => bp.id).filter(Boolean),
        steppingPossible: attach.steppingPossible,
        single: attach.postMortem,
        unresolvable: attach.reachedBreakpoints.filter((bp) => bp.unresolvableCondition),
      },
      inspection,
    );
  } catch (err) {
    if (attachState === 'unknown' && attachDefinitelyFailed(err)) attachState = 'none';
    const subType = debuggerErrorSubType(err);
    inspection.error = `${debuggerErrorText(err)}${subType ? ` (${subType})` : ''}`;
    if (subType === 'noSessionAttached') {
      inspection.error +=
        ' — the attach did not survive into the next request: the system did not keep the stateful ADT session the debugger needs (releases below 7.51 may lack that support).';
    }
    const elsewhere =
      pinned.instance && debuggee.instance && pinned.instance.toUpperCase() !== debuggee.instance.toUpperCase();
    if (subType === 'invalidDebuggee' && elsewhere) {
      inspection.error += ` — SAP attaches only from the debuggee's application server (${debuggee.instance}), and none of ${pinned.probes} new sessions landed there (the last on ${pinned.instance}): while a debuggee waits, SAP's load balancer sends new sessions elsewhere. Retry the capture.`;
    }
  } finally {
    if (attachState === 'attached' && !inspection.error && !inspection.release && keep()) {
      inspection.session = session;
      inspection.sessionHttp = sessionHttp;
    } else {
      // A run that already ended needs no release.
      if (attachState !== 'none' && !inspection.release) {
        const releaser = new DebuggerSession(sessionHttp, identity, {
          deadline: Date.now() + RELEASE_BUDGET_MS,
        });
        inspection.release = await releaser.release(run.armedIds, inspection.watchpointIds);
      }
      // A debuggee that could not be released keeps its debugger session; any other ends here.
      if (attachState === 'none' || inspection.release?.released) {
        await endSession(sessionHttp, { deadline: Date.now() + RELEASE_BUDGET_MS });
      }
    }
  }
  return inspection;
}

// ─── Capture ───────────────────────────────────────────────────────

/**
 * Statement breakpoints, checked before anything is armed: they need a line or method breakpoint to
 * enter the run (they are set in that run only — armed for the whole user, a statement as common as
 * CLEAR stops every request of the user, this server's own included), and a kind SAP knows.
 */
async function checkStatements(conn: SapConnection, events: readonly EventLocation[], entered: boolean) {
  const statements = events.flatMap((event) => (event.kind === 'statement' ? [event.statement] : []));
  if (statements.length === 0) return;
  if (!entered) {
    throw new DebugInputError(
      `A statement breakpoint (${statements.join(', ')}) is set in the debugged run only: armed for the whole SAP user it would stop every request that runs the statement — this server's own included. Add a line or method breakpoint that stops the run first; the statement breakpoint then applies from that stop on.`,
    );
  }
  let known: string[];
  try {
    known = (await listDebugStatements(conn.http)).map((statement) => statement.name.toUpperCase()).filter(Boolean);
  } catch {
    return; // SAP's own refusal at the first stop will say it
  }
  if (known.length === 0) return;
  const unknown = statements.filter((statement) => !known.includes(statement));
  if (unknown.length > 0) {
    throw new DebugInputError(
      `SAP knows no statement kind ${unknown.join(', ')}. Its statement kinds: ${[...new Set(known)].join(', ')}.`,
    );
  }
}

type ListenSettled = DebugListenResult | { status: 'error'; error: unknown };

function notHitHint(req: DebugRequest, user: string, triggerFinished: boolean, triggerFailed: boolean): string {
  if (triggerFailed) {
    return req.trigger === 'http'
      ? 'The trigger request itself failed (trigger.error), so nothing ran to the breakpoint. Make that call work on its own first (the same path in a browser or REST client, as the same SAP user). A service published moments ago can answer 403 "blocked by UCON" for a few minutes (seen on the BTP ABAP Environment).'
      : 'The trigger itself failed (trigger.error), so nothing ran to the breakpoint. Make the unit tests run on their own first (ADT: Run As → ABAP Unit Test).';
  }
  const race =
    ' If the line is certainly executed, retry once: the run may have reached it before SAP registered the listener. Right after an activation, wait about a minute first: with several application servers, the new version may not yet have reached the one that ran the code.';
  if (triggerFinished && req.trigger === 'unittest') {
    return `The unit tests finished without reaching the breakpoint — check that a harmless test covers this code (ABAP Unit coverage in ADT shows which methods the tests reach), or use trigger="http" / trigger="none".${race}`;
  }
  if (triggerFinished) return `The trigger finished without reaching the breakpoint.${race}`;
  return `Nothing stopped within ${req.timeoutSeconds}s. With trigger="none", run the code as SAP user ${user} (the same user) while the capture waits — e.g. open the Fiori app or run the report — and retry.`;
}

/**
 * Sessions opened before the run (see `openSessionsAhead`). Only the capture's unit-test trigger can run on
 * one; for the others the pair's second session is ended at once. A failure only costs the pinning.
 */
async function openAhead(conn: SapConnection, plan: TriggerPlan, warnings: string[]): Promise<SessionsAhead> {
  let ahead: SessionsAhead;
  try {
    ahead = await openSessionsAhead(conn.http, { deadline: Date.now() + AHEAD_BUDGET_MS });
  } catch (err) {
    warnings.push(
      `Could not open debugger sessions ahead of the run (${debuggerErrorText(err)}); the attach looks for the debuggee's server after the stop instead.`,
    );
    return { byServer: new Map() };
  }
  if (ahead.trigger && plan.kind !== 'unittest') {
    await endSession(ahead.trigger, { deadline: Date.now() + AHEAD_BUDGET_MS });
    return { byServer: ahead.byServer };
  }
  return ahead;
}

/** The parts of every capture result: the user, the breakpoints, the trigger. */
export interface CaptureBase {
  user: string;
  breakpoints: Array<Record<string, unknown>>;
  trigger: Record<string, unknown>;
}

/** A caught run: the debuggee waiting at its first stop, the breakpoints armed for it. */
export interface Caught {
  debuggee: Debuggee;
  armed: ArmedBreakpoints;
  base: CaptureBase;
}

/**
 * Everything one capture sets up on SAP — external breakpoints, the listener, sessions opened ahead,
 * the trigger — and how it all comes down again.
 */
export class CaptureRun {
  readonly identity: DebugIdentity;
  readonly warnings: string[] = [];
  /** Server ids of every breakpoint the capture left armed — the cleanup list. */
  readonly armedIds: string[] = [];
  /** The session opened ahead on the debuggee's server, which the attach uses. */
  attachedFrom: AdtHttpClient | undefined;
  /** What the capture armed: the attach sets its run-only event breakpoints from it. */
  armed: ArmedBreakpoints | undefined;
  readonly startedAt = Date.now();
  private ahead: SessionsAhead = { byServer: new Map() };
  private listenerStarted = false;
  private externalCleared = false;
  private tornDown = false;
  private running: RunningTrigger | undefined;
  private readonly listenAbort = new AbortController();

  constructor(
    readonly conn: SapConnection,
    readonly req: DebugRequest,
    readonly user: string,
  ) {
    this.identity = createDebugIdentity(user);
  }

  /** The external breakpoints go once SAP copied them into the attached session (or nothing stopped). */
  async clearExternal(): Promise<void> {
    if (this.externalCleared) return;
    this.externalCleared = true;
    settleArmed(this.identity, await disarm(this.conn, this.identity, this.armedIds, this.warnings));
  }

  /** Idempotent: runs before a result is built (so its warnings are reported) and again in finally. */
  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    this.listenAbort.abort();
    await this.clearExternal();
    for (const session of this.ahead.byServer.values()) {
      if (session !== this.attachedFrom) await endSession(session, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
    if (this.ahead.trigger && !this.running) {
      await endSession(this.ahead.trigger, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
    if (!this.listenerStarted) return;
    try {
      await stopListener(this.conn.http, this.identity.user);
    } catch (err) {
      this.warnings.push(
        `Could not remove the debugger listener for ${this.identity.user}: ${debuggerErrorText(err)}.`,
      );
    }
  }

  /** The trigger's own answer once the run is released, waited for a little while. */
  async settleTrigger(): Promise<Record<string, unknown> | undefined> {
    const running = this.running;
    if (!running) return undefined;
    const settled = await Promise.race([running.settled, sleep(timings.triggerSettleMs).then(() => undefined)]);
    // The trigger's session ends with its run; a run still going keeps it until SAP's session timeout.
    if (settled && this.ahead.trigger) {
      await endSession(this.ahead.trigger, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
    return settled ?? { status: 'running', note: 'still running when the capture returned' };
  }

  /**
   * Resolve the breakpoints, arm them, start the listener and the trigger, and wait for the run to
   * stop. Everything that can fail on input is resolved BEFORE any debugger state exists on SAP.
   * `triggerTimeoutMs`: how long the trigger's own request may wait — through the stop and the
   * inspection that follows it.
   */
  async catchDebuggee(context: ToolContext, triggerTimeoutMs: number): Promise<{ result: ToolResult } | Caught> {
    const { conn, req, user, identity, warnings } = this;
    const cache = newResolutionCache();
    const targets: StopTarget[] = [];
    for (const location of req.locations) {
      targets.push({
        ...(await resolveLineTarget(conn, location, cache)),
        hits: location.hits,
        ...(location.condition ? { condition: location.condition } : {}),
      });
    }
    if (targets.length === 0 && req.events.length === 0) {
      throw new DebugInputError(
        'Give a breakpoint: breakpoints (a line, a CLAS method, a message, a statement or an exception class each), line (with type + name), and/or exceptionClass.',
      );
    }
    await checkStatements(conn, req.events, targets.length > 0);
    const plan = await planTrigger(conn, req, cache);

    const conflict = await findListenerConflict(conn.http, identity);
    if (conflict) {
      return {
        result: errorResult(
          `Another debugger is already listening for SAP user ${user}: ${conflict}. A capture never takes over an active debug session (Eclipse, VS Code or another capture) — stop that session first. If none runs (a capture that crashed leaves its listener for up to two minutes), abap_breakpoints with action "delete" and listener: true removes it.`,
        ),
      };
    }

    // Breakpoints an earlier capture of this user left behind would stop this run at odd places too.
    const leftovers = leftoversOf(conn.http, user);
    if (leftovers.length > 0) {
      const { removed, failed } = await removeLeftovers(conn.http, leftovers, {
        deadline: Date.now() + AHEAD_BUDGET_MS,
      });
      if (removed.length > 0) {
        warnings.push(`Removed the breakpoints ${removed.length} earlier capture(s) of this user left behind.`);
      }
      for (const { error } of failed) {
        warnings.push(`Could not remove the breakpoints an earlier capture left behind: ${error}.`);
      }
    }

    // Sessions open BEFORE anything is armed: once breakpoints are armed, this server's own requests
    // run as the debugged user too and must stay as few as possible.
    this.ahead = await openAhead(conn, plan, warnings);
    recordArmed(conn.http, identity);
    const armed = await armBreakpoints(conn, identity, targets, req.events, this.armedIds);
    this.armed = armed;
    if (armed.ids.length === 0) {
      return {
        result: errorResult(
          toolJson({
            hit: false,
            error: 'SAP refused every breakpoint — nothing was armed.',
            breakpoints: armed.report,
          }),
        ),
      };
    }

    this.listenerStarted = true;
    const listen: Promise<ListenSettled> = listenUntil(conn.http, identity, req.timeoutSeconds, {
      signal: this.listenAbort.signal,
    }).catch((error: unknown) => ({ status: 'error' as const, error }));

    if (plan.kind !== 'none') {
      await sleep(timings.armDelayMs);
      this.running = startTrigger(conn, plan, triggerTimeoutMs, this.ahead.trigger);
    }
    const running = this.running;
    const signal = context.signal;
    const cancelled = signal
      ? new Promise<{ source: 'cancelled' }>((resolve) => {
          if (signal.aborted) resolve({ source: 'cancelled' });
          else signal.addEventListener('abort', () => resolve({ source: 'cancelled' }), { once: true });
        })
      : undefined;
    const waitStart = Date.now();
    context.progress?.(`waiting for the run to stop at a breakpoint (0 of ${req.timeoutSeconds} s)`);
    const ticker = context.progress
      ? setInterval(
          () =>
            context.progress?.(
              `waiting for the run to stop at a breakpoint (${Math.round((Date.now() - waitStart) / 1000)} of ${req.timeoutSeconds} s)`,
            ),
          timings.waitTickMs,
        )
      : undefined;
    let first:
      | { source: 'listener'; outcome: ListenSettled }
      | { source: 'trigger'; outcome: TriggerOutcome }
      | { source: 'cancelled' };
    try {
      first = await Promise.race([
        listen.then((outcome) => ({ source: 'listener' as const, outcome })),
        ...(running ? [running.settled.then((outcome) => ({ source: 'trigger' as const, outcome }))] : []),
        ...(cancelled ? [cancelled] : []),
      ]);
    } finally {
      if (ticker) clearInterval(ticker);
    }
    // A suspended run cannot finish: a trigger that settles first ran without stopping — end the poll.
    const triggerFinished = first.source === 'trigger';
    if (first.source !== 'listener') this.listenAbort.abort();
    const outcome: ListenSettled = first.source === 'listener' ? first.outcome : await listen;
    // Where the capture's own run went (pinned ahead of it): the server the debuggee stops on.
    const triggerServer =
      running && this.ahead.trigger ? contextServer(this.ahead.trigger.sessionContextId) : undefined;
    const base: CaptureBase = {
      user,
      breakpoints: armed.report,
      trigger: { kind: plan.kind, target: plan.label, ...(triggerServer ? { server: triggerServer } : {}) },
    };

    if (outcome.status !== 'caught') {
      unsetRunEvents(armed);
      await this.teardown();
      const triggerOutcome = await this.settleTrigger();
      const triggerFailure =
        first.source === 'trigger' && first.outcome.status === 'failed' ? first.outcome : undefined;
      const reason =
        first.source === 'cancelled'
          ? 'cancelled'
          : outcome.status === 'conflict'
            ? `conflict: ${outcome.message}`
            : triggerFailure
              ? `trigger failed: ${triggerFailure.error}`
              : triggerFinished
                ? 'trigger finished without reaching the breakpoint'
                : outcome.status === 'error'
                  ? `listener failed: ${debuggerErrorText(outcome.error)}`
                  : 'timeout';
      return {
        result: textResult(
          toolJson({
            hit: false,
            reason,
            ...base,
            trigger: { ...base.trigger, ...(triggerOutcome ?? {}) },
            ...(warnings.length > 0 ? { warnings } : {}),
            hint: notHitHint(req, user, triggerFinished, triggerFailure !== undefined),
          }),
        ),
      };
    }

    const { debuggee } = outcome;
    this.attachedFrom = debuggee.instance ? this.ahead.byServer.get(debuggee.instance.toUpperCase()) : undefined;
    return { debuggee, armed, base };
  }
}

/** The debuggee as a result shows it. */
export function describeDebuggee(debuggee: Debuggee): Record<string, unknown> {
  return {
    user: debuggee.user,
    program: debuggee.program,
    ...debuggeePosition(debuggee),
    ...(debuggee.kind ? { kind: debuggee.kind } : {}),
    ...(debuggee.instance ? { server: debuggee.instance } : {}),
  };
}

/** The breakpoints report with how often each stopped the run (0 = never while it was followed). */
export function breakpointsWithHits(armed: ArmedBreakpoints, hits: ReadonlyMap<string, number>) {
  const breakpoints = armed.report.map((entry) => ({ ...entry }));
  for (const bp of armed.armed) {
    const entry = breakpoints[bp.reportIndex];
    if (entry) entry.hits = hits.get(bp.clientId) ?? 0;
  }
  return breakpoints;
}

/**
 * The result of a capture the run is released from: what it recorded, the release, and the
 * trigger's own answer. Takes down what the capture set up on SAP first.
 */
export async function captureResult(run: CaptureRun, caught: Caught, inspection: Inspection): Promise<ToolResult> {
  const { warnings } = run;
  const { debuggee, armed, base } = caught;
  if (!inspection.attached) unsetRunEvents(armed);
  await run.teardown();
  const triggerOutcome = await run.settleTrigger();
  if (inspection.release && !inspection.release.released) {
    warnings.push(
      `The debuggee could not be released (${inspection.release.detail ?? 'unknown'}); it stays suspended until SAP's debugger timeout ends its session.`,
    );
  }
  return textResult(
    toolJson({
      hit: true,
      ...base,
      breakpoints: inspection.attached ? breakpointsWithHits(armed, inspection.hits) : armed.report,
      debuggee: describeDebuggee(debuggee),
      attached: inspection.attached,
      ...(inspection.watchpoints ? { watchpoints: inspection.watchpoints } : {}),
      ...(inspection.stops.length > 0 ? { stops: inspection.stops } : {}),
      ...(inspection.release ? { release: inspection.release } : {}),
      ...(inspection.error ? { error: inspection.error } : {}),
      trigger: { ...base.trigger, ...(triggerOutcome ?? {}) },
      seconds: Math.round((Date.now() - run.startedAt) / 1000),
      // One warning per kind: every stop of a big frame would repeat the same one.
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    }),
  );
}

/** Budget options from a tool call's context. */
export function budgetContext(context: ToolContext) {
  return {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.progress ? { progress: context.progress } : {}),
  };
}

async function runCapture(conn: SapConnection, req: DebugRequest, user: string, context: ToolContext) {
  const run = new CaptureRun(conn, req, user);
  const budget = planCallBudget(conn.limits ?? DEFAULT_LIMITS, req, run.warnings, budgetContext(context));
  try {
    const caught = await run.catchDebuggee(
      context,
      req.timeoutSeconds * 1000 + budget.seconds * 1000 + RELEASE_BUDGET_MS,
    );
    if ('result' in caught) return caught.result;
    // The inspection budget starts at the stop.
    budget.deadline = Date.now() + budget.seconds * 1000;
    const inspection = await inspect(run, caught.debuggee, budget, (session, first, record) =>
      collectStops(session, req, caught.armed.armed, first, record, budget, run.warnings),
    );
    return await captureResult(run, caught, inspection);
  } finally {
    await run.teardown();
  }
}

export const UNKNOWN_USER_MESSAGE =
  "Cannot tell which SAP user this session runs as, and SAP's debugger needs that logon user (requestUser) to catch anything. SAP did not name it (/sap/bc/adt/core/http/systeminformation is missing on SAP_BASIS 7.50 and older); there, set SAP_USER to the logon user (Basic or cookie authentication).";

/** Why the owner of `entry` cannot start a capture or a session while it is active. */
function ownEntryBusy(entry: DebugEntry): string {
  return entry.kind === 'capture'
    ? `Your debug capture ${entry.id} is still running: abap_debug_session action="wait" returns its result, action="end" stops it.`
    : `Your interactive debug session ${entry.id} is still open: end it with abap_debug_session action="end" before starting another.`;
}

/** Why SAP user `holder.user` cannot be debugged now: `holder` debugs it — SAP keys the listener by user. */
function userBusy(holder: DebugEntry, limits: DebugLimits): string {
  return holder.kind === 'capture'
    ? `A debug capture (${holder.id}) for SAP user ${holder.user} is already running on this server — wait for it to finish.`
    : `An interactive debug session (${holder.id}) for SAP user ${holder.user} is open on this server — it must end first: abap_debug_session action="end" from its owner, or it is released after ${limits.idleSeconds} s without a call.`;
}

/** Why the server takes no further capture or session: the cap of its kind is reached. */
function capReached(kind: DebugEntry['kind'], limits: DebugLimits): string | undefined {
  const [count, max, variable, what] =
    kind === 'capture'
      ? [activeCount('capture'), limits.maxCaptures, 'ABAP_DEBUGGER_MAX_CAPTURES', 'Debug captures running']
      : [activeCount('session'), limits.maxSessions, 'ABAP_DEBUGGER_MAX_SESSIONS', 'Interactive debug sessions open'];
  if (count < max) return undefined;
  return `${what} on this server: ${count} of ${max} (${variable}). Each can hold an SAP work process while its program is stopped — try again when one has ended.`;
}

/**
 * Why `owner` cannot start a capture or session (`kind`) for SAP user `user` now; undefined: go
 * ahead. The caller registers its entry without awaiting anything in between, so the checks and the
 * claim are atomic.
 */
export function refuseStart(
  owner: string,
  user: string,
  kind: DebugEntry['kind'],
  limits: DebugLimits,
): string | undefined {
  const own = entryOf(owner);
  if (own?.active) return ownEntryBusy(own);
  const holder = holderOf(user);
  if (holder) return userBusy(holder, limits);
  return capReached(kind, limits);
}

/**
 * The abap_debug tool: one capture per SAP user at a time. The capture runs in the background and
 * the call waits for it up to its budget (ABAP_DEBUGGER_CALL_SECONDS); a capture still waiting for
 * its stop or following its run then answers with its session id, for abap_debug_session "wait".
 */
export async function handleDebugCapture(
  conn: SapConnection,
  input: DebugInput,
  context: ToolContext = {},
): Promise<ToolResult> {
  const owner = ownerOf(context);
  const limits = conn.limits ?? DEFAULT_LIMITS;
  const user = await resolveDebugUser(conn);
  if (!user) return errorResult(UNKNOWN_USER_MESSAGE);
  const refused = refuseStart(owner, user, 'capture', limits);
  if (refused) return errorResult(refused);
  const req = readDebugRequest(input);
  const work = new BackgroundWork(nextDebugId(), owner, 'capture', user, 'arming the breakpoints', async (ctx) => {
    try {
      return await runCapture(conn, req, user, ctx);
    } catch (err) {
      if (err instanceof DebugInputError) return errorResult(err.message);
      throw err;
    }
  });
  setEntry(work);
  return answerWhenDone(work, context, limits);
}

/** Wait for a capture (or a session's start) up to the call's budget: its answer, or that it goes on. */
export async function answerWhenDone(work: BackgroundWork, context: ToolContext, limits: DebugLimits) {
  const result = await work.waitFor(context, callDeadline(limits));
  if (!result) return stillRunning(work, limits);
  // Answered: nothing is left to wait for (a session that started is its owner's entry now).
  removeEntry(work);
  return result;
}

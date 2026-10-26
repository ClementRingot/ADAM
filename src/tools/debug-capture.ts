/**
 * abap_debug — one-shot ABAP debugger capture. Ported from ARC-1 (src/handlers/debug.ts).
 *
 * A stopped debuggee holds a work process plus the request that ran it, so the whole debugger loop
 * completes inside ONE tool call: arm breakpoints → long-poll the listener on the stateless client →
 * run the trigger → attach on one stateful session, opened on the debuggee's application server
 * (SAP attaches from no other) → follow that ONE run from stop to stop (read, step, `stepContinue`)
 * → release → always remove the capture's breakpoints and the listener. The model gets snapshots
 * of one run, never a remote control.
 * See docs/research/2026-10-22-abap-debugger-one-shot-capture.md.
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
  listenForDebuggee,
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
import type { SapConnection } from './connection.js';
import {
  type ArmedBreakpoints,
  armBreakpoints,
  type BreakpointLocation,
  DebugInputError,
  disarm,
  type EventLocation,
  newResolutionCache,
  type ResolutionCache,
  resolveFunctionGroup,
  resolveLineTarget,
  type StopTarget,
} from './debug-arm.js';
import { collectStops, type Inspection, type StepMode } from './debug-follow.js';
import type { DebugInput } from './debug-input.js';
import { AHEAD_BUDGET_MS, INSPECTION_BUDGET_MS, RELEASE_BUDGET_MS, timings } from './debug-limits.js';
import { debuggeePosition } from './debug-view.js';
import { errorResult, type ToolResult, textResult, toolJson } from './result.js';

export type { SapConnection } from './connection.js';
export { setDebugTimingsForTests, setResultBudgetForTests } from './debug-limits.js';

const DEFAULT_TIMEOUT_SECONDS = 60;

/** Captures in flight in this process, by SAP user: SAP keys the listener by user, so one at a time each. */
const activeCaptures = new Set<string>();

type DebugTrigger = 'unittest' | 'http' | 'none';

interface DebugRequest {
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
  timeoutSeconds: number;
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
  return {
    type,
    name: top,
    locations,
    events,
    trigger: (str('trigger') as DebugTrigger | undefined) ?? 'unittest',
    ...(str('triggerName') ? { triggerName: str('triggerName')?.toUpperCase() } : {}),
    ...(str('url') ? { url: str('url') } : {}),
    variables: [...new Set(variables)],
    steps: typeof args.steps === 'number' ? args.steps : 0,
    stepMode: (str('stepMode') as StepMode | undefined) ?? 'over',
    timeoutSeconds: typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS,
  };
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

async function inspect(
  conn: SapConnection,
  identity: DebugIdentity,
  debuggee: Debuggee,
  req: DebugRequest,
  armed: ArmedBreakpoints,
  onAttached: () => Promise<void>,
  warnings: string[],
  ready: AdtHttpClient | undefined,
): Promise<Inspection> {
  const inspection: Inspection = { attached: false, stops: [], hits: new Map() };
  if (debuggee.attachImpossible) {
    if (ready) await endSession(ready, { deadline: Date.now() + RELEASE_BUDGET_MS });
    return {
      ...inspection,
      error:
        'SAP reports this debuggee cannot be attached (IS_ATTACH_IMPOSSIBLE), e.g. it runs on another application server.',
    };
  }
  const deadline = Date.now() + INSPECTION_BUDGET_MS;
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
    if (attach.postMortem) warnings.push('SAP attached a post-mortem (short dump) session — inspection only.');
    await onAttached();
    await collectStops(
      session,
      req,
      armed.armed,
      {
        reachedBreakpoints: attach.reachedBreakpoints.map((bp) => bp.id).filter(Boolean),
        steppingPossible: attach.steppingPossible,
        single: attach.postMortem,
        unresolvable: attach.reachedBreakpoints.filter((bp) => bp.unresolvableCondition),
      },
      inspection,
      deadline,
      warnings,
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
    // A run that already ended needs no release.
    if (attachState !== 'none' && !inspection.release) {
      const releaser = new DebuggerSession(sessionHttp, identity, {
        deadline: Date.now() + RELEASE_BUDGET_MS,
      });
      inspection.release = await releaser.release(armed.ids);
    }
    // A debuggee that could not be released keeps its debugger session; any other ends here.
    if (attachState === 'none' || inspection.release?.released) {
      await endSession(sessionHttp, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
  }
  return inspection;
}

// ─── Capture ───────────────────────────────────────────────────────

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

async function runCapture(conn: SapConnection, req: DebugRequest, user: string): Promise<ToolResult> {
  const identity = createDebugIdentity(user);
  const warnings: string[] = [];
  // Everything that can fail on input is resolved BEFORE any debugger state exists on SAP.
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
  const plan = await planTrigger(conn, req, cache);

  const conflict = await findListenerConflict(conn.http, identity);
  if (conflict) {
    return errorResult(
      `Another debugger is already listening for SAP user ${user}: ${conflict}. A capture never takes over an active debug session (Eclipse, VS Code or another capture) — stop that session first.`,
    );
  }

  const armedIds: string[] = [];
  let ahead: SessionsAhead = { byServer: new Map() };
  let attachedFrom: AdtHttpClient | undefined;
  let listenerStarted = false;
  let externalCleared = false;
  let tornDown = false;
  let running: RunningTrigger | undefined;
  const listenAbort = new AbortController();
  const clearExternal = async () => {
    if (externalCleared) return;
    externalCleared = true;
    await disarm(conn, identity, armedIds, warnings);
  };
  // Idempotent: runs before the result is built (so its warnings are reported) and again in finally.
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    listenAbort.abort();
    await clearExternal();
    for (const session of ahead.byServer.values()) {
      if (session !== attachedFrom) await endSession(session, { deadline: Date.now() + RELEASE_BUDGET_MS });
    }
    if (!listenerStarted) return;
    try {
      await stopListener(conn.http, identity.user);
    } catch (err) {
      warnings.push(`Could not remove the debugger listener for ${identity.user}: ${debuggerErrorText(err)}.`);
    }
  };
  const settleTrigger = async (): Promise<Record<string, unknown> | undefined> => {
    if (!running) return undefined;
    const settled = await Promise.race([running.settled, sleep(timings.triggerSettleMs).then(() => undefined)]);
    // The trigger's session ends with its run; a run still going keeps it until SAP's session timeout.
    if (settled && ahead.trigger) await endSession(ahead.trigger, { deadline: Date.now() + RELEASE_BUDGET_MS });
    return settled ?? { status: 'running', note: 'still running when the capture returned' };
  };

  try {
    const armed = await armBreakpoints(conn, identity, targets, req.events, armedIds);
    if (armed.ids.length === 0) {
      return errorResult(
        toolJson({ hit: false, error: 'SAP refused every breakpoint — nothing was armed.', breakpoints: armed.report }),
      );
    }

    ahead = await openAhead(conn, plan, warnings);
    listenerStarted = true;
    const listen: Promise<ListenSettled> = listenForDebuggee(conn.http, identity, req.timeoutSeconds, {
      signal: listenAbort.signal,
    }).catch((error: unknown) => ({ status: 'error' as const, error }));

    if (plan.kind !== 'none') {
      await sleep(timings.armDelayMs);
      running = startTrigger(
        conn,
        plan,
        req.timeoutSeconds * 1000 + INSPECTION_BUDGET_MS + RELEASE_BUDGET_MS,
        ahead.trigger,
      );
    }
    const first = await Promise.race([
      listen.then((outcome) => ({ source: 'listener' as const, outcome })),
      ...(running ? [running.settled.then((outcome) => ({ source: 'trigger' as const, outcome }))] : []),
    ]);
    // A suspended run cannot finish: a trigger that settles first ran without stopping — end the poll.
    const triggerFinished = first.source === 'trigger';
    if (triggerFinished) listenAbort.abort();
    const outcome: ListenSettled = first.source === 'listener' ? first.outcome : await listen;
    // Where the capture's own run went (pinned ahead of it): the server the debuggee stops on.
    const triggerServer = running && ahead.trigger ? contextServer(ahead.trigger.sessionContextId) : undefined;
    const base = {
      user,
      breakpoints: armed.report,
      trigger: { kind: plan.kind, target: plan.label, ...(triggerServer ? { server: triggerServer } : {}) },
    };

    if (outcome.status !== 'caught') {
      await teardown();
      const triggerOutcome = await settleTrigger();
      const triggerFailure =
        first.source === 'trigger' && first.outcome.status === 'failed' ? first.outcome : undefined;
      const reason =
        outcome.status === 'conflict'
          ? `conflict: ${outcome.message}`
          : triggerFailure
            ? `trigger failed: ${triggerFailure.error}`
            : triggerFinished
              ? 'trigger finished without reaching the breakpoint'
              : outcome.status === 'error'
                ? `listener failed: ${debuggerErrorText(outcome.error)}`
                : 'timeout';
      return textResult(
        toolJson({
          hit: false,
          reason,
          ...base,
          trigger: { ...base.trigger, ...(triggerOutcome ?? {}) },
          ...(warnings.length > 0 ? { warnings } : {}),
          hint: notHitHint(req, user, triggerFinished, triggerFailure !== undefined),
        }),
      );
    }

    const { debuggee } = outcome;
    attachedFrom = debuggee.instance ? ahead.byServer.get(debuggee.instance.toUpperCase()) : undefined;
    const inspection = await inspect(conn, identity, debuggee, req, armed, clearExternal, warnings, attachedFrom);
    await teardown();
    const triggerOutcome = await settleTrigger();
    if (inspection.release && !inspection.release.released) {
      warnings.push(
        `The debuggee could not be released (${inspection.release.detail ?? 'unknown'}); it stays suspended until SAP's debugger timeout ends its session.`,
      );
    }
    // How often each breakpoint stopped the run (0 = the run never reached it while the capture followed it).
    const breakpoints = armed.report.map((entry) => ({ ...entry }));
    if (inspection.attached) {
      for (const bp of armed.armed) {
        const entry = breakpoints[bp.reportIndex];
        if (entry) entry.hits = inspection.hits.get(bp.id) ?? 0;
      }
    }
    return textResult(
      toolJson({
        hit: true,
        ...base,
        breakpoints,
        debuggee: {
          user: debuggee.user,
          program: debuggee.program,
          ...debuggeePosition(debuggee),
          ...(debuggee.kind ? { kind: debuggee.kind } : {}),
          ...(debuggee.instance ? { server: debuggee.instance } : {}),
        },
        attached: inspection.attached,
        ...(inspection.stops.length > 0 ? { stops: inspection.stops } : {}),
        ...(inspection.release ? { release: inspection.release } : {}),
        ...(inspection.error ? { error: inspection.error } : {}),
        trigger: { ...base.trigger, ...(triggerOutcome ?? {}) },
        // One warning per kind: every stop of a big frame would repeat the same one.
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
      }),
    );
  } finally {
    await teardown();
  }
}

/** The abap_debug tool: one capture per SAP user at a time. */
export async function handleDebugCapture(conn: SapConnection, input: DebugInput): Promise<ToolResult> {
  const user = await resolveDebugUser(conn);
  if (!user) {
    return errorResult(
      "Cannot tell which SAP user this session runs as, and SAP's debugger needs that logon user (requestUser) to catch anything. SAP did not name it (/sap/bc/adt/core/http/systeminformation is missing on SAP_BASIS 7.50 and older); there, set SAP_USER to the logon user (Basic or cookie authentication).",
    );
  }
  // From here to activeCaptures.add() nothing awaits, so the check and the claim are atomic.
  if (activeCaptures.has(user)) {
    return errorResult(
      `A debug capture for SAP user ${user} is already running on this server — wait for it to finish.`,
    );
  }
  activeCaptures.add(user);
  try {
    const type = input.type ? normalizeObjectType(input.type) : '';
    return await runCapture(conn, readRequest(input as Record<string, unknown>, type, input.name ?? ''), user);
  } catch (err) {
    if (err instanceof DebugInputError) return errorResult(err.message);
    throw err;
  } finally {
    activeCaptures.delete(user);
  }
}

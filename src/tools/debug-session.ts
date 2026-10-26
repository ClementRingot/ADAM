/**
 * Interactive debugging. `abap_debug` with `interactive: true` catches the run like a one-shot
 * capture, records its first stop, and keeps the program waiting there; each `abap_debug_session`
 * call then makes one move — step, continue, inspect, end — and answers where the program stands,
 * with the code around it and the watched variables.
 *
 * The attached debugger session lives in this process between calls — the stdio process of one
 * user, or the single instance of an HTTP deployment — so it lasts no longer than the process.
 * The program holds a work process and its caller's request meanwhile, so a session is released
 * after `idleSeconds` without a call, after `sessionSeconds` in all, and when the server stops.
 * One session per MCP user (`ToolContext.owner`; the local user over stdio), and one debugger per
 * SAP user: SAP keys the listener by user, and so does this server. A user reaches only their own
 * session — on SAP BTP several users share the server.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { DebuggerSession, type DebugReleaseResult, type DebugStackFrame, endSession } from '../adt/debugger.js';
import type { AdtHttpClient } from '../adt/http.js';
import { readSource } from '../adt/repository.js';
import { logger } from '../logger.js';
import type { SapConnection, ToolContext } from './connection.js';
import { DebugInputError } from './debug-arm.js';
import {
  breakpointsWithHits,
  budgetContext,
  CaptureRun,
  type Caught,
  captureResult,
  claimDebugUser,
  describeDebuggee,
  inspect,
  readDebugRequest,
  readUntil,
  releaseDebugUser,
  resolveDebugUser,
  UNKNOWN_USER_MESSAGE,
} from './debug-capture.js';
import { type Inspection, RunFollower, type StepRun, type StopRecord } from './debug-follow.js';
import type { DebugInput } from './debug-input.js';
import {
  DEFAULT_LIMITS,
  type DebugLimits,
  MAX_TOTAL_STEPS,
  planCallBudget,
  RELEASE_BUDGET_MS,
} from './debug-limits.js';
import type { DebugSessionInput } from './debug-session-input.js';
import {
  compactValues,
  describeFrame,
  describeStack,
  NOT_VISIBLE,
  readFrameVariables,
  readNamedVariables,
  sourcePosition,
} from './debug-view.js';
import { describeError, errorResult, type ToolResult, textResult, toolJson } from './result.js';

/** Lines shown on each side of the one the program stands on. */
const CODE_CONTEXT = 2;
/** How long `continue` waits for the next stop unless the call says otherwise. */
const DEFAULT_CONTINUE_SECONDS = 60;
/** On shutdown, how long the release may take before the process exits anyway. */
const SHUTDOWN_BUDGET_MS = 15_000;
/** What happens to the program when a budget ends a call: nothing — it waits for the next call. */
const WAITS = 'the program waits where it stands — call step again to go on';

/** Input this module refuses on its own (the session's state, not the schema). */
class SessionInputError extends Error {}

/** The owner of every call over stdio: the one local user. */
const LOCAL_OWNER = 'local';
/** The open session of each MCP user. */
const sessions = new Map<string, InteractiveSession>();
/** Each user's last session that ended, for a call that still names it. */
const lastEnded = new Map<string, { id: string; summary: Record<string, unknown> }>();
let sessionCount = 0;

const ownerOf = (context: ToolContext): string => context.owner ?? LOCAL_OWNER;

/** Upper-cased and deduplicated, as abap_debug reads them. */
function variableNames(names: readonly string[] | undefined): string[] | undefined {
  return names ? [...new Set(names.map((name) => name.trim().toUpperCase()).filter(Boolean))] : undefined;
}

const POSITION_KEYS = new Set(['step', 'procedure', 'program', 'include', 'line', 'uri']);

/** A step entry without what `position` shows anyway. */
function stepExtras(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !POSITION_KEYS.has(key)));
}

class InteractiveSession {
  readonly id: string;
  readonly startedAt = Date.now();
  readonly endsAt: number;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  private lifeTimer: NodeJS.Timeout | undefined;
  private readonly sources = new Map<string, Promise<string[] | undefined>>();
  closed = false;
  stepsTaken = 0;

  constructor(
    /** The MCP user the session belongs to. */
    readonly owner: string,
    private readonly conn: SapConnection,
    private readonly run: CaptureRun,
    private readonly caught: Caught,
    private readonly inspection: Inspection,
    private readonly follower: RunFollower,
    private readonly session: DebuggerSession,
    private readonly sessionHttp: AdtHttpClient,
    private readonly limits: DebugLimits,
    /** Read after every step and at every stop. */
    private variables: string[],
  ) {
    sessionCount += 1;
    this.id = `S${sessionCount}`;
    this.endsAt = this.startedAt + limits.sessionSeconds * 1000;
  }

  get user(): string {
    return this.run.user;
  }

  /** Stop the timers without touching SAP (unit tests). */
  forget(): void {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.lifeTimer);
    releaseDebugUser(this.run.user);
  }

  /** What a second capture or session for the same SAP user is told. */
  get busyMessage(): string {
    return `An interactive debug session (${this.id}) for SAP user ${this.run.user} is open on this server — it must end first: abap_debug_session action="end" from its owner, or it is released after ${this.limits.idleSeconds} s without a call.`;
  }

  /** One call at a time, in order — the idle and lifetime ends queue behind a call in progress. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  armTimers(): void {
    this.lifeTimer = setTimeout(
      () => this.expire(`it reached its limit of ${this.limits.sessionSeconds} s (ABAP_DEBUGGER_SESSION_SECONDS)`),
      Math.max(0, this.endsAt - Date.now()),
    );
    this.lifeTimer.unref();
    this.armIdle();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.expire(`no call came for ${this.limits.idleSeconds} s (ABAP_DEBUGGER_IDLE_SECONDS)`),
      this.limits.idleSeconds * 1000,
    );
    this.idleTimer.unref();
  }

  /** End the session from a timer or a shutdown, once the call in progress (if any) is done. */
  expire(reason: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed) return;
      const summary = await this.close(`the session ended because ${reason}`);
      logger.info(`Debug session ${this.id} ended`, { reason, release: summary.release });
    }).catch((err: unknown) => logger.warn(`Debug session ${this.id} could not end cleanly: ${describeError(err)}`));
  }

  /** How long the session may still run, for every answer. */
  private footer(): Record<string, unknown> {
    return {
      idleTimeoutSeconds: this.limits.idleSeconds,
      endsInSeconds: Math.max(0, Math.round((this.endsAt - Date.now()) / 1000)),
    };
  }

  /** The source lines around `frame`'s position, the current one marked `>`; nothing when SAP does not name it. */
  private async code(frame: DebugStackFrame | undefined): Promise<string[] | undefined> {
    const position = frame?.uri ? sourcePosition(frame.uri) : undefined;
    const path = frame?.uri?.split('#', 1)[0];
    if (!position || !path) return undefined;
    let lines = this.sources.get(path);
    if (!lines) {
      lines = readSource(this.conn.http, path, 'active').then(
        (source) => source.replace(/\r\n/g, '\n').split('\n'),
        () => undefined,
      );
      this.sources.set(path, lines);
    }
    const source = await lines;
    if (!source || position.line > source.length) return undefined;
    const from = Math.max(1, position.line - CODE_CONTEXT);
    const to = Math.min(source.length, position.line + CODE_CONTEXT);
    const width = String(to).length;
    const shown: string[] = [];
    for (let line = from; line <= to; line++) {
      shown.push(`${line === position.line ? '>' : ' '}${String(line).padStart(width)}: ${source[line - 1] ?? ''}`);
    }
    return shown;
  }

  /** Where the program stands now, with the code around it. */
  private async standing(): Promise<Record<string, unknown>> {
    const top = this.follower.stack[0];
    const code = await this.code(top);
    return { ...(top ? { position: describeFrame(top) } : {}), ...(code ? { code } : {}) };
  }

  /** The first answer: the stop the session starts at (and the steps the call asked for). */
  async startResult(first: StopRecord, reached: StopRecord | undefined) {
    const { base, debuggee } = this.caught;
    return {
      hit: true,
      session: this.id,
      ...base,
      breakpoints: breakpointsWithHits(this.caught.armed, this.inspection.hits),
      debuggee: describeDebuggee(debuggee),
      stop: first.stop,
      ...(reached ? { reached: reached.stop } : {}),
      ...(await this.standing()),
      trigger: { ...base.trigger, status: 'waiting', note: 'held at the stop until the session ends' },
      next: 'Drive the program with abap_debug_session: step (stepMode, count, until), continue (to the next breakpoint, or toLine), inspect (variables, stack), end (terminate: true to abort it). End the session when you are done: the program holds a work process until then.',
      ...this.footer(),
      ...(this.run.warnings.length > 0 ? { warnings: [...new Set(this.run.warnings)] } : {}),
    };
  }

  /** One abap_debug_session call. */
  call(input: DebugSessionInput, context: ToolContext): Promise<ToolResult> {
    return this.exclusive(async () => {
      if (this.closed) return errorResult(endedText(this.owner, this.id));
      clearTimeout(this.idleTimer);
      const warnings: string[] = [];
      this.follower.warnings = warnings;
      try {
        const body =
          input.action === 'step'
            ? await this.step(input, context, warnings)
            : input.action === 'continue'
              ? await this.continue(input, context, warnings)
              : input.action === 'inspect'
                ? await this.inspectHere(input, context, warnings)
                : await this.close(
                    input.terminate ? 'the program was terminated on request' : 'the session was ended on request',
                    undefined,
                    input.terminate === true,
                  );
        return textResult(
          toolJson({
            session: this.id,
            action: input.action,
            ...body,
            ...(this.closed ? {} : this.footer()),
            ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof SessionInputError) return errorResult(err.message);
        return errorResult(
          `${describeError(err)} The session ${this.id} stays open: retry, inspect where the program stands, or end it.`,
        );
      } finally {
        if (!this.closed) this.armIdle();
      }
    });
  }

  private async step(input: DebugSessionInput, context: ToolContext, warnings: string[]) {
    if (!this.follower.steppingPossible) {
      throw new SessionInputError(
        'SAP reports stepping is not possible where the program stands (a post-mortem session, or a position the debugger cannot step from): inspect it, continue, or end the session.',
      );
    }
    this.variables = variableNames(input.variables) ?? this.variables;
    const until = readUntil(input.until);
    const count = input.count ?? (until ? MAX_TOTAL_STEPS : 1);
    const budget = planCallBudget(this.limits, input, warnings, budgetContext(context));
    this.session.retime(budget.deadline);
    const run = await this.follower.steps(
      { count, mode: input.stepMode ?? 'over', ...(until ? { until } : {}), variables: this.variables },
      { stack: this.follower.stack, refused: new Map(), stop: this.inspection.stops.length },
      budget,
    );
    this.stepsTaken += run.count;
    const out: Record<string, unknown> = {};
    const [only] = run.steps ?? [];
    if (count === 1 && only && run.steps?.length === 1) Object.assign(out, stepExtras(only));
    else if (run.steps && run.steps.length > 0) out.steps = run.steps;
    else if (run.trace) out.trace = run.trace;
    if (run.ended)
      return { ...out, ...(await this.close('the program ran to its end', { released: true, via: 'continue' })) };
    if (run.reached) {
      // A step ran into a breakpoint: that is a stop of it, with its hit.
      this.follower.standAt(run.reached, run.steppingPossible);
      out.stop = (await this.follower.recordStop(this.variables, true, budget.result)).stop;
    } else if (count > 1 && run.values) {
      Object.assign(out, compactValues(run.values, new Map()));
    }
    return { ...out, ...(await this.standing()) };
  }

  private async continue(input: DebugSessionInput, context: ToolContext, warnings: string[]) {
    this.variables = variableNames(input.variables) ?? this.variables;
    const budget = planCallBudget(
      this.limits,
      { ...(input.maxResultKB ? { maxResultKB: input.maxResultKB } : {}) },
      warnings,
      budgetContext(context),
    );
    // Waiting for the next stop has its own bound; the reads there take the call's budget.
    this.session.retime(Date.now() + (input.timeoutSeconds ?? DEFAULT_CONTINUE_SECONDS) * 1000);
    let outcome: 'ended' | 'atBreakpoint' | 'atLine';
    if (input.toLine !== undefined) {
      const path = this.follower.stack[0]?.uri?.split('#', 1)[0];
      if (!path) {
        throw new SessionInputError(
          'toLine needs the source the program stands in, and SAP did not name it here: continue to a breakpoint instead.',
        );
      }
      outcome = await this.follower.runToLine(`${path}#start=${input.toLine}`);
    } else {
      outcome = (await this.follower.continueRun()) === 'ended' ? 'ended' : 'atBreakpoint';
    }
    if (outcome === 'ended') {
      return this.close(
        input.toLine !== undefined
          ? `the program ran to its end without reaching line ${input.toLine}`
          : 'the program ran to its end without another stop',
        { released: true, via: 'continue' },
      );
    }
    this.session.retime(budget.deadline);
    if (outcome === 'atBreakpoint') {
      const record = await this.follower.recordStop(this.variables, true, budget.result);
      return { stop: record.stop, ...(await this.standing()) };
    }
    // Stopped on the line: the watched variables, as after a step.
    const read = this.variables.length > 0 ? await readNamedVariables(this.session, this.variables) : [];
    return { ...compactValues(read, new Map()), ...(await this.standing()) };
  }

  private async inspectHere(input: DebugSessionInput, context: ToolContext, warnings: string[]) {
    const budget = planCallBudget(
      this.limits,
      { ...(input.maxResultKB ? { maxResultKB: input.maxResultKB } : {}) },
      warnings,
      budgetContext(context),
    );
    this.session.retime(budget.deadline);
    const names = variableNames(input.variables);
    const variables =
      names && names.length > 0
        ? await readNamedVariables(this.session, names)
        : await readFrameVariables(this.session, warnings);
    if (input.stack) this.follower.stack = await this.session.stack();
    const notVisible = variables.filter((variable) => variable.error === NOT_VISIBLE).map((variable) => variable.name);
    return {
      variables: variables.filter((variable) => variable.error !== NOT_VISIBLE),
      ...(notVisible.length > 0 ? { notVisible } : {}),
      ...(input.stack ? describeStack(this.follower.stack) : {}),
      ...(await this.standing()),
    };
  }

  /**
   * End the session: release the program (or abort it on `terminate`), end the debugger session,
   * wait a little for the trigger's own answer, and free the SAP user. `release` given: the program
   * already ended.
   */
  async close(reason: string, release?: DebugReleaseResult, terminate = false): Promise<Record<string, unknown>> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.lifeTimer);
    if (sessions.get(this.owner) === this) sessions.delete(this.owner);
    let outcome = release;
    if (!outcome) {
      const releaser = new DebuggerSession(this.sessionHttp, this.run.identity, {
        deadline: Date.now() + RELEASE_BUDGET_MS,
      });
      if (terminate) {
        try {
          await releaser.step('terminateDebuggee');
          outcome = { released: true, via: 'terminate' };
        } catch {
          outcome = await releaser.release(this.run.armedIds);
        }
      } else {
        outcome = await releaser.release(this.run.armedIds);
      }
    }
    // A program that could not be released keeps its debugger session; any other ends here.
    if (outcome.released) await endSession(this.sessionHttp, { deadline: Date.now() + RELEASE_BUDGET_MS });
    const trigger = await this.run.settleTrigger();
    releaseDebugUser(this.run.user);
    const summary: Record<string, unknown> = {
      ended: true,
      reason,
      release: outcome,
      ...(outcome.released
        ? {}
        : {
            warning: `The program could not be released (${outcome.detail ?? 'unknown'}); it stays suspended until SAP's debugger timeout ends its session.`,
          }),
      breakpoints: breakpointsWithHits(this.caught.armed, this.inspection.hits),
      stops: this.inspection.stops.length,
      steps: this.stepsTaken,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      trigger: { ...this.caught.base.trigger, ...(trigger ?? {}) },
    };
    lastEnded.set(this.owner, { id: this.id, summary });
    return summary;
  }
}

function endedText(owner: string, id: string): string {
  const ended = lastEnded.get(owner);
  const summary = ended?.id === id ? ` ${toolJson(ended.summary)}` : '';
  return `Debug session ${id} has ended; start a new one with abap_debug and interactive: true.${summary}`;
}

/** Which session a call names, or why there is none — about the caller's own sessions only. */
function noSessionText(owner: string, wanted: string | undefined): string {
  const open = sessions.get(owner);
  if (open) return `There is no debug session ${wanted}: your open one is ${open.id}.`;
  const ended = lastEnded.get(owner);
  if (ended && (!wanted || wanted === ended.id)) return endedText(owner, ended.id);
  return 'No interactive debug session is open. Start one with abap_debug and interactive: true.';
}

/** abap_debug with interactive: true — catch the run, record its first stop, and keep it waiting there. */
export async function startDebugSession(
  conn: SapConnection,
  input: DebugInput,
  context: ToolContext = {},
): Promise<ToolResult> {
  const owner = ownerOf(context);
  const own = sessions.get(owner);
  if (own) {
    return errorResult(
      `Your interactive debug session ${own.id} is still open: end it with abap_debug_session action="end" before starting another.`,
    );
  }
  const user = await resolveDebugUser(conn);
  if (!user) return errorResult(UNKNOWN_USER_MESSAGE);
  const busy = claimDebugUser(
    user,
    `A debug capture for SAP user ${user} is already running on this server — wait for it to finish.`,
  );
  if (busy) return errorResult(busy);
  let handedOver = false;
  try {
    const req = readDebugRequest(input);
    const limits = conn.limits ?? DEFAULT_LIMITS;
    const run = new CaptureRun(conn, req, user);
    const budget = planCallBudget(limits, req, run.warnings, budgetContext(context));
    try {
      // The trigger's request waits for as long as the session may hold the program.
      const caught = await run.catchDebuggee(
        context,
        req.timeoutSeconds * 1000 + limits.sessionSeconds * 1000 + RELEASE_BUDGET_MS,
      );
      if ('result' in caught) return caught.result;
      budget.deadline = Date.now() + budget.seconds * 1000;
      let follower: RunFollower | undefined;
      let first: StopRecord | undefined;
      let steps: StepRun | undefined;
      let reached: StopRecord | undefined;
      let parked = false;
      const attachment = await inspect(
        run,
        caught.debuggee,
        budget,
        async (session, firstStop, inspection) => {
          follower = new RunFollower(session, caught.armed.armed, firstStop, inspection, run.warnings, WAITS);
          first = await follower.recordStop(req.variables, true, budget.result);
          if (req.steps > 0 && follower.steppingPossible) {
            const refused = new Map(
              first.variables.flatMap((variable) =>
                variable.error && variable.error !== NOT_VISIBLE ? [[variable.name, variable.error] as const] : [],
              ),
            );
            steps = await follower.steps(
              {
                count: req.steps,
                mode: req.stepMode,
                ...(req.until ? { until: req.until } : {}),
                variables: req.variables,
              },
              { stack: first.stack, refused, stop: 1 },
              budget,
            );
            // On the stop, as a one-shot capture records them.
            if (steps.steps && steps.steps.length > 0) first.stop.steps = steps.steps;
            if (steps.trace) first.stop.trace = steps.trace;
            if (steps.ended) {
              inspection.release = { released: true, via: 'continue' };
              return;
            }
            if (steps.reached) {
              follower.standAt(steps.reached, steps.steppingPossible);
              reached = await follower.recordStop(req.variables, true, budget.result);
            }
          }
          parked = true;
        },
        () => parked,
      );
      if (!attachment.session || !attachment.sessionHttp || !follower || !first) {
        // Nothing to hold: the program ended or the attach failed — answered like a one-shot capture.
        return await captureResult(run, caught, attachment);
      }
      // The listener, the external breakpoints and the unused sessions go; the attached session stays.
      await run.teardown();
      const session = new InteractiveSession(
        owner,
        conn,
        run,
        caught,
        attachment,
        follower,
        attachment.session,
        attachment.sessionHttp,
        limits,
        req.variables,
      );
      session.stepsTaken = steps?.count ?? 0;
      // Hand the SAP user over to the session: nothing awaits between the two, so no capture slips in.
      releaseDebugUser(user);
      claimDebugUser(user, session.busyMessage);
      sessions.set(owner, session);
      handedOver = true;
      session.armTimers();
      return textResult(toolJson(await session.startResult(first, reached)));
    } finally {
      if (!handedOver) await run.teardown();
    }
  } catch (err) {
    if (err instanceof DebugInputError) return errorResult(err.message);
    throw err;
  } finally {
    if (!handedOver) releaseDebugUser(user);
  }
}

/** abap_debug_session: one move of the open session. */
export async function handleDebugSession(
  _conn: SapConnection,
  input: DebugSessionInput,
  context: ToolContext = {},
): Promise<ToolResult> {
  const owner = ownerOf(context);
  const wanted = input.session?.trim().toUpperCase();
  const session = sessions.get(owner);
  if (!session || (wanted && wanted !== session.id)) return errorResult(noSessionText(owner, wanted));
  return session.call(input, context);
}

/** Release every open session (server shutdown), within a bounded time. */
export async function endDebugSessions(reason: string, budgetMs = SHUTDOWN_BUDGET_MS): Promise<void> {
  if (sessions.size === 0) return;
  await Promise.race([Promise.all([...sessions.values()].map((session) => session.expire(reason))), sleep(budgetMs)]);
}

/** Forget every session without touching SAP — between unit tests. */
export function forgetDebugSessionsForTests(): void {
  for (const session of sessions.values()) session.forget();
  sessions.clear();
  lastEnded.clear();
  sessionCount = 0;
}

/** The id of a user's open session, for tests. */
export function openDebugSessionId(owner = LOCAL_OWNER): string | undefined {
  return sessions.get(owner)?.id;
}

/**
 * Interactive debugging. `abap_debug` with `interactive: true` catches the run like a one-shot
 * capture, records its first stop, and keeps the program waiting there; each `abap_debug_session`
 * call then makes one move — step, continue, inspect, end — and answers where the program stands,
 * with the code around it and the watched variables. A move that outlasts its call (a continue
 * waiting for the next stop, a long step run) goes on in the background, and action "wait" picks
 * up its answer — as for a one-shot capture (src/tools/debug-background.ts).
 *
 * The attached debugger session lives in this process between calls (src/tools/debug-registry.ts),
 * so it lasts no longer than the process. The program holds a work process and its caller's
 * request meanwhile, so a session is released after `idleSeconds` without a call, after
 * `sessionSeconds` in all, and when the server stops. One capture or session per MCP user
 * (`ToolContext.owner`; the local user over stdio), and one per SAP user: SAP keys the listener by
 * user, and so does this server. A user reaches only their own session — on SAP BTP several users
 * share the server.
 */

import { DebuggerSession, type DebugReleaseResult, type DebugStackFrame, endSession } from '../adt/debugger.js';
import type { AdtHttpClient } from '../adt/http.js';
import { readSource } from '../adt/repository.js';
import { logger } from '../logger.js';
import type { SapConnection, ToolContext } from './connection.js';
import { DebugInputError } from './debug-arm.js';
import { BackgroundWork, stillRunning } from './debug-background.js';
import {
  answerWhenDone,
  breakpointsWithHits,
  budgetContext,
  CaptureRun,
  type Caught,
  captureResult,
  type DebugRequest,
  describeDebuggee,
  inspect,
  readDebugRequest,
  readUntil,
  refuseStart,
  resolveDebugUser,
  UNKNOWN_USER_MESSAGE,
} from './debug-capture.js';
import { type Inspection, RunFollower, type StepRun, type StopRecord } from './debug-follow.js';
import type { DebugInput } from './debug-input.js';
import {
  callDeadline,
  DEFAULT_LIMITS,
  type DebugLimits,
  MAX_TOTAL_STEPS,
  planCallBudget,
  RELEASE_BUDGET_MS,
} from './debug-limits.js';
import { type DebugEntry, entryOf, LOCAL_OWNER, nextDebugId, ownerOf, setEntry } from './debug-registry.js';
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
/** Setting a watchpoint: two short requests. */
const WATCH_BUDGET_MS = 30_000;
/** What happens to the program when a budget ends a call: nothing — it waits for the next call. */
const WAITS = 'the program waits where it stands — call step again to go on';

const NO_SESSION = 'No interactive debug session is open. Start one with abap_debug and interactive: true.';

/** Input this module refuses on its own (the session's state, not the schema). */
class SessionInputError extends Error {}

/** Upper-cased and deduplicated, as abap_debug reads them. */
function variableNames(names: readonly string[] | undefined): string[] | undefined {
  return names ? [...new Set(names.map((name) => name.trim().toUpperCase()).filter(Boolean))] : undefined;
}

const POSITION_KEYS = new Set(['step', 'procedure', 'program', 'include', 'line', 'uri']);

/** A step entry without what `position` shows anyway. */
function stepExtras(entry: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !POSITION_KEYS.has(key)));
}

/** What a move does, until its progress says more. */
function moveDoing(input: DebugSessionInput): string {
  if (input.action === 'step') return 'stepping';
  if (input.action === 'continue') {
    return input.toLine !== undefined ? `running to line ${input.toLine}` : 'running to the next stop';
  }
  if (input.action === 'watch') return `setting a watchpoint on ${input.variable?.toUpperCase()}`;
  return 'reading where the program stands';
}

class InteractiveSession implements DebugEntry {
  readonly kind = 'session';
  readonly startedAt = Date.now();
  readonly endsAt: number;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | undefined;
  private lifeTimer: NodeJS.Timeout | undefined;
  private readonly sources = new Map<string, Promise<string[] | undefined>>();
  /** The move in progress — or the last one, until a call has received its answer. */
  private pending: BackgroundWork | undefined;
  /** It takes no further move: it ends, or has ended. */
  closed = false;
  /** Set once the program is released and the SAP user free: what later calls are told. */
  private summary: Record<string, unknown> | undefined;
  stepsTaken = 0;

  constructor(
    readonly id: string,
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
    /** The start: its answer (the first stop) may still wait for a call. */
    start: BackgroundWork,
  ) {
    this.endsAt = this.startedAt + limits.sessionSeconds * 1000;
    this.pending = start;
  }

  get user(): string {
    return this.run.user;
  }

  /** It holds the program, or still releases it. */
  get active(): boolean {
    return this.summary === undefined;
  }

  describe(): Record<string, unknown> {
    const top = this.follower.stack[0];
    return {
      session: this.id,
      kind: 'interactive session',
      user: this.user,
      state: this.summary ? 'ended' : this.closed ? 'ending' : this.pending?.active ? 'running' : 'waiting',
      ...(top && !this.closed ? { position: describeFrame(top) } : {}),
      breakpoints: breakpointsWithHits(this.caught.armed, this.inspection.hits),
      stops: this.inspection.stops.length,
      steps: this.stepsTaken,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      ...(this.closed ? {} : this.footer()),
    };
  }

  /** One call at a time, in order — the end queues behind the move it stopped. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  armTimers(): void {
    this.lifeTimer = setTimeout(
      () => void this.expire(`it reached its limit of ${this.limits.sessionSeconds} s (ABAP_DEBUGGER_SESSION_SECONDS)`),
      Math.max(0, this.endsAt - Date.now()),
    );
    this.lifeTimer.unref();
    this.armIdle();
  }

  /** The idle time starts over: after each call, and once a move that outlasted its call is done. */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => void this.expire(`no call came for ${this.limits.idleSeconds} s (ABAP_DEBUGGER_IDLE_SECONDS)`),
      this.limits.idleSeconds * 1000,
    );
    this.idleTimer.unref();
  }

  /** End the session without a call — a timer, or the server stopping — once it has ended. */
  async expire(reason: string): Promise<void> {
    if (this.closed) {
      await this.pending?.done;
      return;
    }
    const result = await this.ending(`the session ended because ${reason}`).done;
    if (result.isError) logger.warn(`Debug session ${this.id} could not end cleanly: ${result.content[0]?.text}`);
    else logger.info(`Debug session ${this.id} ended`, { reason });
  }

  stop(reason: string): Promise<void> {
    return this.expire(reason);
  }

  /**
   * Take no further move, stop the one in progress, and release the program once it has stopped —
   * in the background, as a move: `wait` picks up the summary.
   */
  private ending(reason: string, terminate = false, requested = false): BackgroundWork {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.lifeTimer);
    this.pending?.cancel();
    const work = new BackgroundWork(this.id, this.owner, 'session', this.user, 'releasing the program', () =>
      this.exclusive(async () => {
        const summary = await this.close(reason, undefined, terminate);
        return textResult(toolJson({ session: this.id, ...(requested ? { action: 'end' } : {}), ...summary }));
      }),
    );
    this.pending = work;
    return work;
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
      ...(this.inspection.watchpoints ? { watchpoints: this.inspection.watchpoints } : {}),
      debuggee: describeDebuggee(debuggee),
      stop: first.stop,
      ...(reached ? { reached: reached.stop } : {}),
      ...(await this.standing()),
      trigger: { ...base.trigger, status: 'waiting', note: 'held at the stop until the session ends' },
      next: 'Drive the program with abap_debug_session: step (stepMode, count, until), continue (to the next breakpoint or watchpoint, or toLine), inspect (variables, stack), watch (a variable: continue then stops where it changes), end (terminate: true to abort it). A move that outlasts the call goes on in the background: wait picks up its answer. End the session when you are done: the program holds a work process until then.',
      ...this.footer(),
      ...(this.run.warnings.length > 0 ? { warnings: [...new Set(this.run.warnings)] } : {}),
    };
  }

  /** One abap_debug_session call. */
  async call(input: DebugSessionInput, context: ToolContext): Promise<ToolResult> {
    try {
      if (input.action === 'wait') return await this.wait(context);
      if (input.action === 'end') {
        if (!this.closed) {
          const reason = input.terminate ? 'the program was terminated on request' : 'the session was ended on request';
          return await this.answer(this.ending(reason, input.terminate === true, true), context);
        }
        return this.pending && !this.pending.delivered
          ? await this.answer(this.pending, context)
          : errorResult(this.endedText());
      }
      if (this.closed) return errorResult(this.endedText());
      const busy = this.busyText();
      if (busy) return errorResult(busy);
      clearTimeout(this.idleTimer);
      const move = new BackgroundWork(this.id, this.owner, 'session', this.user, moveDoing(input), (moveContext) =>
        this.exclusive(() => this.perform(input, moveContext)),
      );
      this.pending = move;
      return await this.answer(move, context);
    } finally {
      // A move still running starts the idle time over once it is done.
      if (!this.closed && !this.pending?.active) this.armIdle();
    }
  }

  /** The call waits for `work` up to its budget; past it, the work goes on and the call says so. */
  private async answer(work: BackgroundWork, context: ToolContext): Promise<ToolResult> {
    return (await work.waitFor(context, callDeadline(this.limits))) ?? stillRunning(work, this.limits);
  }

  /** Why no move can start now: the last one still runs, or its answer waits for a call. */
  private busyText(): string | undefined {
    const pending = this.pending;
    if (!pending || pending.delivered) return undefined;
    return pending.active
      ? `Session ${this.id} is still busy (${pending.doing}): action "wait" waits for the answer, action "end" ends the session.`
      : `The last move of session ${this.id} finished while no call waited: action "wait" gives its answer first.`;
  }

  /** `wait`: the answer of the move in progress (or of the last one, not yet received); else where the program stands. */
  private async wait(context: ToolContext): Promise<ToolResult> {
    const pending = this.pending;
    if (pending && !pending.delivered) return this.answer(pending, context);
    if (this.closed) return errorResult(this.endedText());
    return textResult(
      toolJson({
        session: this.id,
        action: 'wait',
        running: false,
        note: 'Nothing runs: the program waits where it stands for your next move.',
        ...(await this.standing()),
        ...this.footer(),
      }),
    );
  }

  private endedText(): string {
    if (!this.summary) {
      return `Debug session ${this.id} is ending: it releases the program — action "wait" gives its answer.`;
    }
    return `Debug session ${this.id} has ended; start a new one with abap_debug and interactive: true. ${toolJson(this.summary)}`;
  }

  /** One move, in the background: step, continue, inspect or watch. */
  private async perform(input: DebugSessionInput, context: ToolContext): Promise<ToolResult> {
    if (this.closed) return errorResult(this.endedText());
    clearTimeout(this.idleTimer);
    const warnings: string[] = [];
    this.follower.warnings = warnings;
    try {
      const body =
        input.action === 'step'
          ? await this.step(input, context, warnings)
          : input.action === 'continue'
            ? await this.continue(input, context, warnings)
            : input.action === 'watch'
              ? await this.watchHere(input, context)
              : await this.inspectHere(input, context, warnings);
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
      if (context.signal?.aborted) {
        return errorResult(
          `The ${input.action} was cancelled before SAP answered, so where the program stands now is unknown: inspect it (stack: true), or end the session ${this.id}.`,
        );
      }
      return errorResult(
        `${describeError(err)} The session ${this.id} stays open: retry, inspect where the program stands, or end it.`,
      );
    } finally {
      if (!this.closed) this.armIdle();
    }
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
    this.session.retime(budget.deadline, context.signal);
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
    this.session.retime(Date.now() + (input.timeoutSeconds ?? DEFAULT_CONTINUE_SECONDS) * 1000, context.signal);
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
    this.session.retime(budget.deadline, context.signal);
    if (outcome === 'atBreakpoint') {
      const record = await this.follower.recordStop(this.variables, true, budget.result);
      return { stop: record.stop, ...(await this.standing()) };
    }
    // Stopped on the line: the watched variables, as after a step.
    const read = this.variables.length > 0 ? await readNamedVariables(this.session, this.variables) : [];
    return { ...compactValues(read, new Map()), ...(await this.standing()) };
  }

  /** A watchpoint where the program stands: `continue` then also stops where its variable changes. */
  private async watchHere(input: DebugSessionInput, context: ToolContext) {
    const variable = input.variable?.trim().toUpperCase() ?? '';
    const condition = input.condition?.trim();
    this.session.retime(Date.now() + WATCH_BUDGET_MS, context.signal);
    const [watchpoint] = await this.follower.watch([
      { variable, ...(condition ? { condition } : {}), hits: input.hits ?? 1 },
    ]);
    return { watchpoint, ...(await this.standing()) };
  }

  private async inspectHere(input: DebugSessionInput, context: ToolContext, warnings: string[]) {
    const budget = planCallBudget(
      this.limits,
      { ...(input.maxResultKB ? { maxResultKB: input.maxResultKB } : {}) },
      warnings,
      budgetContext(context),
    );
    this.session.retime(budget.deadline, context.signal);
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
    let summary: Record<string, unknown> = { ended: true, reason };
    try {
      let outcome = release;
      if (!outcome) {
        const releaser = new DebuggerSession(this.sessionHttp, this.run.identity, {
          deadline: Date.now() + RELEASE_BUDGET_MS,
        });
        const watchpoints = this.inspection.watchpointIds ?? [];
        if (terminate) {
          try {
            await releaser.step('terminateDebuggee');
            outcome = { released: true, via: 'terminate' };
          } catch {
            outcome = await releaser.release(this.run.armedIds, watchpoints);
          }
        } else {
          outcome = await releaser.release(this.run.armedIds, watchpoints);
        }
      }
      // A program that could not be released keeps its debugger session; any other ends here.
      if (outcome.released) await endSession(this.sessionHttp, { deadline: Date.now() + RELEASE_BUDGET_MS });
      const trigger = await this.run.settleTrigger();
      summary = {
        ended: true,
        reason,
        release: outcome,
        ...(outcome.released
          ? {}
          : {
              warning: `The program could not be released (${outcome.detail ?? 'unknown'}); it stays suspended until SAP's debugger timeout ends its session.`,
            }),
        breakpoints: breakpointsWithHits(this.caught.armed, this.inspection.hits),
        ...(this.inspection.watchpoints ? { watchpoints: this.inspection.watchpoints } : {}),
        stops: this.inspection.stops.length,
        steps: this.stepsTaken,
        seconds: Math.round((Date.now() - this.startedAt) / 1000),
        trigger: { ...this.caught.base.trigger, ...(trigger ?? {}) },
      };
      return summary;
    } finally {
      // The SAP user is free from here on, whatever happened above.
      this.summary = summary;
    }
  }
}

/**
 * The start of a session, in the background: catch the run, record its first stop (and the steps
 * the call asked for), and hand the program over to an interactive session — or answer like a
 * one-shot capture when there is nothing to hold.
 */
async function holdFirstStop(
  conn: SapConnection,
  req: DebugRequest,
  user: string,
  limits: DebugLimits,
  context: ToolContext,
  start: BackgroundWork,
): Promise<ToolResult> {
  const run = new CaptureRun(conn, req, user);
  let held = false;
  try {
    const budget = planCallBudget(limits, req, run.warnings, budgetContext(context));
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
        // As in a one-shot capture: the watchpoints go into the run where it stands after its first stop.
        if (req.watch.length > 0 && follower.following) await follower.watch(req.watch);
        // A start ended meanwhile (action "end") releases the program instead of holding it.
        parked = !context.signal?.aborted;
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
      start.id,
      start.owner,
      conn,
      run,
      caught,
      attachment,
      follower,
      attachment.session,
      attachment.sessionHttp,
      limits,
      req.variables,
      start,
    );
    session.stepsTaken = steps?.count ?? 0;
    held = true;
    if (context.signal?.aborted) {
      return textResult(
        toolJson({ hit: true, session: start.id, ...(await session.close('the session was ended on request')) }),
      );
    }
    // The SAP user passes from the start to the session: nothing awaits in between.
    setEntry(session);
    session.armTimers();
    return textResult(toolJson(await session.startResult(first, reached)));
  } catch (err) {
    if (err instanceof DebugInputError) return errorResult(err.message);
    throw err;
  } finally {
    if (!held) await run.teardown();
  }
}

/** abap_debug with interactive: true — catch the run, record its first stop, and keep it waiting there. */
export async function startDebugSession(
  conn: SapConnection,
  input: DebugInput,
  context: ToolContext = {},
): Promise<ToolResult> {
  const owner = ownerOf(context);
  const limits = conn.limits ?? DEFAULT_LIMITS;
  const user = await resolveDebugUser(conn);
  if (!user) return errorResult(UNKNOWN_USER_MESSAGE);
  const refused = refuseStart(owner, user, 'session', limits);
  if (refused) return errorResult(refused);
  const req = readDebugRequest(input);
  const start = new BackgroundWork(nextDebugId(), owner, 'session', user, 'arming the breakpoints', (ctx, self) =>
    holdFirstStop(conn, req, user, limits, ctx, self),
  );
  setEntry(start);
  return answerWhenDone(start, context, limits);
}

/** A call on a capture, or on a session still starting: wait for its answer, or stop it. */
function driveWork(
  work: BackgroundWork,
  input: DebugSessionInput,
  context: ToolContext,
  limits: DebugLimits,
): Promise<ToolResult> | ToolResult {
  if (input.action === 'end') work.cancel();
  if (input.action === 'wait' || input.action === 'end') return answerWhenDone(work, context, limits);
  if (work.kind === 'capture') {
    return errorResult(
      `${work.id} is a one-shot capture: it follows its run on its own and answers once — action "wait" gives that answer, action "end" stops it. step, continue and inspect drive an interactive session (abap_debug with interactive: true).`,
    );
  }
  return errorResult(
    work.active
      ? `Session ${work.id} is still starting (${work.doing}): action "wait" gives its first stop, action "end" stops it.`
      : `Session ${work.id} holds no program: action "wait" gives its answer.`,
  );
}

/** abap_debug_session: one move of the open session, or a wait for what runs in the background. */
export async function handleDebugSession(
  conn: SapConnection,
  input: DebugSessionInput,
  context: ToolContext = {},
): Promise<ToolResult> {
  const owner = ownerOf(context);
  const wanted = input.session?.trim().toUpperCase();
  const entry = entryOf(owner);
  if (!entry) {
    return errorResult(
      input.action === 'wait'
        ? 'Nothing of yours runs: no debug capture, no session. Start one with abap_debug.'
        : NO_SESSION,
    );
  }
  if (wanted && wanted !== entry.id) return errorResult(`There is no debug session ${wanted}: yours is ${entry.id}.`);
  if (entry instanceof InteractiveSession) return entry.call(input, context);
  if (entry instanceof BackgroundWork) return driveWork(entry, input, context, conn.limits ?? DEFAULT_LIMITS);
  return errorResult(NO_SESSION);
}

/** The id of a user's open session, for tests. */
export function openDebugSessionId(owner = LOCAL_OWNER): string | undefined {
  const entry = entryOf(owner);
  return entry instanceof InteractiveSession && !entry.closed ? entry.id : undefined;
}

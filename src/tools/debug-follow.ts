/**
 * Following ONE attached run: record each stop, step from it, retire breakpoints that made their
 * hits, and continue to the next stop until the run ends or a bound is reached. `RunFollower` holds
 * the run's state; the one-shot capture drives it to the end in one call (`collectStops`), an
 * interactive session one operation per call.
 */

import {
  type DebuggerSession,
  type DebugReleaseResult,
  type DebugStackFrame,
  type DebugStepMethod,
  debuggerErrorText,
  type ReachedBreakpoint,
} from '../adt/debugger.js';
import type { ArmedBreakpoint } from './debug-arm.js';
import {
  type CallBudget,
  DETAILED_STEPS,
  MAX_STOPS,
  MAX_TOTAL_STEPS,
  type ResultBudget,
  timings,
} from './debug-limits.js';
import { StepTrace, type StepValues } from './debug-trace.js';
import {
  type CapturedVariable,
  compactValues,
  describeFrame,
  describeStack,
  FRAME_MOVE_WARNING,
  type FrameMove,
  frameMove,
  NOT_VISIBLE,
  readFrameVariables,
  readNamedVariables,
  sourcePosition,
  stepValue,
} from './debug-view.js';

export type StepMode = 'over' | 'into' | 'out';

/** Stop stepping early: on a line, or once a variable changed. */
export interface StepUntil {
  /** The run stands on this line of the source the steps started in. */
  line?: number;
  /** This variable's value differs from its value where the steps started. */
  changed?: string;
}

/** What following a run takes from the request. */
export interface FollowPlan {
  variables: readonly string[];
  /** Steps after each stop. */
  steps: number;
  stepMode: StepMode;
  until?: StepUntil;
}

/** One run of steps from where the run stands. */
export interface StepPlan {
  count: number;
  mode: StepMode;
  until?: StepUntil;
  /** Read after each step. */
  variables: readonly string[];
}

export const STEP_METHODS: Record<StepMode, DebugStepMethod> = {
  over: 'stepOver',
  into: 'stepInto',
  out: 'stepReturn',
};

/** The armed breakpoint SAP names in `reached`, else the line breakpoint at the top frame's position. */
function armedAt(
  armed: readonly ArmedBreakpoint[],
  reached: readonly string[],
  top: DebugStackFrame | undefined,
): ArmedBreakpoint | undefined {
  for (const id of reached) {
    const named = armed.find((bp) => bp.id === id);
    if (named) return named;
  }
  const position = top?.uri ? sourcePosition(top.uri) : undefined;
  return position
    ? armed.find((bp) => bp.kind === 'line' && bp.uri === position.uri && bp.line === position.line)
    : undefined;
}

/**
 * The breakpoint a stop belongs to: `armedAt`, else the only one armed. Undefined = unknown (a
 * `BREAK-POINT` statement, or SAP said nothing usable).
 */
function breakpointAt(
  armed: readonly ArmedBreakpoint[],
  reached: readonly string[],
  top: DebugStackFrame | undefined,
): ArmedBreakpoint | undefined {
  return armedAt(armed, reached, top) ?? (armed.length === 1 ? armed[0] : undefined);
}

export interface Inspection {
  attached: boolean;
  stops: Array<Record<string, unknown>>;
  /** Stops per armed breakpoint id. */
  hits: Map<string, number>;
  release?: DebugReleaseResult;
  error?: string;
}

export interface StepRun {
  /** One entry per step (at most DETAILED_STEPS asked for) … */
  steps?: Array<Record<string, unknown>>;
  /** … else the compact trace. */
  trace?: Record<string, unknown>;
  /** Steps taken. */
  count: number;
  /** The program finished during the steps. */
  ended: boolean;
  steppingPossible: boolean;
  /** A step ran into an armed breakpoint: the run stands at it (`stack`), and the next stop records it. */
  reached?: { id: string; stack: DebugStackFrame[]; unresolvable: ReachedBreakpoint[] };
  /** A budget ran out or the call was cancelled: the steps stopped early. */
  outOfBudget?: true;
  /** The `until` condition that ended the steps. */
  untilMet?: string;
  /** The watched values after the last step, when they were read. */
  values?: CapturedVariable[];
}

/** A stop as recorded: its result entry, the breakpoint it belongs to, what was read there. */
export interface StopRecord {
  stop: Record<string, unknown>;
  at?: ArmedBreakpoint;
  stack: DebugStackFrame[];
  variables: CapturedVariable[];
}

/** Where the run was attached: what SAP said about the first stop. */
export interface FirstStop {
  reachedBreakpoints: string[];
  steppingPossible: boolean;
  /** A post-mortem (short dump) session: inspection only, nothing to follow. */
  single: boolean;
  /** Reached breakpoints whose condition SAP could not evaluate. */
  unresolvable: ReachedBreakpoint[];
}

interface UntilCheck {
  line?: number;
  /** The source the line belongs to (lower-cased path), when the start frame names it. */
  path?: string;
  changed?: { name: string; initial: string };
}

/** The state of one attached run, from stop to stop and step to step. */
export class RunFollower {
  private readonly remaining: Set<string>;
  /** Per breakpoint, its values at its previous stop: a later stop says `unchanged` against them. */
  private readonly lastValues = new Map<string, Map<string, string>>();
  private reachedBreakpoints: string[];
  private unresolvable: ReachedBreakpoint[];
  /** The stack a step already read where it ran into a breakpoint: the next stop's. */
  private reachedStack: DebugStackFrame[] | undefined;
  steppingPossible: boolean;
  /** Where the run stands: the stack read at the last stop or step. */
  stack: DebugStackFrame[] = [];
  /** False for a post-mortem session, or once a breakpoint could not be retired. */
  following: boolean;
  /** The program finished. */
  ended = false;

  /**
   * `afterHalt`: what happens to the run when a budget ends a call — the one-shot capture lets it go
   * on, an interactive session keeps it waiting.
   */
  constructor(
    readonly session: DebuggerSession,
    readonly armed: readonly ArmedBreakpoint[],
    first: FirstStop,
    private readonly record: { stops: Array<Record<string, unknown>>; hits: Map<string, number> },
    private readonly warnings: string[],
    private readonly afterHalt = 'the rest of the run went on without stopping',
  ) {
    this.remaining = new Set(armed.map((bp) => bp.id));
    this.reachedBreakpoints = first.reachedBreakpoints;
    this.steppingPossible = first.steppingPossible;
    this.unresolvable = first.unresolvable;
    this.following = !first.single;
  }

  /** Armed breakpoints that may still stop the run. */
  get breakpointsLeft(): number {
    return this.remaining.size;
  }

  // Only SAP's word counts back in a caller (the top frame stands on the call it returned from, already
  // passed) and for a conditional breakpoint (SAP stops there only where the condition holds).
  private reach(reached: readonly string[], top: DebugStackFrame | undefined, move: FrameMove | undefined) {
    const live = this.armed.filter((bp) => this.remaining.has(bp.id));
    return (
      armedAt(live, reached, undefined) ??
      (move === 'returned'
        ? undefined
        : armedAt(
            live.filter((bp) => !bp.condition),
            [],
            top,
          ))
    );
  }

  /**
   * Record the stop the run stands at: the breakpoint and its hit, the position and call stack (a
   * breakpoint's later stops carry only values), the variables. A breakpoint that made its hits is
   * retired from the run — unless nothing would stop the run again anyway (`more` false).
   */
  async recordStop(variables: readonly string[], more: boolean, result: ResultBudget): Promise<StopRecord> {
    const stack = this.reachedStack ?? (await this.session.stack());
    this.reachedStack = undefined;
    this.stack = stack;
    const at = breakpointAt(this.armed, this.reachedBreakpoints, stack[0]);
    const hits = at ? (this.record.hits.get(at.id) ?? 0) + 1 : 0;
    if (at) this.record.hits.set(at.id, hits);
    // A breakpoint's later stops (a loop) are compact: the position and call stack of its first stop
    // would only repeat, so they carry its values alone.
    // An event breakpoint stops wherever the run raises it: each of its stops shows where.
    const repeated = at?.kind === 'line' ? this.lastValues.get(at.id) : undefined;
    const stop: Record<string, unknown> = {
      stop: this.record.stops.length + 1,
      ...(at ? { at: at.label } : {}),
      ...(at && at.maxHits > 1 ? { hit: hits } : {}),
      ...(!repeated && stack[0] ? { stoppedAt: describeFrame(stack[0]) } : {}),
      ...(!repeated ? describeStack(stack) : {}),
    };
    const unevaluated = at?.condition ? this.unresolvable.find((bp) => bp.id === at.id) : undefined;
    if (at && unevaluated) {
      const where =
        unevaluated.conditionErrorOffset !== undefined
          ? ` (error at character ${unevaluated.conditionErrorOffset})`
          : '';
      stop.conditionNotEvaluated = `SAP could not evaluate "${at.condition}"${where} and stopped anyway.`;
      this.warnings.push(
        `SAP could not evaluate the condition of ${at.label} and stopped regardless of it: check that every variable it names exists at that line.`,
      );
    }
    this.record.stops.push(stop);
    // Retire a breakpoint that made its hits before the steps, so neither they nor the run stop there again.
    if (
      this.following &&
      at &&
      hits >= at.maxHits &&
      this.remaining.delete(at.id) &&
      (this.remaining.size > 0 || more)
    ) {
      try {
        await this.session.removeBreakpoint(at.id);
      } catch (err) {
        this.warnings.push(
          `Could not keep ${at.label} from stopping the run again (${debuggerErrorText(err)}); no further stops were recorded.`,
        );
        this.following = false;
      }
    }
    const read =
      variables.length > 0
        ? await readNamedVariables(this.session, variables)
        : await readFrameVariables(this.session, this.warnings);
    if (repeated) {
      Object.assign(stop, compactValues(read, repeated));
    } else {
      stop.variables = read;
      if (at?.kind === 'line') {
        const seen = new Map<string, string>();
        compactValues(read, seen);
        this.lastValues.set(at.id, seen);
      }
    }
    result.add(stop);
    return { stop, ...(at ? { at } : {}), stack, variables: read };
  }

  /** Why the steps must stop before step `next`, if they must. */
  private halt(budget: CallBudget, done: number, stop: number): string | undefined {
    if (budget.signal?.aborted) return `The call was cancelled after ${done} step(s) of a stop; ${this.afterHalt}.`;
    if (budget.deadline - Date.now() < timings.continueMarginMs) {
      return `The ${budget.seconds}s inspection budget ran low after ${done} step(s) of a stop; ${this.afterHalt}.`;
    }
    if (budget.result.exhausted) {
      return this.afterHalt === 'the rest of the run went on without stopping'
        ? budget.result.warning(stop)
        : `The result reached its size budget (about ${budget.result.kilobytes} KB) after ${done} step(s); ${this.afterHalt}.`;
    }
    return undefined;
  }

  /** What `until` compares against, read where the steps start. */
  private async untilCheck(until: StepUntil | undefined, start: readonly DebugStackFrame[]) {
    if (!until) return undefined;
    const check: UntilCheck = {};
    if (until.line !== undefined) {
      check.line = until.line;
      const path = start[0]?.uri ? sourcePosition(start[0].uri)?.uri : undefined;
      if (path) check.path = path;
    }
    if (until.changed) {
      const name = until.changed.trim().toUpperCase();
      const [variable] = await readNamedVariables(this.session, [name]);
      if (!variable || variable.error) {
        this.warnings.push(
          `until.changed: ${name} cannot be read where the steps start (${variable?.error ?? 'unknown'}), so the steps do not wait for it to change.`,
        );
      } else {
        check.changed = { name, initial: JSON.stringify(stepValue(variable)) };
      }
    }
    return check.line !== undefined || check.changed ? check : undefined;
  }

  private untilMet(
    check: UntilCheck,
    top: DebugStackFrame | undefined,
    read: CapturedVariable[] | undefined,
  ): string | undefined {
    if (check.line !== undefined && top) {
      const position = top.uri ? sourcePosition(top.uri) : undefined;
      const line = position?.line ?? top.line;
      if (line === check.line && (!check.path || position?.uri === check.path)) return `line ${check.line}`;
    }
    const changed = check.changed;
    if (changed && read) {
      const variable = read.find((candidate) => candidate.name === changed.name && !candidate.error);
      if (variable && JSON.stringify(stepValue(variable)) !== changed.initial) return `${changed.name} changed`;
    }
    return undefined;
  }

  /**
   * Step from where the run stands. After each step the watched variables are read again — one not
   * visible at the start too, as a step can enter the method that declares it. Up to DETAILED_STEPS
   * steps come back one entry each; past that the run comes back as a compact trace (lines folded,
   * values where they changed). The steps end early at an armed breakpoint (the run stands at it:
   * `reached`), when `until` holds, when the program ends, or when the call's time or result-size
   * budget runs out.
   */
  async steps(
    plan: StepPlan,
    from: { stack: DebugStackFrame[]; refused: Map<string, string>; stop: number },
    budget: CallBudget,
  ): Promise<StepRun> {
    // Entries while the run is short; the trace is kept alongside and takes over past DETAILED_STEPS.
    let steps: Array<Record<string, unknown>> | undefined = [];
    let entriesChars = 0;
    const trace = new StepTrace(from.stack);
    let frame = from.stack;
    const refused = new Map(from.refused);
    let previous = new Map<string, string>();
    const until = await this.untilCheck(plan.until, from.stack);
    const watched =
      until?.changed && !plan.variables.includes(until.changed.name)
        ? [...plan.variables, until.changed.name]
        : plan.variables;
    let taken = 0;
    let values: CapturedVariable[] | undefined;
    const finish = (fields: Partial<StepRun>, note?: Record<string, unknown>): StepRun => {
      if (note && steps) Object.assign(steps.at(-1) ?? {}, note);
      return {
        count: taken,
        ended: false,
        steppingPossible: true,
        ...(steps ? { steps } : { trace: { ...trace.result(), ...note } }),
        ...(values ? { values } : {}),
        ...fields,
      };
    };
    const record = (entry: Record<string, unknown>, sizeBefore: number) => {
      if (steps) {
        steps.push(entry);
        const chars = JSON.stringify(entry).length;
        entriesChars += chars;
        budget.result.addChars(chars);
      } else {
        budget.result.addChars(trace.size - sizeBefore);
      }
    };
    for (let index = 1; index <= plan.count; index++) {
      const halt = this.halt(budget, index - 1, from.stop);
      if (halt) {
        this.warnings.push(halt);
        return finish({ outOfBudget: true });
      }
      if (steps && index > DETAILED_STEPS) {
        // A long run: the trace replaces the entries, in the result and in the budget.
        budget.result.addChars(trace.size - entriesChars);
        steps = undefined;
      }
      const outcome = await this.session.step(STEP_METHODS[plan.mode]);
      taken = index;
      if (outcome.status === 'ended') {
        this.ended = true;
        this.steppingPossible = false;
        steps?.push({ step: index, ended: true });
        return finish({ ended: true, steppingPossible: false }, steps ? undefined : { ended: true });
      }
      const stack = await this.session.stack();
      this.stack = stack;
      this.steppingPossible = outcome.steppingPossible;
      const top = stack[0];
      const move = frameMove(frame, stack);
      const position = top ? describeFrame(top) : {};
      const line = typeof position.line === 'number' ? position.line : undefined;
      const entry: Record<string, unknown> = { step: index, ...position, ...(move ? { frame: move } : {}) };
      const sizeBefore = trace.size;
      const bp = this.reach(outcome.reachedBreakpoints, top, move);
      if (bp) {
        entry.breakpoint = bp.label;
        trace.add(index, top, line, move);
        record(entry, sizeBefore);
        return finish(
          {
            steppingPossible: outcome.steppingPossible,
            reached: { id: bp.id, stack, unresolvable: outcome.unresolvableConditions ?? [] },
          },
          steps ? undefined : { breakpoint: bp.label },
        );
      }
      if (move) {
        frame = stack;
        refused.clear();
        previous = new Map();
      }
      let read: CapturedVariable[] | undefined;
      if (watched.length > 0) {
        if (move) this.warnings.push(FRAME_MOVE_WARNING);
        try {
          read = await readNamedVariables(
            this.session,
            watched.filter((name) => !refused.has(name)),
          );
        } catch (err) {
          entry.valuesError = debuggerErrorText(err);
        }
      }
      values = read;
      if (read && steps) Object.assign(entry, compactValues(read, previous, refused));
      trace.add(index, top, line, move, read ? traceValues(read, refused, trace) : undefined);
      record(entry, sizeBefore);
      const met = until ? this.untilMet(until, top, read) : undefined;
      if (met) return finish({ steppingPossible: outcome.steppingPossible, untilMet: met }, { until: met });
      if (!outcome.steppingPossible) {
        this.warnings.push(`SAP reports stepping is no longer possible after step ${index}.`);
        return finish({ steppingPossible: false });
      }
      budget.progress?.(`step ${index} of ${plan.count}${line !== undefined ? `, line ${line}` : ''}`);
    }
    return finish({});
  }

  /** The run stands where a step ran into a breakpoint: the next stop is that one. */
  standAt(reached: NonNullable<StepRun['reached']>, steppingPossible: boolean): void {
    this.reachedBreakpoints = [reached.id];
    this.reachedStack = reached.stack;
    this.unresolvable = reached.unresolvable;
    this.steppingPossible = steppingPossible;
  }

  /** Let the run go on to its next stop (`stepContinue`), or to its end. */
  async continueRun(): Promise<'stopped' | 'ended'> {
    const next = await this.session.step('stepContinue');
    if (next.status === 'ended') {
      this.ended = true;
      this.steppingPossible = false;
      return 'ended';
    }
    this.reachedBreakpoints = next.reachedBreakpoints;
    this.steppingPossible = next.steppingPossible;
    this.unresolvable = next.unresolvableConditions ?? [];
    return 'stopped';
  }
}

/** A step's watched values for the trace; a variable SAP refuses is reported once and left out after. */
function traceValues(read: readonly CapturedVariable[], refused: Map<string, string>, trace: StepTrace): StepValues {
  const values: StepValues = {};
  for (const variable of read) {
    if (variable.error === NOT_VISIBLE) continue;
    if (variable.error) {
      refused.set(variable.name, variable.error);
      trace.refuse(variable.name, variable.error);
      continue;
    }
    values[variable.name] = stepValue(variable);
  }
  return values;
}

/**
 * Follow ONE run from stop to stop: record each stop (position, the call stack on a breakpoint's
 * first stop, variables, steps), retire a breakpoint from the run once it stopped it `maxHits` times,
 * then `stepContinue` to the next stop — or, when a step ran into a breakpoint, record that stop
 * where the run already stands. Ends when no armed breakpoint is left, the program ends, or a bound is
 * reached — the release then lets the rest of the run go on without stopping.
 */
export async function collectStops(
  session: DebuggerSession,
  req: FollowPlan,
  armed: readonly ArmedBreakpoint[],
  first: FirstStop,
  inspection: Inspection,
  budget: CallBudget,
  warnings: string[],
): Promise<void> {
  const follower = new RunFollower(session, armed, first, inspection, warnings);
  let stepsLeft = MAX_TOTAL_STEPS;
  for (;;) {
    const willStep = req.steps > 0 && follower.steppingPossible && stepsLeft > 0;
    const record = await follower.recordStop(req.variables, willStep, budget.result);
    const { stop } = record;
    budget.progress?.(`stop ${stop.stop}${record.at ? ` at ${record.at.label}` : ''}`);
    let run: StepRun | undefined;
    if (req.steps > 0) {
      if (!follower.steppingPossible) {
        warnings.push(`SAP reports stepping is not possible at stop ${stop.stop}; its steps were skipped.`);
      } else if (stepsLeft <= 0) {
        warnings.push(`A capture records at most ${MAX_TOTAL_STEPS} steps; stop ${stop.stop} has none.`);
      } else {
        const refused = new Map(
          record.variables.flatMap((variable) =>
            variable.error && variable.error !== NOT_VISIBLE ? [[variable.name, variable.error] as const] : [],
          ),
        );
        run = await follower.steps(
          {
            count: Math.min(req.steps, stepsLeft),
            mode: req.stepMode,
            ...(req.until ? { until: req.until } : {}),
            variables: req.variables,
          },
          { stack: record.stack, refused, stop: inspection.stops.length },
          budget,
        );
        stepsLeft -= run.count;
        if (run.steps && run.steps.length > 0) stop.steps = run.steps;
        if (run.trace) stop.trace = run.trace;
        if (run.ended) {
          inspection.release = { released: true, via: 'continue' };
          return;
        }
        if (run.outOfBudget || (!run.reached && !run.steppingPossible)) return;
      }
    }
    if (!follower.following) return;
    if (!run?.reached && follower.breakpointsLeft === 0) return;
    if (inspection.stops.length >= MAX_STOPS) {
      warnings.push(`A capture records at most ${MAX_STOPS} stops; the rest of the run went on without stopping.`);
      return;
    }
    if (budget.result.exhausted) {
      warnings.push(budget.result.warning(inspection.stops.length));
      return;
    }
    if (budget.signal?.aborted) {
      warnings.push(
        `The call was cancelled after ${inspection.stops.length} stop(s); the rest of the run went on without stopping.`,
      );
      return;
    }
    if (budget.deadline - Date.now() < timings.continueMarginMs) {
      warnings.push(
        `The ${budget.seconds}s inspection budget ran out after ${inspection.stops.length} stop(s); the rest of the run went on without stopping.`,
      );
      return;
    }
    if (run?.reached) {
      // A step ran into the next stop: the run already stands there.
      follower.standAt(run.reached, run.steppingPossible);
      continue;
    }
    if ((await follower.continueRun()) === 'ended') {
      inspection.release = { released: true, via: 'continue' };
      return;
    }
  }
}

/**
 * Following ONE attached run: record each stop, step from it, retire breakpoints that made their
 * hits, and continue to the next stop until the run ends or a bound is reached.
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
  INSPECTION_BUDGET_MS,
  MAX_STOPS,
  MAX_TOTAL_STEPS,
  ResultBudget,
  resultBudgetLimit,
  timings,
} from './debug-limits.js';
import {
  compactValues,
  describeFrame,
  describeStack,
  FRAME_MOVE_WARNING,
  type FrameMove,
  frameMove,
  NOT_VISIBLE,
  readFrameVariables,
  readNamedVariables,
  readStepValues,
  sourcePosition,
} from './debug-view.js';

export type StepMode = 'over' | 'into' | 'out';

/** What following a run takes from the request. */
export interface FollowPlan {
  variables: readonly string[];
  /** Steps after each stop. */
  steps: number;
  stepMode: StepMode;
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

interface StepRun {
  steps: Array<Record<string, unknown>>;
  /** The program finished during the steps. */
  ended: boolean;
  steppingPossible: boolean;
  /** A step ran into an armed breakpoint: the run stands at it (`stack`), and the next stop records it. */
  reached?: { id: string; stack: DebugStackFrame[]; unresolvable: ReachedBreakpoint[] };
  /** The inspection budget or the result-size budget ran out: the capture stops following the run. */
  outOfBudget?: true;
}

/** The armed breakpoint a step stopped at (`move`: how the step changed frame), if any. */
type StepReach = (
  reached: readonly string[],
  top: DebugStackFrame | undefined,
  move: FrameMove | undefined,
) => ArmedBreakpoint | undefined;

/**
 * `count` steps of `req.stepMode` from the stop's frame. After each step every requested variable is
 * read again — one not visible at the stop too, as a step can enter the method that declares it. A
 * step that runs into an armed breakpoint (`reach`) ends the steps: the next stop records it.
 */
async function runSteps(
  session: DebuggerSession,
  req: FollowPlan,
  count: number,
  from: { stack: DebugStackFrame[]; refused: Map<string, string>; stop: number },
  reach: StepReach,
  budget: { deadline: number; result: ResultBudget },
  warnings: string[],
): Promise<StepRun> {
  const steps: Array<Record<string, unknown>> = [];
  let frame = from.stack;
  const refused = new Map(from.refused);
  let previous = new Map<string, string>();
  for (let index = 1; index <= count; index++) {
    if (budget.deadline - Date.now() < timings.continueMarginMs) {
      warnings.push(
        `The ${INSPECTION_BUDGET_MS / 1000}s inspection budget ran low after ${index - 1} step(s) of a stop; the rest of the run went on without stopping.`,
      );
      return { steps, ended: false, steppingPossible: true, outOfBudget: true };
    }
    if (budget.result.exhausted) {
      warnings.push(budget.result.warning(from.stop));
      return { steps, ended: false, steppingPossible: true, outOfBudget: true };
    }
    const outcome = await session.step(STEP_METHODS[req.stepMode]);
    if (outcome.status === 'ended') {
      steps.push({ step: index, ended: true });
      return { steps, ended: true, steppingPossible: false };
    }
    const stack = await session.stack();
    const move = frameMove(frame, stack);
    const entry: Record<string, unknown> = {
      step: index,
      ...(stack[0] ? describeFrame(stack[0]) : {}),
      ...(move ? { frame: move } : {}),
    };
    steps.push(entry);
    const bp = reach(outcome.reachedBreakpoints, stack[0], move);
    if (bp) {
      entry.breakpoint = bp.label;
      budget.result.add(entry);
      return {
        steps,
        ended: false,
        steppingPossible: outcome.steppingPossible,
        reached: { id: bp.id, stack, unresolvable: outcome.unresolvableConditions ?? [] },
      };
    }
    if (move) {
      frame = stack;
      refused.clear();
      previous = new Map();
    }
    if (req.variables.length > 0) {
      if (move) warnings.push(FRAME_MOVE_WARNING);
      try {
        Object.assign(entry, await readStepValues(session, req.variables, refused, previous));
      } catch (err) {
        entry.valuesError = debuggerErrorText(err);
      }
    }
    budget.result.add(entry);
    if (!outcome.steppingPossible) {
      warnings.push(`SAP reports stepping is no longer possible after step ${index}.`);
      return { steps, ended: false, steppingPossible: false };
    }
  }
  return { steps, ended: false, steppingPossible: true };
}

/**
 * Follow ONE run from stop to stop: record each stop (position, the call stack on a breakpoint's
 * first stop, variables, steps), retire a breakpoint from the run once it stopped it `maxHits` times,
 * then `stepContinue` to the next stop — or, when a step ran into a breakpoint, record that stop
 * where the run already stands. Ends when no armed breakpoint is left, the program ends, or a cap is
 * reached — the release then lets the rest of the run go on without stopping.
 */
export async function collectStops(
  session: DebuggerSession,
  req: FollowPlan,
  armed: readonly ArmedBreakpoint[],
  first: {
    reachedBreakpoints: string[];
    steppingPossible: boolean;
    single: boolean;
    /** Reached breakpoints whose condition SAP could not evaluate. */
    unresolvable: ReachedBreakpoint[];
  },
  inspection: Inspection,
  deadline: number,
  warnings: string[],
): Promise<void> {
  const remaining = new Set(armed.map((bp) => bp.id));
  /** Per breakpoint, its values at its previous stop: a later stop says `unchanged` against them. */
  const lastValues = new Map<string, Map<string, string>>();
  const result = new ResultBudget(resultBudgetLimit());
  let { reachedBreakpoints, steppingPossible, unresolvable } = first;
  /** The stack a step already read where it ran into a breakpoint: the next stop's. */
  let reachedStack: DebugStackFrame[] | undefined;
  let stepsLeft = MAX_TOTAL_STEPS;
  // Only SAP's word counts back in a caller (the top frame stands on the call it returned from, already
  // passed) and for a conditional breakpoint (SAP stops there only where the condition holds).
  const reach: StepReach = (reached, top, move) => {
    const live = armed.filter((bp) => remaining.has(bp.id));
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
  };
  for (;;) {
    const stack = reachedStack ?? (await session.stack());
    reachedStack = undefined;
    const at = breakpointAt(armed, reachedBreakpoints, stack[0]);
    const hits = at ? (inspection.hits.get(at.id) ?? 0) + 1 : 0;
    if (at) inspection.hits.set(at.id, hits);
    // A breakpoint's later stops (a loop) are compact: the position and call stack of its first stop
    // would only repeat, so they carry its values alone.
    // An event breakpoint stops wherever the run raises it: each of its stops shows where.
    const repeated = at?.kind === 'line' ? lastValues.get(at.id) : undefined;
    const stop: Record<string, unknown> = {
      stop: inspection.stops.length + 1,
      ...(at ? { at: at.label } : {}),
      ...(at && at.maxHits > 1 ? { hit: hits } : {}),
      ...(!repeated && stack[0] ? { stoppedAt: describeFrame(stack[0]) } : {}),
      ...(!repeated ? describeStack(stack) : {}),
    };
    const unevaluated = at?.condition ? unresolvable.find((bp) => bp.id === at.id) : undefined;
    if (at && unevaluated) {
      const where =
        unevaluated.conditionErrorOffset !== undefined
          ? ` (error at character ${unevaluated.conditionErrorOffset})`
          : '';
      stop.conditionNotEvaluated = `SAP could not evaluate "${at.condition}"${where} and stopped anyway.`;
      warnings.push(
        `SAP could not evaluate the condition of ${at.label} and stopped regardless of it: check that every variable it names exists at that line.`,
      );
    }
    inspection.stops.push(stop);
    const willStep = req.steps > 0 && steppingPossible && stepsLeft > 0;
    // A post-mortem session is inspection only: nothing to follow, nothing to retire.
    let following = !first.single;
    // Retire a breakpoint that made its hits before the steps, so neither they nor the run stop there again.
    if (following && at && hits >= at.maxHits && remaining.delete(at.id) && (remaining.size > 0 || willStep)) {
      try {
        await session.removeBreakpoint(at.id);
      } catch (err) {
        warnings.push(
          `Could not keep ${at.label} from stopping the run again (${debuggerErrorText(err)}); no further stops were recorded.`,
        );
        following = false;
      }
    }
    const variables =
      req.variables.length > 0
        ? await readNamedVariables(session, req.variables)
        : await readFrameVariables(session, warnings);
    if (repeated) {
      Object.assign(stop, compactValues(variables, repeated));
    } else {
      stop.variables = variables;
      if (at?.kind === 'line') {
        const seen = new Map<string, string>();
        compactValues(variables, seen);
        lastValues.set(at.id, seen);
      }
    }
    result.add(stop);
    let run: StepRun | undefined;
    if (req.steps > 0) {
      if (!steppingPossible) {
        warnings.push(`SAP reports stepping is not possible at stop ${stop.stop}; its steps were skipped.`);
      } else if (stepsLeft <= 0) {
        warnings.push(`A capture records at most ${MAX_TOTAL_STEPS} steps; stop ${stop.stop} has none.`);
      } else {
        const refused = new Map(
          variables.flatMap((variable) =>
            variable.error && variable.error !== NOT_VISIBLE ? [[variable.name, variable.error] as const] : [],
          ),
        );
        run = await runSteps(
          session,
          req,
          Math.min(req.steps, stepsLeft),
          { stack, refused, stop: inspection.stops.length },
          reach,
          { deadline, result },
          warnings,
        );
        stepsLeft -= run.steps.length;
        if (run.steps.length > 0) stop.steps = run.steps;
        if (run.ended) {
          inspection.release = { released: true, via: 'continue' };
          return;
        }
        if (run.outOfBudget || (!run.reached && !run.steppingPossible)) return;
      }
    }
    if (!following) return;
    if (!run?.reached && remaining.size === 0) return;
    if (inspection.stops.length >= MAX_STOPS) {
      warnings.push(`A capture records at most ${MAX_STOPS} stops; the rest of the run went on without stopping.`);
      return;
    }
    if (result.exhausted) {
      warnings.push(result.warning(inspection.stops.length));
      return;
    }
    if (deadline - Date.now() < timings.continueMarginMs) {
      warnings.push(
        `The ${INSPECTION_BUDGET_MS / 1000}s inspection budget ran out after ${inspection.stops.length} stop(s); the rest of the run went on without stopping.`,
      );
      return;
    }
    if (run?.reached) {
      // A step ran into the next stop: the run already stands there.
      reachedBreakpoints = [run.reached.id];
      reachedStack = run.reached.stack;
      unresolvable = run.reached.unresolvable;
      steppingPossible = run.steppingPossible;
      continue;
    }
    const next = await session.step('stepContinue');
    if (next.status === 'ended') {
      inspection.release = { released: true, via: 'continue' };
      return;
    }
    ({ reachedBreakpoints, steppingPossible } = next);
    unresolvable = next.unresolvableConditions ?? [];
  }
}

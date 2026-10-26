/**
 * The bounds of a debugger capture: how long it follows a run, how much it records, and the fixed
 * delays the tests shorten. Time and result size are the real bounds — the caller picks them within
 * the server's ceilings; the counts below are only a safety net.
 */

/** Hard caps on the stops recorded in one run (all breakpoints, all hits) and the steps across them —
 *  a safety net: the time and result-size budgets end a capture first. Reaching a cap or a budget
 *  ends the capture, not the program. */
export const MAX_STOPS = 50;

export const MAX_TOTAL_STEPS = 10_000;

/** Up to this many steps from one stop come back one entry each; more come back as a compact trace. */
export const DETAILED_STEPS = 20;

/** Attach + reads + steps + continues once the debuggee is caught, unless the call asks otherwise. */
export const DEFAULT_CALL_SECONDS = 120;

/** Characters of compact JSON a result may fill unless the call asks otherwise (≈ 10-12k tokens). */
export const DEFAULT_RESULT_KB = 40;

/** Own budget for the release, so an exhausted inspection can never leave a debuggee suspended. */
export const RELEASE_BUDGET_MS = 60_000;

/** Opening the sessions ahead of the run (a few cheap requests). */
export const AHEAD_BUDGET_MS = 20_000;

/** The server's ceilings (environment variables), and how long an interactive session may last. */
export interface DebugLimits {
  /** Longest inspection a call may ask for (ABAP_DEBUGGER_MAX_SECONDS). */
  maxSeconds: number;
  /** Largest result a call may ask for, in KB (ABAP_DEBUGGER_MAX_RESULT_KB). */
  maxResultKB: number;
  /** An interactive session is released after this long without a call (ABAP_DEBUGGER_IDLE_SECONDS). */
  idleSeconds: number;
  /** An interactive session is released after this long in all (ABAP_DEBUGGER_SESSION_SECONDS). */
  sessionSeconds: number;
}

export const DEFAULT_LIMITS: DebugLimits = { maxSeconds: 600, maxResultKB: 200, idleSeconds: 120, sessionSeconds: 900 };

export const timings = {
  /** Head start for the long poll: SAP must register the listener before the trigger reaches the line. */
  armDelayMs: 1500,
  /** How long the capture still waits for the trigger's own answer after the release. */
  triggerSettleMs: 30_000,
  /** A further step or `stepContinue` starts only with this much of the inspection budget left. */
  continueMarginMs: 15_000,
  /** Progress notifications: at most one per interval. */
  progressIntervalMs: 2000,
  /** While waiting for the first stop, a progress notification this often. */
  waitTickMs: 5000,
};

/** Override the capture's fixed delays and margins in unit tests. */
export function setDebugTimingsForTests(overrides: Partial<typeof timings>): void {
  Object.assign(timings, overrides);
}

/** Characters of compact JSON the stops and their steps may fill by default: what the model can
 *  read in one result. Cost, not a count, decides: two named values per stop allow many more stops than
 *  sixty frame variables. */
const DEFAULT_RESULT_BUDGET_CHARS = DEFAULT_RESULT_KB * 1000;

let resultBudgetChars = DEFAULT_RESULT_BUDGET_CHARS;

/** The result-size budget a capture starts with when the call names none. */
export function resultBudgetLimit(): number {
  return resultBudgetChars;
}

/** Override the default result-size budget in unit tests (no argument: back to the default). */
export function setResultBudgetForTests(chars = DEFAULT_RESULT_BUDGET_CHARS): void {
  resultBudgetChars = chars;
}

/** How much of the result the recorded stops and steps take. */
export class ResultBudget {
  private used = 0;

  constructor(private readonly limit: number) {}

  add(entry: unknown): void {
    this.used += JSON.stringify(entry).length;
  }

  addChars(chars: number): void {
    this.used += chars;
  }

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  get kilobytes(): number {
    return Math.round(this.limit / 1000);
  }

  warning(stops: number): string {
    return `The result reached its size budget (about ${this.kilobytes} KB) after ${stops} stop(s); the rest of the run went on without stopping. Name fewer variables, narrow the stops with a condition, or raise maxResultKB.`;
  }
}

/** Progress of a long call, sent to clients that asked for it (they may keep the call alive on it). */
export type Progress = (message: string) => void;

/** What one tool call may spend following a run. */
export interface CallBudget {
  deadline: number;
  /** The time budget, for messages. */
  seconds: number;
  result: ResultBudget;
  /** The client cancelled the call. */
  signal?: AbortSignal;
  progress?: Progress;
}

/**
 * The budget of a call: the time and result size it asks for (`maxSeconds`, `maxResultKB`), each
 * capped by the server's ceiling — with a warning when the cap applies.
 */
export function planCallBudget(
  limits: DebugLimits,
  asked: { maxSeconds?: number; maxResultKB?: number },
  warnings: string[],
  context: { signal?: AbortSignal; progress?: Progress } = {},
): CallBudget {
  let seconds = asked.maxSeconds ?? Math.min(DEFAULT_CALL_SECONDS, limits.maxSeconds);
  if (seconds > limits.maxSeconds) {
    warnings.push(
      `maxSeconds ${seconds} is above this server's ceiling: ${limits.maxSeconds} s apply (ABAP_DEBUGGER_MAX_SECONDS).`,
    );
    seconds = limits.maxSeconds;
  }
  let chars = asked.maxResultKB !== undefined ? asked.maxResultKB * 1000 : resultBudgetLimit();
  if (chars > limits.maxResultKB * 1000) {
    warnings.push(
      `maxResultKB ${asked.maxResultKB} is above this server's ceiling: ${limits.maxResultKB} KB apply (ABAP_DEBUGGER_MAX_RESULT_KB).`,
    );
    chars = limits.maxResultKB * 1000;
  }
  return {
    deadline: Date.now() + seconds * 1000,
    seconds,
    result: new ResultBudget(chars),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.progress ? { progress: context.progress } : {}),
  };
}

/** A progress reporter that sends at most one notification per interval. */
export function throttledProgress(send: ((message: string) => void) | undefined): Progress | undefined {
  if (!send) return undefined;
  let last = 0;
  return (message) => {
    const now = Date.now();
    if (now - last < timings.progressIntervalMs) return;
    last = now;
    send(message);
  };
}

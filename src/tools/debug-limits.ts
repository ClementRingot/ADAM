/**
 * The bounds of a debugger capture: how long it follows a run, how much it records, and the fixed
 * delays the tests shorten.
 */

/** Hard caps on the stops recorded in one run (all breakpoints, all hits) and the steps across them —
 *  a safety net: the result-size budget below usually ends a capture first. Reaching a cap or the
 *  budget ends the capture, not the program. */
export const MAX_STOPS = 50;

export const MAX_TOTAL_STEPS = 100;

/** Attach + reads + steps + continues once the debuggee is caught. */
export const INSPECTION_BUDGET_MS = 120_000;

/** Own budget for the release, so an exhausted inspection can never leave a debuggee suspended. */
export const RELEASE_BUDGET_MS = 60_000;

/** Opening the sessions ahead of the run (a few cheap requests). */
export const AHEAD_BUDGET_MS = 20_000;

export const timings = {
  /** Head start for the long poll: SAP must register the listener before the trigger reaches the line. */
  armDelayMs: 1500,
  /** How long the capture still waits for the trigger's own answer after the release. */
  triggerSettleMs: 30_000,
  /** A further step or `stepContinue` starts only with this much of the inspection budget left. */
  continueMarginMs: 15_000,
};

/** Override the capture's fixed delays and margins in unit tests. */
export function setDebugTimingsForTests(overrides: Partial<typeof timings>): void {
  Object.assign(timings, overrides);
}

/** Characters of compact JSON the stops and their steps may fill (≈ 10-12k tokens): what the model can
 *  read in one result. Cost, not a count, decides: two named values per stop allow many more stops than
 *  sixty frame variables. */
const DEFAULT_RESULT_BUDGET_CHARS = 40_000;

let resultBudgetChars = DEFAULT_RESULT_BUDGET_CHARS;

/** The result-size budget a capture starts with. */
export function resultBudgetLimit(): number {
  return resultBudgetChars;
}

/** Override the result-size budget in unit tests (no argument: back to the default). */
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

  get exhausted(): boolean {
    return this.used >= this.limit;
  }

  warning(stops: number): string {
    return `The result reached its size budget (about ${Math.round(this.limit / 1000)} KB) after ${stops} stop(s); the rest of the run went on without stopping. Name fewer variables, or narrow the stops with a condition.`;
  }
}

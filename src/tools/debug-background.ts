/**
 * Work that may outlast a tool call. Many MCP clients give up on a call after 60 s, while a capture
 * may wait minutes for its stop (trigger "none": the user opens the app first) or follow a long run,
 * and a move of an interactive session may wait as long for its next stop. So the work runs in the
 * background; each call waits for it up to its budget (ABAP_DEBUGGER_CALL_SECONDS), and a call that
 * must answer first returns the session id — abap_debug_session action "wait" waits again, action
 * "end" stops it.
 */

import type { ToolContext } from './connection.js';
import { type DebugLimits, settleBy } from './debug-limits.js';
import type { DebugEntry } from './debug-registry.js';
import { describeError, errorResult, type ToolResult, textResult, toolJson } from './result.js';

const ANSWER_NOW = Symbol('answer now');

export class BackgroundWork implements DebugEntry {
  readonly startedAt = Date.now();
  /** Its answer, once it is done. */
  outcome: ToolResult | undefined;
  /** A call has received the answer. */
  delivered = false;
  /** What the user must do now for the work to go on (trigger "none": run the code), shown as userMessage. */
  hint: string | undefined;
  /** The user was shown the hint in a dialog of the client (MCP elicitation). */
  shownInDialog = false;
  readonly done: Promise<ToolResult>;
  private readonly abort = new AbortController();
  private waiterProgress: ((message: string) => void) | undefined;
  private waiterConfirm: ToolContext['confirm'];
  /** The work asked its call to answer now (answerNow), and no call has done so yet. */
  private answerNowPending = false;
  /** answerNow: the next answer brings the hint first, and the agent stops for the user. */
  private stopForUser = false;
  private wakeWaiter: (() => void) | undefined;

  constructor(
    readonly id: string,
    readonly owner: string,
    readonly system: string,
    readonly kind: DebugEntry['kind'],
    readonly user: string,
    /** What it does now: the latest progress message. */
    public doing: string,
    /** `self`: this work, for work that hands its answer over to an interactive session. */
    work: (context: ToolContext, self: BackgroundWork) => Promise<ToolResult>,
  ) {
    const context: ToolContext = {
      signal: this.abort.signal,
      progress: (message) => {
        this.doing = message;
        this.waiterProgress?.(message);
      },
      hint: (text) => {
        this.hint = text;
      },
      answerNow: () => {
        this.answerNowPending = true;
        this.stopForUser = true;
        this.wakeWaiter?.();
      },
      // The dialog closes once the work is done; declining it stops the work.
      confirm: async (message) => {
        const ask = this.waiterConfirm;
        if (!ask) return undefined;
        const closed = new AbortController();
        void this.done.then(() => closed.abort());
        this.shownInDialog = true;
        const answer = await ask(message, closed.signal);
        if (answer === undefined) this.shownInDialog = false;
        else if (answer !== 'accept') this.cancel();
        return answer;
      },
      owner,
    };
    this.done = work(context, this)
      .catch((err: unknown) => errorResult(describeError(err)))
      .then((result) => {
        this.outcome = result;
        return result;
      });
  }

  get active(): boolean {
    return this.outcome === undefined;
  }

  /** Stop the work: it removes what it set up on SAP and releases the program, as a cancelled call does. */
  cancel(): void {
    this.abort.abort();
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.done;
  }

  /**
   * Wait for the work up to `deadline` on behalf of a call: the call gets its progress, and the
   * call's cancellation stops the work. Undefined: the call must answer first (its budget ran out,
   * or the work needs the user to act now), the work goes on.
   */
  async waitFor(context: ToolContext, deadline: number): Promise<ToolResult | undefined> {
    const onAbort = () => this.cancel();
    if (context.signal?.aborted) this.cancel();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    this.waiterProgress = context.progress;
    this.waiterConfirm = context.confirm;
    const answerNow = new Promise<typeof ANSWER_NOW>((resolve) => {
      // A cancelled work answers with what it cleaned up, not with steps for the user.
      this.wakeWaiter = () => {
        if (this.active && !this.abort.signal.aborted) resolve(ANSWER_NOW);
      };
      if (this.answerNowPending) this.wakeWaiter();
    });
    try {
      const settled = await settleBy(Promise.race([this.done, answerNow]), deadline);
      if (!settled) return undefined;
      if (settled.value === ANSWER_NOW) {
        this.answerNowPending = false;
        return undefined;
      }
      this.delivered = true;
      return settled.value;
    } finally {
      this.wakeWaiter = undefined;
      if (this.waiterProgress === context.progress) this.waiterProgress = undefined;
      if (this.waiterConfirm === context.confirm) this.waiterConfirm = undefined;
      context.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Whether this answer is the first since answerNow: the agent must stop for the user. */
  takeStopForUser(): boolean {
    const stop = this.stopForUser;
    this.stopForUser = false;
    return stop;
  }

  describe(): Record<string, unknown> {
    return {
      session: this.id,
      kind: this.kind === 'capture' ? 'capture (one-shot)' : 'interactive session, starting',
      user: this.user,
      ...(this.active ? { doing: this.doing } : { done: true }),
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

/** The answer of a call that must return before its work is done. */
export function stillRunning(work: BackgroundWork, limits: DebugLimits): ToolResult {
  const wait = `abap_debug_session with action "wait" for its answer (each call waits up to ${limits.callSeconds} s: ABAP_DEBUGGER_CALL_SECONDS), or action "end" to stop it.`;
  const status = {
    session: work.id,
    running: true,
    doing: work.doing,
    seconds: Math.round((Date.now() - work.startedAt) / 1000),
  };
  if (!work.hint) return textResult(toolJson({ ...status, next: `It goes on in the background. Call ${wait}` }));
  // For the user, as it is; for the agent, apart: what to do with it.
  const agentInstructions = work.takeStopForUser()
    ? 'END YOUR TURN NOW: show userMessage to the user, in their language, keeping its numbered steps. Do not call abap_debug_session until they reply; then call action "wait" for the stop (action "end" stops the capture).'
    : work.shownInDialog
      ? `The user sees userMessage in a dialog of the client. It goes on in the background: call ${wait}`
      : `Still waiting for the stop. If the user has not seen userMessage yet, show it to them, in their language, and end your turn; once they ran the code, call ${wait}`;
  return textResult(toolJson({ ...status, userMessage: work.hint, agentInstructions }));
}

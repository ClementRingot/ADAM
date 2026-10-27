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

export class BackgroundWork implements DebugEntry {
  readonly startedAt = Date.now();
  /** Its answer, once it is done. */
  outcome: ToolResult | undefined;
  /** A call has received the answer. */
  delivered = false;
  readonly done: Promise<ToolResult>;
  private readonly abort = new AbortController();
  private waiterProgress: ((message: string) => void) | undefined;

  constructor(
    readonly id: string,
    readonly owner: string,
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
   * call's cancellation stops the work. Undefined: the call must answer first, the work goes on.
   */
  async waitFor(context: ToolContext, deadline: number): Promise<ToolResult | undefined> {
    const onAbort = () => this.cancel();
    if (context.signal?.aborted) this.cancel();
    context.signal?.addEventListener('abort', onAbort, { once: true });
    this.waiterProgress = context.progress;
    try {
      const settled = await settleBy(this.done, deadline);
      if (!settled) return undefined;
      this.delivered = true;
      return settled.value;
    } finally {
      if (this.waiterProgress === context.progress) this.waiterProgress = undefined;
      context.signal?.removeEventListener('abort', onAbort);
    }
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
  return textResult(
    toolJson({
      session: work.id,
      running: true,
      doing: work.doing,
      seconds: Math.round((Date.now() - work.startedAt) / 1000),
      next: `It goes on in the background. Call abap_debug_session with action "wait" for its answer (each call waits up to ${limits.callSeconds} s: ABAP_DEBUGGER_CALL_SECONDS), or action "end" to stop it.`,
    }),
  );
}

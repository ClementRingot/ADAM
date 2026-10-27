/**
 * What each MCP user debugs on this server: one capture or interactive session at a time, kept in
 * this process between calls — the stdio process of the one local user, or the single instance of
 * an HTTP deployment. It also says who debugs which SAP user (SAP keys the debugger listener by
 * user, so one capture or session per SAP user), and the caps on concurrent captures and sessions
 * count what is here.
 */

import { settleBy } from './debug-limits.js';

/** A capture or an interactive session, as the registry, the caps and the breakpoint listing see it. */
export interface DebugEntry {
  /** What abap_debug_session calls it (`S1`, `S2`, …). */
  readonly id: string;
  /** The MCP user it belongs to: nobody else reaches it. */
  readonly owner: string;
  readonly kind: 'capture' | 'session';
  /** The SAP user it debugs. */
  readonly user: string;
  /**
   * Still works on SAP or holds a program: it keeps the SAP user to itself, counts toward the caps,
   * and keeps its owner from starting another.
   */
  readonly active: boolean;
  /** How it stands, for abap_debug_breakpoints. */
  describe(): Record<string, unknown>;
  /** End it and release its program on SAP — the server stops. */
  stop(reason: string): Promise<void>;
}

/** The owner of every call over stdio: the one local user. */
export const LOCAL_OWNER = 'local';

/** On shutdown, how long the releases may take before the process exits anyway. */
const SHUTDOWN_BUDGET_MS = 15_000;

/** Each owner's current entry — active, or the last one until they start another. */
const entries = new Map<string, DebugEntry>();
let counter = 0;

/** The calling MCP user. */
export const ownerOf = (context: { owner?: string }): string => context.owner ?? LOCAL_OWNER;

export function nextDebugId(): string {
  counter += 1;
  return `S${counter}`;
}

export function entryOf(owner: string): DebugEntry | undefined {
  return entries.get(owner);
}

/** Make `entry` its owner's current one. */
export function setEntry(entry: DebugEntry): void {
  entries.set(entry.owner, entry);
}

/** Forget `entry` — only while it is still its owner's current one. */
export function removeEntry(entry: DebugEntry): void {
  if (entries.get(entry.owner) === entry) entries.delete(entry.owner);
}

/** The active capture or session that debugs SAP user `user`, whoever owns it. */
export function holderOf(user: string): DebugEntry | undefined {
  return [...entries.values()].find((entry) => entry.active && entry.user === user);
}

/** Captures or sessions that still work on SAP or hold a program. */
export function activeCount(kind: DebugEntry['kind']): number {
  return [...entries.values()].filter((entry) => entry.kind === kind && entry.active).length;
}

export function allEntries(): DebugEntry[] {
  return [...entries.values()];
}

/** End every active capture and session (server shutdown), within a bounded time. */
export async function stopAllDebugging(reason: string, budgetMs = SHUTDOWN_BUDGET_MS): Promise<void> {
  const active = [...entries.values()].filter((entry) => entry.active);
  if (active.length === 0) return;
  await settleBy(Promise.all(active.map((entry) => entry.stop(reason))), Date.now() + budgetMs);
}

/** Between unit tests: end what a test left running (on the fake SAP), then forget everything. */
export async function resetDebuggingForTests(): Promise<void> {
  await stopAllDebugging('the test ended', 5000);
  entries.clear();
  counter = 0;
}

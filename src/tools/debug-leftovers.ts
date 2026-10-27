/**
 * Breakpoints a capture armed for the whole SAP user (external breakpoints) and could not remove:
 * its process was killed mid-capture, or SAP refused the removal. SAP has no request that lists a
 * user's breakpoints, so each capture records its debugger identity in a small file before it arms
 * anything, and drops the record once its breakpoints are gone. What is left can then be found and
 * removed — by the next capture of the same user, or on request (abap_breakpoints). Removing them
 * takes one empty full sync per identity: it replaces that identity's breakpoints with none.
 *
 * Leftover breakpoints stop nothing while no debugger listens for the user, but stop the user's
 * requests at odd places once one does — Eclipse's included.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DebugIdentity, debuggerErrorText, syncBreakpoints } from '../adt/debugger.js';
import type { AdtHttpClient, AdtRequestOptions } from '../adt/http.js';
import { logger } from '../logger.js';

/** One capture's debugger identity, recorded while its breakpoints may be armed. */
export interface ArmedRecord {
  /** The SAP system and client (`AdtHttpClient.systemKey`). */
  system: string;
  user: string;
  terminalId: string;
  ideId: string;
  /** When the capture armed its breakpoints (ISO time). */
  armedAt: string;
  /** The process that armed them: while it runs, they are its own, not left over. */
  host: string;
  pid: number;
}

let stateDir = process.env.ABAP_DEBUGGER_STATE_DIR?.trim() || join(tmpdir(), 'abap-debugger-mcp');

/** Identities this process armed and has not settled yet: its captures in progress. */
const armedHere = new Set<string>();

const fileOf = (terminalId: string): string => join(stateDir, `armed-${terminalId}.json`);

/** Before arming: record the identity, so that its breakpoints can be found if the capture dies. */
export function recordArmed(http: AdtHttpClient, identity: DebugIdentity): void {
  armedHere.add(identity.terminalId);
  const record: ArmedRecord = {
    system: http.systemKey,
    user: identity.user,
    terminalId: identity.terminalId,
    ideId: identity.ideId,
    armedAt: new Date().toISOString(),
    host: hostname(),
    pid: process.pid,
  };
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(fileOf(identity.terminalId), JSON.stringify(record), { mode: 0o600 });
  } catch (err) {
    logger.debug(`Cannot record the armed breakpoints in ${stateDir}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * The capture is over: its record goes once its breakpoints are removed, and stays — a leftover for
 * the next capture or abap_breakpoints — when they could not be.
 */
export function settleArmed(identity: DebugIdentity, removed: boolean): void {
  armedHere.delete(identity.terminalId);
  if (removed) dropRecord(identity.terminalId);
}

function dropRecord(terminalId: string): void {
  try {
    rmSync(fileOf(terminalId), { force: true });
  } catch {
    // a record that cannot be removed is found again, and its empty sync is harmless
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * What is left behind for `user` on `http`'s system: records whose capture is over — its process on
 * this host ended, or this process gave up removing them. Records of other hosts are not judged.
 */
export function leftoversOf(http: AdtHttpClient, user: string): ArmedRecord[] {
  let names: string[];
  try {
    names = readdirSync(stateDir).filter((name) => /^armed-[A-Z0-9]+\.json$/.test(name));
  } catch {
    return [];
  }
  const host = hostname();
  const wanted = user.toUpperCase();
  const records: ArmedRecord[] = [];
  for (const name of names) {
    let record: ArmedRecord;
    try {
      record = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as ArmedRecord;
    } catch {
      continue;
    }
    if (record.system !== http.systemKey || record.user !== wanted || record.host !== host) continue;
    const inProgress = record.pid === process.pid ? armedHere.has(record.terminalId) : alive(record.pid);
    if (!inProgress) records.push(record);
  }
  return records.sort((a, b) => a.armedAt.localeCompare(b.armedAt));
}

/** Remove each leftover's breakpoints — an empty full sync of its identity — and its record. */
export async function removeLeftovers(
  http: AdtHttpClient,
  records: readonly ArmedRecord[],
  options?: AdtRequestOptions,
): Promise<{ removed: ArmedRecord[]; failed: Array<{ record: ArmedRecord; error: string }> }> {
  const removed: ArmedRecord[] = [];
  const failed: Array<{ record: ArmedRecord; error: string }> = [];
  for (const record of records) {
    const identity = { user: record.user, terminalId: record.terminalId, ideId: record.ideId };
    try {
      await syncBreakpoints(http, identity, [], 'external', options);
      dropRecord(record.terminalId);
      removed.push(record);
    } catch (err) {
      failed.push({ record, error: debuggerErrorText(err) });
    }
  }
  return { removed, failed };
}

/** A leftover as the tools show it. */
export function describeLeftover(record: ArmedRecord): Record<string, unknown> {
  return {
    armedAt: record.armedAt,
    by:
      record.pid === process.pid
        ? 'a capture of this server that could not remove them'
        : 'a capture whose server process ended',
  };
}

/** Point the records at a test directory (and forget this process's own). */
export function setStateDirForTests(dir: string): void {
  stateDir = dir;
  armedHere.clear();
}

/**
 * "Who am I" for one ADT session: SAP itself names the session's logon user.
 *
 * `GET /sap/bc/adt/core/http/systeminformation` (JSON: `systemID`, `client`, `userName`, …) is the
 * resource Eclipse ADT reads right after logon; SAP Fiori tools read it the same way. It answers
 * for the session that asks — so the debugger listens for the user who really runs the requests,
 * never a configured or caller-supplied name. Absent on SAP_BASIS 7.50 and older.
 * See docs/research/2026-10-22-abap-debugger-one-shot-capture.md §7.3.
 */

import { AdtApiError } from './errors.js';
import type { AdtHttpClient } from './http.js';

export const SYSTEM_INFORMATION_PATH = '/sap/bc/adt/core/http/systeminformation';
export const SYSTEM_INFORMATION_ACCEPT = 'application/vnd.sap.adt.core.http.systeminformation.v1+json';
/** Statuses that mean "this release has no such resource", as opposed to a failed request. */
const ABSENT_STATUSES = new Set([404, 405, 406, 501]);

/** A plausible SAP logon user (XUBNAME): 1-12 characters, no blanks, never an e-mail address. */
export function isPlausibleSapUser(value: string): boolean {
  return /^[^\s@]{1,12}$/.test(value);
}

/** The `userName` of a systeminformation body (upper-cased), or undefined when it names none. */
export function parseSessionUser(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  for (const [key, value] of Object.entries(parsed)) {
    if (key.toLowerCase() !== 'username' || typeof value !== 'string') continue;
    const user = value.trim().toUpperCase();
    return isPlausibleSapUser(user) ? user : undefined;
  }
  return undefined;
}

/**
 * Ask SAP for this session's logon user. Undefined when the release lacks the resource or the
 * answer names no plausible user; any other failure (401/403/5xx, network) propagates. Never
 * cached: the answer belongs to the session, and the credentials, that asked.
 */
export async function getSessionUser(http: AdtHttpClient): Promise<string | undefined> {
  try {
    const resp = await http.get(
      SYSTEM_INFORMATION_PATH,
      { Accept: SYSTEM_INFORMATION_ACCEPT },
      { suppressNotFoundLog: true },
    );
    return parseSessionUser(resp.body);
  } catch (err) {
    if (err instanceof AdtApiError && ABSENT_STATUSES.has(err.statusCode)) return undefined;
    throw err;
  }
}

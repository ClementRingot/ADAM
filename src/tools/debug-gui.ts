/**
 * SAP GUI runs on a system with several application servers (trigger "none"). External breakpoints
 * are the user's on every server, but a SAP GUI dialog run stops reliably only on the server whose
 * session armed them last: arming switches debugging on for the user on that server alone (seen live
 * on S/4HANA). So the capture looks up the user's SAP GUI server — their latest SAP GUI logon — and
 * arms from one session on each server it knows, that one last. HTTP runs (a Fiori app, Postman)
 * stop on any server either way. See docs/adt-debugger-protocol.md ("SAP GUI runs").
 */

import {
  contextServer,
  debuggerErrorText,
  endSession,
  openArmingSessions,
  type SessionsAhead,
} from '../adt/debugger.js';
import { type GuiLogon, readGuiLogons } from '../adt/gui-logons.js';
import type { AdtHttpClient } from '../adt/http.js';
import type { SapConnection } from './connection.js';
import type { ArmingSession, ArmRoute } from './debug-arm.js';
import { AHEAD_BUDGET_MS } from './debug-limits.js';

/** Where the capture arms from for the user's SAP GUI, and the sessions that do it. */
export interface GuiRoute {
  /** The user's SAP GUI server: their latest SAP GUI logon. */
  server: string;
  /** The servers of their other SAP GUI logons, latest first: a run there may not stop. */
  others: string[];
  route: ArmRoute;
  /** Every arming session, ended with the capture. */
  sessions: AdtHttpClient[];
}

/**
 * The arming route of a capture whose run the user starts (trigger "none"). Undefined — the capture
 * arms from the stateless client, as before — when SAP names no server, the user has no SAP GUI
 * logon, or a step fails (a warning says which, when it matters). Takes over `ahead.trigger` (ended
 * when unused) and may add a server to `ahead.byServer`.
 */
export async function openGuiRoute(
  conn: SapConnection,
  user: string,
  ahead: SessionsAhead,
  warnings: string[],
): Promise<GuiRoute | undefined> {
  const options = { deadline: Date.now() + AHEAD_BUDGET_MS };
  const dropTrigger = async (): Promise<undefined> => {
    if (ahead.trigger) await endSession(ahead.trigger, options);
    ahead.trigger = undefined;
    return undefined;
  };
  if (ahead.byServer.size === 0) return dropTrigger();
  let logons: GuiLogon[];
  try {
    logons = await readGuiLogons(conn.http, user, options);
  } catch (err) {
    if (ahead.byServer.size > 1) {
      warnings.push(
        `Could not look up which application server runs SAP user ${user}'s SAP GUI (table USR41 through the ADT data preview: ${debuggerErrorText(err)}). With several servers a SAP GUI run stops reliably only on the one that armed the breakpoints last — not necessarily yours.`,
      );
    }
    return dropTrigger();
  }
  const [latest, ...others] = logons;
  if (!latest) return dropTrigger();
  let armers: Map<string, AdtHttpClient>;
  try {
    armers = await openArmingSessions(conn.http, ahead, latest.server, options);
  } catch (err) {
    warnings.push(
      `Could not open the sessions that arm the breakpoints from each application server (${debuggerErrorText(err)}): a SAP GUI run on ${latest.server} may not stop.`,
    );
    return undefined;
  }
  const last = armers.get(latest.server.toUpperCase());
  if (!last) {
    for (const session of armers.values()) await endSession(session, options);
    warnings.push(
      `No session landed on application server ${latest.server}, where SAP user ${user} is logged on to SAP GUI, to arm the breakpoints from: a SAP GUI run there may not stop.`,
    );
    return undefined;
  }
  const before: ArmingSession[] = [...armers]
    .filter(([, http]) => http !== last)
    .map(([key, http]) => ({ server: contextServer(http.sessionContextId) ?? key, http }));
  return {
    server: latest.server,
    others: others.map((logon) => logon.server),
    route: { before, last: { server: latest.server, http: last } },
    sessions: [...armers.values()],
  };
}

/**
 * For a trigger-"none" run that never stopped: where a SAP GUI run stops. `armedServer`: the user's
 * SAP GUI server when the breakpoints were armed from it last; `multiServer`: SAP named more than one
 * server.
 */
export function guiHint(
  user: string,
  armedServer: string | undefined,
  others: readonly string[],
  multiServer: boolean,
): string {
  if (armedServer) {
    const elsewhere = others.length > 0 ? `, not on ${others.join(', ')} where ${user} is logged on too` : '';
    return ` Run from SAP GUI, it stops reliably on application server ${armedServer} only (${user}'s latest SAP GUI logon, which armed the breakpoints last)${elsewhere}; System → Status in SAP GUI names the server.`;
  }
  if (!multiServer) return '';
  return ' With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last, which is the server of your SAP GUI only when the capture finds it: be logged on to SAP GUI when the capture starts.';
}

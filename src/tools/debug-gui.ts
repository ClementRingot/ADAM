/**
 * SAP GUI runs on a system with several application servers (trigger "none"). External breakpoints
 * are the user's on every server, but a SAP GUI dialog run stops reliably only on the server whose
 * session armed them last: arming switches debugging on for the user on that server alone (seen live
 * on S/4HANA). So the capture looks up the user's SAP GUI server — their latest SAP GUI logon — and
 * arms from one session on each server it knows, that one last. HTTP runs (a Fiori app, Postman)
 * stop on any server either way. See docs/adt-debugger-protocol.md ("SAP GUI runs").
 *
 * Only where a SAP GUI can be: when SAP names an AS ABAP instance among its servers (the BTP ABAP
 * Environment's pods have no SAP GUI), and unless ABAP_DEBUGGER_SAP_GUI_LOOKUP=false.
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
 * An application server as SM51 names an AS ABAP instance, `<host>_<SID>_<instance number>` (e.g.
 * `sapdev01_DEV_00`): the kind SAP GUI logs on to. The BTP ABAP Environment's servers are pods
 * (`appserver-t4w2x`), and it has no SAP GUI.
 */
export function isInstanceName(server: string): boolean {
  return /^\S+_[A-Z][A-Z0-9]{2}_\d{2}$/i.test(server.trim());
}

/** SAP named several AS ABAP instances: a SAP GUI run then stops reliably on one server only. */
export function severalInstances(ahead: SessionsAhead): boolean {
  return [...ahead.byServer.keys()].filter(isInstanceName).length > 1;
}

/**
 * The arming route of a capture whose run the user starts (trigger "none"). Undefined — the capture
 * arms from the stateless client, as before — when no server SAP names is an AS ABAP instance (no
 * SAP GUI there), the lookup is off, the user has no SAP GUI logon, or a step fails (a warning says
 * which, when it matters). Takes over `ahead.trigger` (ended when unused) and may add a server to
 * `ahead.byServer`.
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
  if (conn.sapGuiLookup === false || ![...ahead.byServer.keys()].some(isInstanceName)) return dropTrigger();
  let logons: GuiLogon[];
  try {
    logons = await readGuiLogons(conn.http, user, options);
  } catch (err) {
    if (severalInstances(ahead)) {
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
 * AS ABAP instance (`severalInstances`); `lookupOff`: ABAP_DEBUGGER_SAP_GUI_LOOKUP=false.
 */
export function guiHint(
  user: string,
  armedServer: string | undefined,
  others: readonly string[],
  multiServer: boolean,
  lookupOff = false,
): string {
  if (armedServer) {
    const elsewhere = others.length > 0 ? `, not on ${others.join(', ')} where ${user} is logged on too` : '';
    return ` Run from SAP GUI, it stops reliably on application server ${armedServer} only (${user}'s latest SAP GUI logon, which armed the breakpoints last)${elsewhere}; System → Status in SAP GUI names the server.`;
  }
  if (!multiServer) return '';
  if (lookupOff) {
    return " With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last — not necessarily yours: this server does not look up the user's SAP GUI server (ABAP_DEBUGGER_SAP_GUI_LOOKUP=false).";
  }
  return ' With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last, which is the server of your SAP GUI only when the capture finds it: be logged on to SAP GUI when the capture starts.';
}

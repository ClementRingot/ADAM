/**
 * SAP GUI runs on a system with several application servers (trigger "none"). External breakpoints
 * are the user's on every server, but a SAP GUI dialog run stops reliably only on the server whose
 * session armed them last: arming switches debugging on for the user on that server alone (seen live
 * on S/4HANA). So the capture looks up the user's SAP GUI server — their latest SAP GUI logon — and
 * arms from one session on each server it knows, that one last; while it waits, it reads the logons
 * again and arms from a later logon's server (`GuiWatch`). HTTP runs (a Fiori app, Postman) stop on
 * any server either way. See docs/adt-debugger-protocol.md ("SAP GUI runs").
 *
 * Only where a SAP GUI can be: when SAP names an AS ABAP instance among its servers (the BTP ABAP
 * Environment's pods have no SAP GUI), and unless ABAP_DEBUGGER_SAP_GUI_LOOKUP=false.
 */

import {
  contextServer,
  type DebugIdentity,
  debuggerErrorText,
  endSession,
  openArmingSessionOn,
  openArmingSessions,
  type SessionsAhead,
} from '../adt/debugger.js';
import { type GuiLogon, readGuiLogons } from '../adt/gui-logons.js';
import type { AdtHttpClient } from '../adt/http.js';
import type { SapConnection } from './connection.js';
import { type ArmedBreakpoints, type ArmingSession, type ArmRoute, rearmFrom } from './debug-arm.js';
import { AHEAD_BUDGET_MS } from './debug-limits.js';

/** Where the capture arms from for the user's SAP GUI, and the sessions that do it. */
export interface GuiRoute {
  /** The user's SAP GUI server: their latest SAP GUI logon. */
  server: string;
  /** The servers of their other SAP GUI logons, latest first: a run there may not stop. */
  others: string[];
  route: ArmRoute;
  /** Every arming session, by server (upper-case). */
  armers: Map<string, AdtHttpClient>;
}

/** What the SAP GUI lookup found before anything was armed. */
export interface GuiLookup {
  /** Where to arm from; unset: from the stateless client, as without SAP GUI. */
  route?: GuiRoute;
  /** SAP answered the lookup: worth reading again while the capture waits. */
  readable: boolean;
  /** The user's SAP GUI server no session landed on: not worth trying again. */
  missed?: string;
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
 * The SAP GUI lookup of a capture whose run the user starts (trigger "none"), and its arming route.
 * No route — the capture arms from the stateless client, as before — when no server SAP names is an
 * AS ABAP instance (no SAP GUI there), the lookup is off, the user has no SAP GUI logon, or a step
 * fails (a warning says which, when it matters). Takes over `ahead.trigger` (ended when unused) and
 * may add a server to `ahead.byServer`.
 */
export async function openGuiRoute(
  conn: SapConnection,
  user: string,
  ahead: SessionsAhead,
  warnings: string[],
): Promise<GuiLookup> {
  const options = { deadline: Date.now() + AHEAD_BUDGET_MS };
  const dropTrigger = async (): Promise<void> => {
    if (ahead.trigger) await endSession(ahead.trigger, options);
    ahead.trigger = undefined;
  };
  if (conn.sapGuiLookup === false || ![...ahead.byServer.keys()].some(isInstanceName)) {
    await dropTrigger();
    return { readable: false };
  }
  let logons: GuiLogon[];
  try {
    logons = await readGuiLogons(conn.http, user, options);
  } catch (err) {
    if (severalInstances(ahead)) {
      warnings.push(
        `Could not look up which application server runs SAP user ${user}'s SAP GUI (table USR41 through the ADT data preview: ${debuggerErrorText(err)}). With several servers a SAP GUI run stops reliably only on the one that armed the breakpoints last — not necessarily yours.`,
      );
    }
    await dropTrigger();
    return { readable: false };
  }
  const [latest, ...others] = logons;
  if (!latest) {
    await dropTrigger();
    return { readable: true };
  }
  let armers: Map<string, AdtHttpClient>;
  try {
    armers = await openArmingSessions(conn.http, ahead, latest.server, options);
  } catch (err) {
    warnings.push(
      `Could not open the sessions that arm the breakpoints from each application server (${debuggerErrorText(err)}): a SAP GUI run on ${latest.server} may not stop.`,
    );
    return { readable: true };
  }
  const last = armers.get(latest.server.toUpperCase());
  if (!last) {
    for (const session of armers.values()) await endSession(session, options);
    warnings.push(
      `No session landed on application server ${latest.server}, where SAP user ${user} is logged on to SAP GUI, to arm the breakpoints from: a SAP GUI run there may not stop.`,
    );
    return { readable: true, missed: latest.server };
  }
  const before: ArmingSession[] = [...armers]
    .filter(([, http]) => http !== last)
    .map(([key, http]) => ({ server: contextServer(http.sessionContextId) ?? key, http }));
  return {
    readable: true,
    route: {
      server: latest.server,
      others: others.map((logon) => logon.server),
      route: { before, last: { server: latest.server, http: last } },
      armers,
    },
  };
}

/** Where the breakpoints are armed from for the user's SAP GUI, kept up to date while the capture waits. */
export interface GuiArming {
  /** The user's SAP GUI server whose session armed the breakpoints last; unset: none did. */
  server?: string;
  /** The servers of the user's other SAP GUI logons, latest first. */
  others: string[];
  /** Arming sessions by server (upper-case), each ended with the capture. */
  armers: Map<string, AdtHttpClient>;
}

export interface GuiWatchOptions {
  conn: SapConnection;
  user: string;
  identity: DebugIdentity;
  ahead: SessionsAhead;
  armed: ArmedBreakpoints;
  /** The capture's cleanup list, kept up to date when SAP renumbers the breakpoints. */
  armedIds: string[];
  arming: GuiArming;
  /** The capture's SAP GUI warnings (reported when nothing stopped). */
  warnings: string[];
  /** A server no session landed on before (`GuiLookup.missed`): not tried again. */
  missed?: string;
  /** How long between two reads. */
  everyMs: number;
  /** The breakpoints were armed again from `server`. */
  onArmed?: (server: string) => void;
}

/**
 * While a trigger-"none" capture waits for its stop: reads the user's SAP GUI logons again every
 * `everyMs`, and when the latest is on another server than the one that armed the breakpoints last,
 * arms them again from a session there — so that a SAP GUI logon opened after the capture started
 * stops too. Reads no more after a failed read, and does not try again a server no session landed on.
 * `stop()` waits for a read or an arming in flight: only then may the breakpoints be removed.
 */
export class GuiWatch {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly unreachable = new Set<string>();

  constructor(private readonly options: GuiWatchOptions) {
    if (options.missed) this.unreachable.add(options.missed.toUpperCase());
  }

  start(): void {
    this.schedule();
  }

  /** Reads and arms no more; resolves once what was in flight is done. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.check().then(
        (more) => {
          if (more) this.schedule();
        },
        () => undefined,
      );
    }, this.options.everyMs);
  }

  /** One read, and an arming when the latest logon moved; false: read no more. */
  private async check(): Promise<boolean> {
    const { conn, user, arming, warnings } = this.options;
    const options = { deadline: Date.now() + AHEAD_BUDGET_MS };
    let logons: GuiLogon[];
    try {
      logons = await readGuiLogons(conn.http, user, options);
    } catch (err) {
      warnings.push(
        `Stopped reading SAP user ${user}'s SAP GUI logons while the capture waited (${debuggerErrorText(err)}): a SAP GUI logon opened since may not stop.`,
      );
      return false;
    }
    if (this.stopped) return false;
    const [latest, ...others] = logons;
    if (!latest) return true;
    const key = latest.server.toUpperCase();
    if (key === arming.server?.toUpperCase()) {
      arming.others = others.map((logon) => logon.server);
      return true;
    }
    if (this.unreachable.has(key)) return true;
    let session: AdtHttpClient | undefined;
    let failure = '';
    try {
      session = await openArmingSessionOn(conn.http, this.options.ahead, latest.server, arming.armers, options);
    } catch (err) {
      failure = debuggerErrorText(err);
    }
    if (!session) {
      this.unreachable.add(key);
      warnings.push(
        failure
          ? `Could not open a session on application server ${latest.server}, where SAP user ${user} logged on to SAP GUI while the capture waited (${failure}): a SAP GUI run there may not stop.`
          : `No session landed on application server ${latest.server}, where SAP user ${user} logged on to SAP GUI while the capture waited, to arm the breakpoints from: a SAP GUI run there may not stop.`,
      );
      return true;
    }
    if (this.stopped) return false;
    try {
      const lost = await rearmFrom(session, this.options.identity, this.options.armed, this.options.armedIds);
      arming.server = latest.server;
      arming.others = others.map((logon) => logon.server);
      if (lost.length > 0) {
        warnings.push(`Armed again from application server ${latest.server}, SAP did not keep ${lost.join(', ')}.`);
      }
      this.options.onArmed?.(latest.server);
    } catch (err) {
      this.unreachable.add(key);
      warnings.push(
        `Could not arm the breakpoints again from application server ${latest.server} (${debuggerErrorText(err)}): a SAP GUI run there may not stop.`,
      );
    }
    return true;
  }
}

/** What `guiHint` says where a SAP GUI run stops. */
export interface GuiHintState {
  /** The user's SAP GUI server, when its session armed the breakpoints last. */
  armedServer?: string;
  /** The servers of the user's other SAP GUI logons. */
  others: readonly string[];
  /** SAP named more than one AS ABAP instance (`severalInstances`). */
  multiServer: boolean;
  /** ABAP_DEBUGGER_SAP_GUI_LOOKUP=false. */
  lookupOff?: boolean;
  /** The capture read the logons again while it waited (`GuiWatch`). */
  watched?: boolean;
}

/** For a trigger-"none" run that never stopped: where a SAP GUI run stops. */
export function guiHint(user: string, state: GuiHintState): string {
  if (state.armedServer) {
    const elsewhere =
      state.others.length > 0 ? `, not on ${state.others.join(', ')} where ${user} is logged on too` : '';
    return ` Run from SAP GUI, it stops reliably on application server ${state.armedServer} only (${user}'s latest SAP GUI logon, which armed the breakpoints last)${elsewhere}; System → Status in SAP GUI names the server.`;
  }
  if (!state.multiServer) return '';
  if (state.lookupOff) {
    return " With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last — not necessarily yours: this server does not look up the user's SAP GUI server (ABAP_DEBUGGER_SAP_GUI_LOOKUP=false).";
  }
  if (state.watched) {
    return ` With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last: the capture arms from the server of ${user}'s latest SAP GUI logon, read again every few seconds while it waits, and found no SAP GUI logon to arm from.`;
  }
  return ' With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last, which is the server of your SAP GUI only when the capture finds it: be logged on to SAP GUI when the capture starts.';
}

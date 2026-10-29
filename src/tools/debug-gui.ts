/**
 * SAP GUI runs on a system with several application servers (trigger "none"). External breakpoints
 * are the user's on every server, but a SAP GUI dialog run stops reliably only on the server where
 * they were armed last: arming switches debugging on for the user on that server alone (seen live on
 * S/4HANA). So the capture looks up the user's SAP GUI server — their latest SAP GUI logon — and arms
 * the breakpoints there, from a session SAP routes to that server; while it waits, it reads the logons
 * again and arms on a later logon's server (`GuiWatch`). HTTP runs (a Fiori app, Postman) stop on any
 * server either way. See docs/adt-debugger-protocol.md ("SAP GUI runs").
 *
 * Only where a SAP GUI can be: not on the BTP ABAP Environment, whose servers are pods, and unless
 * ABAP_DEBUGGER_SAP_GUI_LOOKUP=false.
 */

import {
  answeringServer,
  checkRoute,
  type DebugIdentity,
  debuggerErrorText,
  endSession,
  openRoutedSession,
} from '../adt/debugger.js';
import { type GuiLogon, readGuiLogons } from '../adt/gui-logons.js';
import type { AdtHttpClient, AdtRequestOptions } from '../adt/http.js';
import type { SapConnection } from './connection.js';
import { type ArmedBreakpoints, rearmFrom } from './debug-arm.js';
import { SETUP_BUDGET_MS } from './debug-limits.js';

/** Where the capture arms for the user's SAP GUI, and the session that does it. */
export interface GuiRoute {
  /** The user's SAP GUI server: their latest SAP GUI logon. */
  server: string;
  /** The servers of their other SAP GUI logons, latest first: a run there may not stop. */
  others: string[];
  /** A session SAP routes to `server`: the breakpoints are armed there, and removed there. */
  armer: AdtHttpClient;
}

/** What the SAP GUI lookup found before anything was armed. */
export interface GuiLookup {
  /** Where to arm; unset: from the stateless client, as without SAP GUI. */
  route?: GuiRoute;
  /** A SAP GUI can log on to this system: no BTP ABAP Environment pod answered. */
  possible: boolean;
  /** SAP answered the lookup: worth reading again while the capture waits. */
  readable: boolean;
  /** SAP refused the lookup (a warning says why). */
  failed?: boolean;
  /** The user's SAP GUI server no arming reached: not worth trying again. */
  unreachable?: string;
}

/**
 * An application server as SM51 names an AS ABAP instance, `<host>_<SID>_<instance number>` (e.g.
 * `sapdev01_DEV_00`): the kind SAP GUI logs on to. The BTP ABAP Environment's servers are pods
 * (`appserver-t4w2x`), and it has no SAP GUI.
 */
export function isInstanceName(server: string): boolean {
  return /^\S+_[A-Z][A-Z0-9]{2}_\d{2}$/i.test(server.trim());
}

/**
 * Can a SAP GUI log on to the system whose server answered as `server` (`answeringServer`)? An AS
 * ABAP instance, or its MD5-encoded name (is/instname_encoding = md5): yes; a BTP ABAP Environment pod:
 * no. Unknown — SAP did not say: maybe, so the lookup runs.
 */
export function sapGuiPossible(server: string | undefined): boolean {
  if (!server) return true;
  return isInstanceName(server) || /^[0-9a-f]{32}$/i.test(server);
}

/** A session to arm on `server`, once SAP showed it routes its requests there; else why not. */
async function openArmer(
  conn: SapConnection,
  server: string,
  options: AdtRequestOptions,
): Promise<{ armer: AdtHttpClient } | { failure: string }> {
  const armer = openRoutedSession(conn.http, server);
  let failure: string;
  try {
    const route = await checkRoute(armer, server, options);
    if (route.status !== 'failed' && route.status !== 'ignored') return { armer };
    failure =
      route.status === 'failed'
        ? `SAP could not reach it (${route.error})`
        : `SAP ran the request on ${route.ranOn} instead: this release does not forward ADT requests to another application server`;
  } catch (err) {
    failure = debuggerErrorText(err);
  }
  await endSession(armer, options);
  return { failure };
}

/**
 * The SAP GUI lookup of a capture whose run the user starts (trigger "none"), and where it arms. No
 * route — the capture arms from the stateless client, as before — on the BTP ABAP Environment (no SAP
 * GUI there), when the lookup is off, the user has no SAP GUI logon, or a step fails (a warning says
 * which, when it matters).
 */
export async function openGuiRoute(conn: SapConnection, user: string, warnings: string[]): Promise<GuiLookup> {
  const options = { deadline: Date.now() + SETUP_BUDGET_MS };
  const possible = sapGuiPossible(await answeringServer(conn.http, options));
  if (!possible || conn.sapGuiLookup === false) return { possible, readable: false };
  let logons: GuiLogon[];
  try {
    logons = await readGuiLogons(conn.http, user, options);
  } catch (err) {
    warnings.push(
      `Could not look up which application server runs SAP user ${user}'s SAP GUI (table USR41 through the ADT data preview: ${debuggerErrorText(err)}). On a system with several application servers a SAP GUI run then stops reliably only where the breakpoints were armed — not necessarily on yours.`,
    );
    return { possible, readable: false, failed: true };
  }
  const [latest, ...others] = logons;
  if (!latest) return { possible, readable: true };
  const opened = await openArmer(conn, latest.server, options);
  if ('failure' in opened) {
    warnings.push(
      `Could not arm the breakpoints on application server ${latest.server}, where SAP user ${user} is logged on to SAP GUI (${opened.failure}): a SAP GUI run there may not stop.`,
    );
    return { possible, readable: true, unreachable: latest.server };
  }
  return {
    possible,
    readable: true,
    route: { server: latest.server, others: others.map((logon) => logon.server), armer: opened.armer },
  };
}

/** Where the breakpoints are armed for the user's SAP GUI, kept up to date while the capture waits. */
export interface GuiArming {
  /** The user's SAP GUI server where the breakpoints were armed last; unset: none was. */
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
  armed: ArmedBreakpoints;
  /** The capture's cleanup list, kept up to date when SAP renumbers the breakpoints. */
  armedIds: string[];
  arming: GuiArming;
  /** The capture's SAP GUI warnings (reported when nothing stopped). */
  warnings: string[];
  /** A server the arming did not reach before (`GuiLookup.unreachable`): not tried again. */
  unreachable?: string;
  /** How long between two reads. */
  everyMs: number;
  /** The breakpoints were armed again on `server`. */
  onArmed?: (server: string) => void;
}

/**
 * While a trigger-"none" capture waits for its stop: reads the user's SAP GUI logons again every
 * `everyMs`, and when the latest is on another server than the one the breakpoints were armed on last,
 * arms them again there — so that a SAP GUI logon opened after the capture started stops too. Reads no
 * more after a failed read, and does not try again a server the arming did not reach. `stop()` waits
 * for a read or an arming in flight: only then may the breakpoints be removed.
 */
export class GuiWatch {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private readonly unreachable = new Set<string>();

  constructor(private readonly options: GuiWatchOptions) {
    if (options.unreachable) this.unreachable.add(options.unreachable.toUpperCase());
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
    const options = { deadline: Date.now() + SETUP_BUDGET_MS };
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
    let session = arming.armers.get(key);
    if (!session) {
      const opened = await openArmer(conn, latest.server, options);
      if ('failure' in opened) {
        this.unreachable.add(key);
        warnings.push(
          `Could not arm the breakpoints on application server ${latest.server}, where SAP user ${user} logged on to SAP GUI while the capture waited (${opened.failure}): a SAP GUI run there may not stop.`,
        );
        return true;
      }
      session = opened.armer;
      arming.armers.set(key, session);
    }
    if (this.stopped) return false;
    try {
      const lost = await rearmFrom(session, this.options.identity, this.options.armed, this.options.armedIds);
      arming.server = latest.server;
      arming.others = others.map((logon) => logon.server);
      if (lost.length > 0) {
        warnings.push(`Armed again on application server ${latest.server}, SAP did not keep ${lost.join(', ')}.`);
      }
      this.options.onArmed?.(latest.server);
    } catch (err) {
      this.unreachable.add(key);
      warnings.push(
        `Could not arm the breakpoints again on application server ${latest.server} (${debuggerErrorText(err)}): a SAP GUI run there may not stop.`,
      );
    }
    return true;
  }
}

/** What `guiHint` says where a SAP GUI run stops. */
export interface GuiHintState {
  /** The user's SAP GUI server, when the breakpoints were armed there last. */
  armedServer?: string;
  /** The servers of the user's other SAP GUI logons. */
  others: readonly string[];
  /** A SAP GUI can log on to this system (`GuiLookup.possible`). */
  possible: boolean;
  /** ABAP_DEBUGGER_SAP_GUI_LOOKUP=false. */
  lookupOff?: boolean;
  /** SAP refused the lookup (`GuiLookup.failed`). */
  unreadable?: boolean;
  /** The capture read the logons again while it waited (`GuiWatch`). */
  watched?: boolean;
}

/** For a trigger-"none" run that never stopped: where a SAP GUI run stops. */
export function guiHint(user: string, state: GuiHintState): string {
  if (state.armedServer) {
    const elsewhere =
      state.others.length > 0 ? `, not on ${state.others.join(', ')} where ${user} is logged on too` : '';
    return ` Run from SAP GUI, it stops reliably on application server ${state.armedServer} only (${user}'s latest SAP GUI logon, where the capture armed the breakpoints)${elsewhere}; System → Status in SAP GUI names the server.`;
  }
  if (!state.possible) return '';
  if (state.lookupOff) {
    return " On a system with several application servers, a SAP GUI run stops reliably only on the one where the breakpoints were armed — not necessarily yours: this server does not look up the user's SAP GUI server (ABAP_DEBUGGER_SAP_GUI_LOOKUP=false).";
  }
  if (state.unreadable) {
    return ' On a system with several application servers, a SAP GUI run stops reliably only on the one where the breakpoints were armed: the capture could not look up your SAP GUI server to arm there (see the warnings).';
  }
  if (state.watched) {
    return ` Run from SAP GUI, it stops on the server of ${user}'s latest SAP GUI logon, where the capture arms the breakpoints — it read the logons again every few seconds while it waited, and found none: log on to SAP GUI as ${user} while the capture waits.`;
  }
  return ' On a system with several application servers, a SAP GUI run stops reliably only on the one where the breakpoints were armed, which is the server of your SAP GUI only when the capture finds it: be logged on to SAP GUI when the capture starts.';
}

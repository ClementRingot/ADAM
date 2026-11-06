/**
 * Several SAP systems from one deployment (SAP_BTP_DESTINATIONS=S4D_PP,S4Q_PP). Each destination
 * gets its own MCP route, `/<SID>/<client>/mcp`, from its `sap-sysid` and `sap-client` properties:
 * a connector is then one system, chosen by the person who adds it. The tools keep their schemas
 * and no call names a target, so the model cannot arm breakpoints — or hold a work process — on QAS
 * when it meant DEV.
 *
 * Only destinations that log each user on as themselves serve here; one for a system and client
 * another destination already names is refused, as both are. A destination that fails leaves the
 * others working: it is looked up again on demand (at most every 30 s) until it serves, and its
 * route — once known — says why it does not.
 */

import {
  type BTPConfig,
  type Destination,
  lookupDestination,
  lookupDestinationWithUserToken,
} from '@arc-mcp/xsuaa-auth/btp';
import type { HttpSap, HttpSystems, SystemOverview } from '../http-server.js';
import { logger } from '../logger.js';
import { BtpConnections, boundBtp, btpLogger, type ConnectionSettings, checkBtpTarget } from './connections.js';

/** A destination that does not serve is looked up again at most this often. */
export const RETRY_MS = 30_000;

const SID = /^[A-Z][A-Z0-9]{2}$/;
const CLIENT = /^\d{3}$/;

/** The MCP route of a system: `/S4D/100/mcp`. */
export const routePath = (sid: string, client: string): string => `/${sid}/${client}/mcp`;

/** Whether a request path's segments can name a system at all (else: not one of these routes). */
export function isSystemRoute(sid: string, client: string): boolean {
  return SID.test(sid.toUpperCase()) && CLIENT.test(client);
}

/** The system and client a destination names (its `sap-sysid` and `sap-client` properties), or why it names none. */
export function systemOf(destination: Destination): { sid: string; client: string } | { problem: string } {
  const properties = destination.originalProperties ?? {};
  const rawSid = properties['sap-sysid'];
  const sid = typeof rawSid === 'string' ? rawSid.trim().toUpperCase() : '';
  const rawClient = destination['sap-client'] ?? properties['sap-client'];
  const client = typeof rawClient === 'string' ? rawClient.trim() : '';
  const missing = [
    ...(SID.test(sid) ? [] : [`sap-sysid (the system ID, e.g. S4D${sid ? `; got "${sid}"` : ''})`]),
    ...(CLIENT.test(client) ? [] : [`sap-client (three digits, e.g. 100${client ? `; got "${client}"` : ''})`]),
  ];
  if (missing.length > 0) {
    return {
      problem: `Destination ${destination.Name} names no system for its MCP route /<SID>/<client>/mcp: add the additional propert${missing.length > 1 ? 'ies' : 'y'} ${missing.join(' and ')} to it.`,
    };
  }
  return { sid, client };
}

interface DestinationState {
  name: string;
  /** Once the destination named its system. */
  sid?: string;
  client?: string;
  /** How its route serves the MCP users, once it can. */
  serving?: HttpSap;
  /** Why it does not serve. */
  problem: string;
  /** When it was last looked up (0: never). */
  triedAt: number;
}

export class BtpSystems implements HttpSystems {
  private readonly states: DestinationState[];
  private refreshing: Promise<void> | undefined;
  private started: Promise<void> | undefined;

  constructor(
    names: readonly string[],
    private readonly settings: ConnectionSettings,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly lookup: typeof lookupDestination = lookupDestination,
    private readonly lookupForUser: typeof lookupDestinationWithUserToken = lookupDestinationWithUserToken,
  ) {
    this.states = names.map((name) => ({ name, problem: `Destination ${name} was not looked up yet.`, triedAt: 0 }));
  }

  /** Look up every destination: at startup, before the first route is served. */
  start(): Promise<void> {
    this.started ??= this.refresh();
    return this.started;
  }

  /** Look up again each destination that does not serve and was not tried in the last RETRY_MS. */
  refresh(): Promise<void> {
    this.refreshing ??= this.lookUpDue().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async route(sid: string, client: string): Promise<HttpSap | undefined> {
    await this.start();
    const wanted = sid.toUpperCase();
    const found = this.find(wanted, client);
    if (found && found.problems.length === 0) return found;
    await this.refresh();
    return this.find(wanted, client);
  }

  async overview(): Promise<SystemOverview[]> {
    await this.start();
    await this.refresh();
    return this.states.map((state) => {
      const problem = this.problemOf(state);
      return {
        destination: state.name,
        ...(state.sid && state.client ? { route: routePath(state.sid, state.client) } : {}),
        ...(problem ? { problem } : {}),
      };
    });
  }

  /** Why `state` serves nobody, its duplicates included; undefined: it serves. */
  private problemOf(state: DestinationState): string | undefined {
    if (state.sid && state.client) {
      const same = this.states.filter((other) => other.sid === state.sid && other.client === state.client);
      if (same.length > 1) {
        return `Destinations ${same.map((other) => other.name).join(' and ')} all reach system ${state.sid} client ${state.client}: keep one of them in SAP_BTP_DESTINATIONS.`;
      }
    }
    return state.serving ? undefined : state.problem;
  }

  private find(sid: string, client: string): HttpSap | undefined {
    const state = this.states.find((candidate) => candidate.sid === sid && candidate.client === client);
    if (!state) return undefined;
    const problem = this.problemOf(state);
    if (problem) return { problems: [problem] };
    return state.serving;
  }

  private async lookUpDue(): Promise<void> {
    const now = Date.now();
    const due = this.states.filter((state) => !state.serving && now - state.triedAt >= RETRY_MS);
    await Promise.all(due.map((state) => this.lookUp(state)));
  }

  private async lookUp(state: DestinationState): Promise<void> {
    state.triedAt = Date.now();
    let btp: BTPConfig;
    let destination: Destination;
    try {
      btp = boundBtp(this.env, 'SAP_BTP_DESTINATIONS');
      destination = await this.lookup(btp, state.name, btpLogger);
    } catch (err) {
      // The route stays where it was: it keeps saying why.
      state.problem = `Destination ${state.name} cannot be looked up: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(state.problem);
      return;
    }
    const system = systemOf(destination);
    if ('problem' in system) {
      delete state.sid;
      delete state.client;
      state.problem = system.problem;
      logger.warn(state.problem);
      return;
    }
    state.sid = system.sid;
    state.client = system.client;
    try {
      const target = checkBtpTarget(btp, state.name, destination, { allowSharedUser: false, severalSystems: true });
      const connections = new BtpConnections(target, this.settings, this.lookupForUser);
      const sapGui = this.settings.sapGui ?? destination.ProxyType === 'OnPremise';
      state.serving = { problems: [], sapGui, connect: (authInfo, owner) => connections.connect(authInfo, owner) };
      logger.info(`Serving destination ${state.name} at ${routePath(system.sid, system.client)}`);
    } catch (err) {
      state.problem = err instanceof Error ? err.message : String(err);
      logger.warn(state.problem);
    }
  }
}

/**
 * SAP connections on SAP BTP. The Destination Service names the system; each MCP user reaches it as
 * their own SAP user — principal propagation through the Cloud Connector, a user token for the
 * BTP ABAP Environment, or a SAML assertion — so each debugs their own runs. A destination with one
 * technical identity (BasicAuthentication) would make every user debug as the
 * same SAP user and catch each other's runs: it is refused unless the administrator allows it.
 *
 * Destination lookups, per-user token exchange and the Connectivity proxy descriptor come from
 * @arc-mcp/xsuaa-auth/btp (extracted from ARC-1); this module applies them to the ADT client.
 */

import type { AuthInfo } from '@arc-mcp/xsuaa-auth';
import {
  type BTPConfig,
  createConnectivityProxy,
  type Destination,
  lookupDestination,
  lookupDestinationWithUserToken,
  type PerUserAuthTokens,
  parseVCAPServices,
} from '@arc-mcp/xsuaa-auth/btp';
import { AdtHttpClient, connectivityDispatcher, type DispatcherSource } from '../adt/http.js';
import { logger } from '../logger.js';
import type { SapConnection } from '../tools/connection.js';
import type { DebugLimits } from '../tools/debug-limits.js';

/** Destination authentications that log each user on as themselves. */
const PER_USER = new Set([
  'PrincipalPropagation',
  'OAuth2UserTokenExchange',
  'OAuth2SAMLBearerAssertion',
  'OAuth2JWTBearer',
  'SAMLAssertion',
]);
/** One technical identity for everybody: allowed only on request (ABAP_DEBUGGER_ALLOW_SHARED_USER). */
const SHARED = new Set(['BasicAuthentication']);
/** A user's connection (cookies, CSRF token) is dropped after this long without a call. */
const USER_IDLE_MS = 60 * 60 * 1000;

/** The logger the package expects: `(message, data?)`. */
export const btpLogger = {
  debug: (message: string, data?: Record<string, unknown>) => logger.debug(message, data),
  info: (message: string, data?: Record<string, unknown>) => logger.info(message, data),
  warn: (message: string, data?: Record<string, unknown>) => logger.warn(message, data),
  error: (message: string, data?: Record<string, unknown>) => logger.error(message, data),
};

/** The SAP system a deployment debugs, as its destination describes it at startup. */
export interface BtpTarget {
  btp: BTPConfig;
  name: string;
  destination: Destination;
  /** Each user logs on as themselves (else: one shared technical identity). */
  perUser: boolean;
}

export interface BtpTargetOptions {
  /** ABAP_DEBUGGER_ALLOW_SHARED_USER: accept a destination with one technical identity. */
  allowSharedUser: boolean;
}

/**
 * Look the destination up once at startup and check it can serve a debugger: an identity per user
 * (or a shared one the administrator allowed), and for an on-premise system an `http://` virtual
 * host behind a bound Connectivity service.
 */
export async function resolveBtpTarget(
  name: string,
  options: BtpTargetOptions,
  env: NodeJS.ProcessEnv = process.env,
  lookup: typeof lookupDestination = lookupDestination,
): Promise<BtpTarget> {
  const btp = parseVCAPServices(env, btpLogger);
  if (!btp) {
    throw new Error(
      `SAP_BTP_DESTINATION=${name} needs the Destination service bound to this app (and the Connectivity service for an on-premise system): VCAP_SERVICES has no such binding.`,
    );
  }
  const destination = await lookup(btp, name, btpLogger);
  const authentication = destination.Authentication;
  const perUser = PER_USER.has(authentication);
  if (!perUser && !SHARED.has(authentication)) {
    throw new Error(
      `Destination ${name} uses ${authentication || 'no'} authentication; a debugger needs PrincipalPropagation (on-premise, Cloud Connector), OAuth2UserTokenExchange or OAuth2SAMLBearerAssertion (BTP ABAP Environment), or SAMLAssertion.`,
    );
  }
  if (!perUser && !options.allowSharedUser) {
    throw new Error(
      `Destination ${name} uses ${authentication}: every user would debug as one SAP user and could catch each other's runs. Use a PrincipalPropagation destination, or set ABAP_DEBUGGER_ALLOW_SHARED_USER=true for a deployment a single person uses.`,
    );
  }
  if (destination.ProxyType === 'OnPremise') {
    if (!destination.URL.startsWith('http://')) {
      throw new Error(
        `Destination ${name} is on-premise but its URL is not http:// (${destination.URL}): the Connectivity proxy forwards plain HTTP to the Cloud Connector, which can still reach the system over HTTPS. Use the Cloud Connector's virtual host with http://.`,
      );
    }
    if (!btp.connectivityProxyHost) {
      throw new Error(
        `Destination ${name} is on-premise: bind the Connectivity service to this app so requests reach the Cloud Connector.`,
      );
    }
  }
  if (!perUser) {
    logger.warn(
      `Destination ${name} uses ${authentication}: every MCP user debugs as SAP user ${destination.User || '(technical)'} (ABAP_DEBUGGER_ALLOW_SHARED_USER).`,
    );
  }
  return { btp, name, destination, perUser };
}

/** The identity headers per-user tokens become; one of them, by the destination's authentication. */
export function identityHeaders(tokens: PerUserAuthTokens, name: string): Record<string, string> {
  if (tokens.sapConnectivityAuth) return { 'SAP-Connectivity-Authentication': tokens.sapConnectivityAuth };
  if (tokens.bearerToken) return { Authorization: `Bearer ${tokens.bearerToken}` };
  if (tokens.samlAssertionAuthorization) {
    return { Authorization: tokens.samlAssertionAuthorization, 'x-sap-security-session': 'create' };
  }
  throw new Error(
    `Destination ${name} returned no identity for this user (no SAP-Connectivity-Authentication, user token or SAML assertion): check the Cloud Connector's principal propagation, the destination and that you signed in through OAuth.`,
  );
}

/** A stable key for the calling MCP user: their XSUAA user (zone + id), else the OAuth client or API key. */
export function ownerOf(authInfo: AuthInfo | undefined): string {
  const token = authInfo?.token;
  const parts = token?.split('.') ?? [];
  if (parts.length === 3) {
    try {
      // The bearer middleware verified the token; only its claims are read here.
      const claims = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const user = claims.user_uuid ?? claims.user_id ?? claims.sub;
      if (typeof user === 'string' && user) return `user:${typeof claims.zid === 'string' ? claims.zid : ''}:${user}`;
    } catch {
      // not a JWT after all: fall back to the client
    }
  }
  return `client:${authInfo?.clientId ?? 'anonymous'}`;
}

export interface ConnectionSettings {
  language: string;
  limits: DebugLimits;
  abapRelease?: string;
}

/**
 * The calling user's SAP connection. Each user keeps one ADT client (cookies, CSRF token) whose
 * identity headers are renewed on every call from their current token, so an interactive session
 * started earlier keeps working with the user's latest identity.
 */
export class BtpConnections {
  private readonly users = new Map<
    string,
    { conn: SapConnection; identity: { headers: Record<string, string> }; lastUsed: number }
  >();
  private shared: SapConnection | undefined;
  private readonly dispatcher: DispatcherSource | undefined;

  constructor(
    private readonly target: BtpTarget,
    private readonly settings: ConnectionSettings,
    private readonly lookupForUser: typeof lookupDestinationWithUserToken = lookupDestinationWithUserToken,
  ) {
    const { destination, btp } = target;
    const proxy =
      destination.ProxyType === 'OnPremise'
        ? createConnectivityProxy(btp, destination.CloudConnectorLocationId, btpLogger)
        : null;
    // One pool to the Connectivity proxy for every user: each request carries its own identity.
    this.dispatcher = proxy ? connectivityDispatcher(proxy) : undefined;
  }

  private client(destination: Destination, auth: { authHeaders?: () => Promise<Record<string, string>> }) {
    const client = destination['sap-client'];
    return new AdtHttpClient(
      {
        baseUrl: destination.URL,
        ...(client ? { client } : {}),
        language: this.settings.language,
        ...auth,
        ...(auth.authHeaders ? {} : { username: destination.User, password: destination.Password }),
      },
      this.dispatcher,
    );
  }

  private connection(http: AdtHttpClient, logonUser?: string): SapConnection {
    return {
      http,
      ...(logonUser ? { logonUser } : {}),
      ...(this.settings.abapRelease ? { abapRelease: this.settings.abapRelease } : {}),
      limits: this.settings.limits,
    };
  }

  async connect(authInfo: AuthInfo | undefined, owner: string): Promise<SapConnection> {
    if (!this.target.perUser) {
      // One technical identity: the destination's user, who is then also the logon user.
      this.shared ??= this.connection(this.client(this.target.destination, {}), this.target.destination.User);
      return this.shared;
    }
    const token = authInfo?.token ?? '';
    if (token.split('.').length !== 3) {
      throw new Error(
        `Destination ${this.target.name} logs each user on as themselves, which needs your XSUAA user token: connect through OAuth (an API key names no SAP user).`,
      );
    }
    const { destination, authTokens } = await this.lookupForUser(this.target.btp, this.target.name, token, btpLogger);
    const headers = identityHeaders(authTokens, this.target.name);
    const now = Date.now();
    for (const [key, entry] of this.users) if (now - entry.lastUsed > USER_IDLE_MS) this.users.delete(key);
    let entry = this.users.get(owner);
    if (!entry) {
      const identity = { headers };
      const http = this.client(destination, { authHeaders: async () => identity.headers });
      entry = { conn: this.connection(http), identity, lastUsed: now };
      this.users.set(owner, entry);
    }
    entry.identity.headers = headers;
    entry.lastUsed = now;
    return entry.conn;
  }
}

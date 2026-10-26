/**
 * Minimal ADT HTTP client — what the debugger needs and nothing more: CSRF tokens, cookies,
 * stateful sessions (`sap-contextid`) with SAP's close-session request, request deadlines, and
 * Basic, cookie or Bearer (BTP ABAP Environment) authentication.
 *
 * No transient replays (503, 429, a broken DB connection) and no content negotiation: a debugger
 * POST — a step, a continue — must never be sent twice. The only resends are of requests SAP refused
 * before running anything: an expired session (401) and a stale CSRF token (403 "Required").
 *
 * On SAP BTP the identity comes per user from the Destination Service (`authHeaders`), and an
 * on-premise system is reached through the Connectivity proxy (`connectivityProxy`).
 */

import { Agent, type Dispatcher, fetch, ProxyAgent } from 'undici';
import { logger } from '../logger.js';
import { VERSION } from '../version.js';
import { resolveCookies } from './cookies.js';
import { AdtApiError, AdtNetworkError } from './errors.js';

export type SessionType = 'stateful' | 'stateless';

/** A valid OAuth access token; `forceRefresh` once SAP rejected the cached one. */
export type BearerTokenProvider = (options?: { forceRefresh?: boolean }) => Promise<string>;

/**
 * The BTP Connectivity proxy to an on-premise system behind the Cloud Connector. It speaks plain
 * HTTP forward proxying only (it refuses CONNECT), so the system's URL must be `http://`.
 */
export interface ConnectivityProxy {
  protocol: string;
  host: string;
  port: number;
  /** A valid Connectivity-service token (the caller caches and refreshes it). */
  getProxyToken: () => Promise<string>;
  /** Cloud Connector location id (`SAP-Connectivity-SCC-Location_ID`). */
  locationId?: string;
}

/** Where a request's connection pool comes from: fixed, or chosen per request (a proxy token that expires). */
export type DispatcherSource = Dispatcher | (() => Promise<Dispatcher>);

export interface AdtHttpConfig {
  baseUrl: string;
  client?: string;
  language?: string;
  username?: string;
  password?: string;
  /** Static authentication cookies (SAP_COOKIE_FILE / SAP_COOKIE_STRING). */
  cookies?: Record<string, string>;
  /** Re-read on a 401, so a refreshed cookie file works without a restart. */
  cookieFile?: string;
  cookieString?: string;
  /** BTP ABAP Environment: `Authorization: Bearer`, replacing Basic auth. */
  bearerTokenProvider?: BearerTokenProvider;
  /**
   * The user's identity headers for each request, from the BTP Destination Service: principal
   * propagation (`SAP-Connectivity-Authentication`), a user token (`Authorization: Bearer`) or a
   * SAML assertion. Replaces every other authentication.
   */
  authHeaders?: () => Promise<Record<string, string>>;
  /** SAP BTP: reach an on-premise system through the Connectivity proxy (Cloud Connector). */
  connectivityProxy?: ConnectivityProxy;
  /** Corporate proxy every request goes through (`http://user:password@proxy:8080`); HTTPS is tunnelled. */
  proxy?: string;
  /** Skip TLS certificate verification (test systems with self-signed certificates only). */
  insecure?: boolean;
  /** Ask SAP not to answer with a SAML redirect (SSO systems reached with Basic auth). */
  disableSaml?: boolean;
  sessionType?: SessionType;
}

export interface AdtRequestOptions {
  signal?: AbortSignal;
  /** Epoch milliseconds no request may outlive. */
  deadline?: number;
  /** Cap for this one fetch (default 120 s); a long poll or a trigger sets its own. */
  fetchTimeoutMs?: number;
  /** An optional resource: its 404 is expected and logged at debug level only. */
  suppressNotFoundLog?: boolean;
}

export interface AdtResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_FETCH_TIMEOUT_MS = 120_000;
const MODIFYING = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const CORE_DISCOVERY = '/sap/bc/adt/core/discovery';
const LEGACY_DISCOVERY = '/sap/bc/adt/discovery';

export class AdtHttpClient {
  private readonly config: AdtHttpConfig;
  private readonly dispatcher: DispatcherSource;
  private csrfToken = '';
  /** Cookies SAP set (session ids, `sap-contextid`); they win over the static ones on a name clash. */
  private cookieJar = new Map<string, string>();

  constructor(config: AdtHttpConfig, dispatcher?: DispatcherSource) {
    this.config = { ...config };
    this.dispatcher =
      dispatcher ??
      (config.connectivityProxy ? connectivityDispatcher(config.connectivityProxy) : createDispatcher(config));
  }

  async get(path: string, headers?: Record<string, string>, options?: AdtRequestOptions): Promise<AdtResponse> {
    return this.request('GET', path, undefined, undefined, headers, options);
  }

  async head(path: string, headers?: Record<string, string>, options?: AdtRequestOptions): Promise<AdtResponse> {
    return this.request('HEAD', path, undefined, undefined, headers, options);
  }

  async post(
    path: string,
    body?: string,
    contentType?: string,
    headers?: Record<string, string>,
    options?: AdtRequestOptions,
  ): Promise<AdtResponse> {
    return this.request('POST', path, body, contentType, headers, options);
  }

  async delete(path: string, headers?: Record<string, string>, options?: AdtRequestOptions): Promise<AdtResponse> {
    return this.request('DELETE', path, undefined, undefined, headers, options);
  }

  /**
   * A new stateful session: SAP pins it to one application context (`sap-contextid`) on one
   * application server. It shares this client's CSRF token and login cookies, never its context.
   * The caller owns it and ends it with `endStatefulSession()`.
   */
  openStatefulSession(): AdtHttpClient {
    const session = new AdtHttpClient({ ...this.config, sessionType: 'stateful' }, this.dispatcher);
    session.csrfToken = this.csrfToken;
    session.cookieJar = new Map(this.cookieJar);
    session.cookieJar.delete('sap-contextid');
    return session;
  }

  /** The session's `sap-contextid` cookie (`SID:ANON:<application server>:<id>`, URL-encoded), if SAP set one. */
  get sessionContextId(): string | undefined {
    return this.cookieJar.get('sap-contextid');
  }

  /**
   * End a session from `openStatefulSession()` the way Eclipse ADT does: the dedicated close request
   * on its own context. Never throws — a session SAP did not close lives until its session timeout.
   * True = closed, false = SAP refused, undefined = there was no context to close.
   */
  async endStatefulSession(options?: AdtRequestOptions): Promise<boolean | undefined> {
    const contextId = this.cookieJar.get('sap-contextid');
    if (!contextId || contextId === '0') return undefined;
    // Eclipse switches the context to stateless while it sends the close request.
    this.config.sessionType = 'stateless';
    try {
      try {
        await this.get(
          '/sap/bc/adt/core/http/sessions',
          { Accept: '*/*', 'sap-adt-purpose': 'close-session', 'sap-contextid': contextId },
          options,
        );
        return true;
      } catch (err) {
        if (!(err instanceof AdtApiError && err.statusCode === 404)) throw err;
      }
      // NW 7.50 lacks the close resource; there a stateless request on the context closes it.
      await this.head(CORE_DISCOVERY, { Accept: '*/*' }, options);
      return true;
    } catch (err) {
      // NW 7.50 can answer 400 after closing; the reset cookie confirms it did.
      if (this.cookieJar.get('sap-contextid') === '0') return true;
      logger.debug('Could not close a stateful ADT session', {
        statusCode: err instanceof AdtApiError ? err.statusCode : undefined,
      });
      return false;
    }
  }

  private async request(
    method: string,
    path: string,
    body: string | undefined,
    contentType: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    options: AdtRequestOptions | undefined,
  ): Promise<AdtResponse> {
    throwIfCancelled(options);
    try {
      return await this.send(method, path, body, contentType, extraHeaders, options);
    } catch (err) {
      if (err instanceof AdtApiError) {
        logger.debug('ADT request failed', { method, path: path.split('?', 1)[0], statusCode: err.statusCode });
        throw err;
      }
      if (err instanceof AdtNetworkError) throw err;
      if (options?.signal?.aborted) throw cancelledError(options.signal);
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new AdtNetworkError(networkReason(cause), cause);
    }
  }

  private async send(
    method: string,
    path: string,
    body: string | undefined,
    contentType: string | undefined,
    extraHeaders: Record<string, string> | undefined,
    options: AdtRequestOptions | undefined,
  ): Promise<AdtResponse> {
    const modifying = MODIFYING.has(method);
    if (modifying && !this.csrfToken) await this.fetchCsrfToken(options);

    const headers: Record<string, string> = { Accept: '*/*', ...extraHeaders };
    if (this.config.disableSaml) headers['X-SAP-SAML2'] = 'disabled';
    if (this.config.sessionType) headers['X-sap-adt-sessiontype'] = this.config.sessionType;
    if (contentType) headers['Content-Type'] = contentType;
    await this.applyAuth(headers);
    this.applySession(method, headers);
    const url = this.buildUrl(path);

    let response = await this.fetchOnce(url, method, headers, body, options);
    let text = await response.text();

    if (response.status === 401) {
      // Rejected before anything ran: renew the session (and the cookies or token) once, then resend.
      this.resetSession();
      if (this.config.cookieFile) this.reloadCookies();
      await this.applyAuth(headers, true);
      if (modifying) await this.fetchCsrfToken(options);
      this.applySession(method, headers);
      response = await this.fetchOnce(url, method, headers, body, options);
      text = await response.text();
    }

    if (modifying && response.status === 403 && csrfRejected(response, text)) {
      await this.fetchCsrfToken(options);
      this.applySession(method, headers);
      response = await this.fetchOnce(url, method, headers, body, options);
      text = await response.text();
    }

    return this.handleResponse(response.status, response.headers, text, path);
  }

  private handleResponse(status: number, headers: Headers, body: string, path: string): AdtResponse {
    const contentType = headers.get('content-type')?.toLowerCase() ?? '';
    const discovery = [CORE_DISCOVERY, LEGACY_DISCOVERY].includes(path.split('?', 1)[0] ?? '');
    if (
      status === 200 &&
      path.startsWith('/sap/bc/adt/') &&
      (contentType.startsWith('text/html') || discovery) &&
      looksLikeLoginPage(body)
    ) {
      throw new AdtApiError(
        'SAP answered with its logon page: authentication is required. Check SAP_USER/SAP_PASSWORD, refresh the cookies, or set SAP_DISABLE_SAML=true on a system that redirects to SAML single sign-on.',
        401,
        path,
        body.slice(0, 500),
      );
    }
    if (status >= 400) throw new AdtApiError(body, status, path, body);
    const flat: Record<string, string> = {};
    for (const [key, value] of headers.entries()) flat[key] = value;
    return { statusCode: status, headers: flat, body };
  }

  /** Core discovery first (HEAD, then GET), the legacy discovery where the core one is missing. */
  private async fetchCsrfToken(options: AdtRequestOptions | undefined): Promise<void> {
    let path = CORE_DISCOVERY;
    const headers: Record<string, string> = { 'X-CSRF-Token': 'fetch', Accept: '*/*' };
    if (this.config.sessionType) headers['X-sap-adt-sessiontype'] = this.config.sessionType;
    if (this.config.disableSaml) headers['X-SAP-SAML2'] = 'disabled';
    await this.applyAuth(headers);

    const probe = async (method: 'HEAD' | 'GET') => {
      this.applyCookies(headers);
      const response = await this.fetchOnce(this.buildUrl(path), method, headers, undefined, options);
      if (method === 'GET' && response.status === 200 && !usableCsrfToken(response)) {
        // A logon page instead of the discovery document: say so instead of "no token".
        this.handleResponse(response.status, response.headers, await response.text(), path);
      }
      if (!response.bodyUsed) await response.body?.cancel();
      return response;
    };

    let response = await probe('HEAD');
    const headStatus = response.status;
    // Several releases answer the HEAD with 400/403/405, or without a token; GET then works.
    if ([400, 403, 405].includes(response.status) || (response.ok && !usableCsrfToken(response))) {
      response = await probe('GET');
    }
    // Some routes refuse both stateful probes: fetch the token without the session header once.
    if (this.config.sessionType === 'stateful' && headStatus === 400 && response.status === 400) {
      delete headers['X-sap-adt-sessiontype'];
      response = await probe('GET');
    }
    if (response.status === 404 || response.status === 405 || (response.ok && !usableCsrfToken(response))) {
      path = LEGACY_DISCOVERY;
      response = await probe('GET');
    }

    const token = usableCsrfToken(response);
    if (token) {
      this.csrfToken = token;
      return;
    }
    const client = this.config.client ? ` (sap-client=${this.config.client})` : '';
    if (response.status === 401) {
      throw new AdtApiError(
        `Authentication failed (401)${client}. Check SAP_USER and SAP_PASSWORD, the cookies, or the BTP login.`,
        401,
        path,
      );
    }
    if (response.status === 403) {
      throw new AdtApiError(
        `Access forbidden (403)${client}. The user lacks ADT authorizations (S_ADT_RES).`,
        403,
        path,
      );
    }
    throw new AdtApiError(`No CSRF token in the response (HTTP ${response.status}).`, response.status, path);
  }

  private async fetchOnce(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    options: AdtRequestOptions | undefined,
  ): Promise<Response> {
    throwIfCancelled(options);
    const response = (await fetch(url, {
      method,
      headers: { ...headers, 'User-Agent': `abap-debugger-mcp/${VERSION}` },
      body,
      signal: requestSignal(options),
      dispatcher: typeof this.dispatcher === 'function' ? await this.dispatcher() : this.dispatcher,
    })) as unknown as Response;
    this.storeCookies(response);
    // Any answer may renew the token; a fetch probe's token counts only when the probe succeeded.
    const token = response.headers.get('x-csrf-token');
    if (headers['X-CSRF-Token'] !== 'fetch' && token && token.toLowerCase() !== 'required') this.csrfToken = token;
    return response;
  }

  private async applyAuth(headers: Record<string, string>, forceRefresh = false): Promise<void> {
    if (this.config.authHeaders) {
      Object.assign(headers, await this.config.authHeaders());
    } else if (this.config.bearerTokenProvider) {
      headers.Authorization = `Bearer ${await this.config.bearerTokenProvider({ forceRefresh })}`;
    } else if (this.config.username && this.config.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`;
    }
  }

  /** The CSRF token and the cookies, read together: SAP binds the token to the session cookie. */
  private applySession(method: string, headers: Record<string, string>): void {
    if (MODIFYING.has(method)) headers['X-CSRF-Token'] = this.csrfToken;
    this.applyCookies(headers);
  }

  private applyCookies(headers: Record<string, string>): void {
    const merged = new Map(Object.entries(this.config.cookies ?? {}));
    for (const [name, value] of this.cookieJar) merged.set(name, value);
    if (merged.size === 0) delete headers.Cookie;
    else headers.Cookie = [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private storeCookies(response: Response): void {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private resetSession(): void {
    this.cookieJar.clear();
    this.csrfToken = '';
  }

  private reloadCookies(): void {
    try {
      const fresh = resolveCookies(this.config.cookieFile, this.config.cookieString);
      if (fresh && Object.keys(fresh).length > 0) this.config.cookies = fresh;
    } catch (err) {
      logger.warn('Could not reload the cookie file', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private buildUrl(path: string): string {
    const url = new URL(this.config.baseUrl.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`));
    if (this.config.client) url.searchParams.set('sap-client', this.config.client);
    if (this.config.language) url.searchParams.set('sap-language', this.config.language);
    if (this.config.disableSaml) url.searchParams.set('saml2', 'disabled');
    return url.toString();
  }
}

/**
 * The connection pool every request (and the BTP token requests) goes through. No undici header or
 * body timeouts: each request carries its own deadline (requestSignal), and a trigger may legitimately
 * wait longer than undici's 300 s default while the debugger holds it. Behind a proxy, HTTPS runs
 * through a CONNECT tunnel and `insecure` applies to the SAP certificate inside it.
 */
export function createDispatcher(config: Pick<AdtHttpConfig, 'proxy' | 'insecure'>): Dispatcher {
  const timeouts = { headersTimeout: 0, bodyTimeout: 0 };
  const lenient = { rejectUnauthorized: false };
  if (config.proxy) {
    return new ProxyAgent({ uri: config.proxy, ...timeouts, ...(config.insecure ? { requestTls: lenient } : {}) });
  }
  return new Agent({ ...timeouts, ...(config.insecure ? { connect: lenient } : {}) });
}

/**
 * The Connectivity proxy's pool: standard HTTP forward proxying (undici's ProxyAgent does that for
 * an `http:` target), with the current token as Proxy-Authorization — a new agent once the token
 * changes, the previous one closed after its requests.
 */
export function connectivityDispatcher(proxy: ConnectivityProxy): () => Promise<Dispatcher> {
  let current: { token: string; agent: ProxyAgent } | undefined;
  return async () => {
    const token = await proxy.getProxyToken();
    if (current?.token !== token) {
      const previous = current;
      current = {
        token,
        agent: new ProxyAgent({
          uri: `${proxy.protocol}://${proxy.host}:${proxy.port}`,
          token: `Bearer ${token}`,
          ...(proxy.locationId ? { headers: { 'SAP-Connectivity-SCC-Location_ID': proxy.locationId } } : {}),
          headersTimeout: 0,
          bodyTimeout: 0,
        }),
      };
      previous?.agent.close().catch(() => undefined);
    }
    return current.agent;
  };
}

/** A token on a failed answer proves nothing; `Required` is SAP asking for one. */
function usableCsrfToken(response: Response): string | undefined {
  const token = response.headers.get('x-csrf-token')?.trim();
  return response.ok && token && token.toLowerCase() !== 'required' ? token : undefined;
}

function csrfRejected(response: Response, body: string): boolean {
  return (
    response.headers.get('x-csrf-token')?.trim().toLowerCase() === 'required' ||
    /csrf token validation failed/i.test(body)
  );
}

/** A full HTML document or a logon form — not the HTML fragments some ADT resources answer with. */
function looksLikeLoginPage(body: string): boolean {
  const head = body.trimStart().slice(0, 2048);
  if (!head) return false;
  const lower = head.toLowerCase();
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) return true;
  return /sap-system-login|logonform|sap-ui-bootstrap|sapsystemlogin|sap-logon/i.test(head);
}

/**
 * undici's "fetch failed" keeps the reason in its causes, the deepest one naming it: a refused
 * connection, an unknown host, a certificate, the proxy's answer to the tunnel.
 */
function networkReason(err: Error): string {
  let reason = '';
  for (let cause = err.cause, depth = 0; cause instanceof Error && depth < 5; cause = cause.cause, depth++) {
    const code = (cause as { code?: unknown }).code;
    reason = cause.message || (typeof code === 'string' ? code : reason);
  }
  return reason && reason !== err.message ? `${err.message}: ${reason}` : err.message;
}

function cancelledError(signal: AbortSignal): AdtNetworkError {
  const reason = signal.reason;
  const cause =
    reason instanceof Error && (reason.name === 'TimeoutError' || reason.name === 'AbortError')
      ? reason
      : new DOMException('The request was cancelled.', 'AbortError');
  return new AdtNetworkError(cause.message, cause);
}

function throwIfCancelled(options: AdtRequestOptions | undefined): void {
  if (options?.signal?.aborted) throw cancelledError(options.signal);
  if (options?.deadline !== undefined && options.deadline <= Date.now()) {
    const cause = new DOMException('The request deadline was exceeded.', 'TimeoutError');
    throw new AdtNetworkError(cause.message, cause);
  }
}

/** The fetch's own timeout, the caller's deadline and the caller's signal, whichever ends first. */
function requestSignal(options: AdtRequestOptions | undefined): AbortSignal {
  const remaining = options?.deadline === undefined ? Number.POSITIVE_INFINITY : options.deadline - Date.now();
  const timeout = Math.max(1, Math.ceil(Math.min(options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS, remaining)));
  const timer = AbortSignal.timeout(timeout);
  return options?.signal ? AbortSignal.any([options.signal, timer]) : timer;
}

/**
 * OAuth 2.0 authorization-code login (PKCE) for the SAP BTP ABAP Environment, from its service
 * key — the browser login Eclipse ADT uses. The access token then authenticates every ADT request
 * (`Authorization: Bearer`). Ported from ARC-1 (src/adt/oauth.ts); concurrent callers now share one
 * login or refresh instead of opening a browser each.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { platform } from 'node:os';
import { logger } from '../logger.js';
import type { BearerTokenProvider } from './http.js';

/** The fields of a BTP ABAP service key (BTP cockpit → instance → service key) this server uses. */
export interface BTPServiceKey {
  uaa: { url: string; clientid: string; clientsecret: string };
  /** The ABAP system URL. */
  url: string;
  abap?: { url?: string; sapClient?: string };
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export function parseServiceKey(json: string): BTPServiceKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid service key JSON: failed to parse');
  }
  const key = (parsed ?? {}) as Record<string, unknown>;
  if (!key.url || typeof key.url !== 'string') throw new Error('Invalid service key: missing "url" field');
  const uaa = key.uaa as Record<string, unknown> | undefined;
  if (!uaa || typeof uaa !== 'object') throw new Error('Invalid service key: missing "uaa" section');
  for (const field of ['url', 'clientid', 'clientsecret']) {
    if (!uaa[field] || typeof uaa[field] !== 'string') {
      throw new Error(`Invalid service key: missing "uaa.${field}" field`);
    }
  }
  return parsed as BTPServiceKey;
}

export function loadServiceKeyFile(filePath: string): BTPServiceKey {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read service key file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseServiceKey(content);
}

function clientAuthorization(serviceKey: BTPServiceKey): string {
  return `Basic ${Buffer.from(`${serviceKey.uaa.clientid}:${serviceKey.uaa.clientsecret}`).toString('base64')}`;
}

async function requestToken(serviceKey: BTPServiceKey, params: URLSearchParams, what: string) {
  const response = await fetch(`${serviceKey.uaa.url}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: clientAuthorization(serviceKey),
    },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`OAuth token ${what} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  return (await response.json()) as OAuthTokenResponse;
}

export async function exchangeCodeForToken(
  serviceKey: BTPServiceKey,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuthTokenResponse> {
  return requestToken(
    serviceKey,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: serviceKey.uaa.clientid,
      code_verifier: codeVerifier,
    }),
    'exchange',
  );
}

export async function refreshAccessToken(serviceKey: BTPServiceKey, refreshToken: string): Promise<OAuthTokenResponse> {
  return requestToken(
    serviceKey,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    'refresh',
  );
}

/** RFC 7636: a random verifier and its S256 challenge. */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  return { codeVerifier, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** macOS `open`, Windows `rundll32` (not `cmd start`: it cuts the URL at `&`), else `xdg-open`. */
async function openBrowser(url: string): Promise<void> {
  const [command, args] =
    platform() === 'darwin'
      ? ['open', [url]]
      : platform() === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    execFile(command as string, args as string[], (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * The loopback server that receives the authorization code (RFC 8252 §8.3: bound to 127.0.0.1),
 * checking `state` against CSRF and answering with inert HTML.
 */
export function startCallbackServer(
  port: number,
  expectedState: string,
  timeoutMs = 120_000,
): { code: Promise<string>; server: HttpServer } {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const headers = { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" };
  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/callback')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, headers);
      res.end('<html><body><h1>Error</h1><p>Invalid state parameter.</p></body></html>');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? error;
      res.writeHead(400, headers);
      res.end(`<html><body><h1>Authentication failed</h1><p>${escapeHtml(description)}</p></body></html>`);
      rejectCode(new Error(`OAuth authorization failed: ${description}`));
      server.close();
      return;
    }
    const received = url.searchParams.get('code');
    if (!received) {
      res.writeHead(400, headers);
      res.end('<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>');
      return;
    }
    res.writeHead(200, headers);
    res.end(
      '<html><body><h1>Signed in</h1><p>You can close this window and return to your MCP client.</p></body></html>',
    );
    resolveCode(received);
    server.close();
  });
  server.listen(port, '127.0.0.1');
  const timer = setTimeout(() => {
    rejectCode(new Error(`OAuth login timed out after ${timeoutMs / 1000}s: no browser login arrived`));
    server.close();
  }, timeoutMs);
  server.on('close', () => clearTimeout(timer));
  return { code, server };
}

/** Browser login: callback server, authorize URL with PKCE + state, then the code exchange. */
export async function performBrowserLogin(serviceKey: BTPServiceKey, callbackPort = 0): Promise<OAuthTokenResponse> {
  const { codeVerifier, codeChallenge } = generatePkce();
  const state = randomBytes(32).toString('base64url');
  const { code, server } = startCallbackServer(callbackPort, state);
  await new Promise<void>((resolve, reject) => {
    if (server.listening) resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : callbackPort;
  const redirectUri = `http://localhost:${port}/callback`;
  const authorizeUrl =
    `${serviceKey.uaa.url}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(serviceKey.uaa.clientid)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;
  logger.info('Opening the browser for the SAP BTP login', { port });
  try {
    await openBrowser(authorizeUrl);
  } catch {
    logger.warn('Could not open a browser. Open this URL to sign in:', { url: authorizeUrl });
  }
  const tokens = await exchangeCodeForToken(serviceKey, await code, redirectUri, codeVerifier);
  logger.info('SAP BTP login succeeded', { expiresIn: tokens.expires_in, refreshable: !!tokens.refresh_token });
  return tokens;
}

/**
 * Bearer tokens for the ADT client: the cached token while valid (60 s margin), else a refresh,
 * else a browser login. Callers arriving during a login or refresh wait for it.
 */
export function createBearerTokenProvider(serviceKey: BTPServiceKey, callbackPort = 0): BearerTokenProvider {
  let cache: { accessToken: string; refreshToken?: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;

  const renew = async (): Promise<string> => {
    if (cache?.refreshToken) {
      try {
        const refreshed = await refreshAccessToken(serviceKey, cache.refreshToken);
        cache = {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? cache.refreshToken,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
        };
        return cache.accessToken;
      } catch (err) {
        logger.warn('OAuth refresh failed; signing in again in the browser', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const tokens = await performBrowserLogin(serviceKey, callbackPort);
    cache = {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    return cache.accessToken;
  };

  return async (options = {}) => {
    if (!options.forceRefresh && cache && Date.now() < cache.expiresAt - 60_000) return cache.accessToken;
    pending ??= renew().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

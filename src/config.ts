/**
 * Configuration from the environment — the `env` block of the MCP client's server entry, or a
 * `--env-file`.
 */

import { resolveCookies } from './adt/cookies.js';
import { AdtHttpClient, createDispatcher } from './adt/http.js';
import { type BTPServiceKey, createBearerTokenProvider, loadServiceKeyFile, parseServiceKey } from './adt/oauth.js';
import type { SapConnection } from './tools/connection.js';
import { DEFAULT_LIMITS, type DebugLimits } from './tools/debug-limits.js';

export type AuthMode = 'btp' | 'basic' | 'cookies';

export interface Config {
  url: string;
  client?: string;
  language: string;
  auth: AuthMode;
  username?: string;
  password?: string;
  cookieFile?: string;
  cookieString?: string;
  serviceKey?: BTPServiceKey;
  oauthCallbackPort: number;
  /** Corporate proxy for SAP and the BTP token requests (SAP_PROXY). */
  proxy?: string;
  insecure: boolean;
  disableSaml: boolean;
  /** SAP_BASIS release, e.g. 758 — only picks the ABAP grammar that locates methods. */
  abapRelease?: string;
  /** Ceilings for debugging: time, result size, interactive sessions. */
  limits: DebugLimits;
  /** Look up the user's SAP GUI server in USR41 for trigger "none" (ABAP_DEBUGGER_SAP_GUI_LOOKUP). */
  sapGuiLookup: boolean;
}

export interface ConfigResult {
  config?: Config;
  /** What keeps the server from reaching SAP; the tools report them until they are fixed. */
  problems: string[];
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

function flag(env: NodeJS.ProcessEnv, key: string): boolean {
  return TRUE_VALUES.has((value(env, key) ?? '').toLowerCase());
}

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/** A setting that is on unless it says false; anything but true or false is a problem. */
function onUnlessOff(env: NodeJS.ProcessEnv, key: string, problems: string[]): boolean {
  const text = value(env, key);
  if (text === undefined || TRUE_VALUES.has(text.toLowerCase())) return true;
  if (FALSE_VALUES.has(text.toLowerCase())) return false;
  problems.push(`${key} must be true or false (got "${text}").`);
  return true;
}

/** The debugging ceilings: each variable a whole number within its bounds, else a problem. */
function readLimits(env: NodeJS.ProcessEnv, problems: string[]): DebugLimits {
  const bounded = (key: string, fallback: number, min: number, max: number): number => {
    const text = value(env, key);
    if (text === undefined) return fallback;
    const number = Number(text);
    if (Number.isInteger(number) && number >= min && number <= max) return number;
    problems.push(`${key} must be a whole number from ${min} to ${max} (got "${text}").`);
    return fallback;
  };
  return {
    maxSeconds: bounded('ABAP_DEBUGGER_MAX_SECONDS', DEFAULT_LIMITS.maxSeconds, 10, 3600),
    maxResultKB: bounded('ABAP_DEBUGGER_MAX_RESULT_KB', DEFAULT_LIMITS.maxResultKB, 5, 1000),
    idleSeconds: bounded('ABAP_DEBUGGER_IDLE_SECONDS', DEFAULT_LIMITS.idleSeconds, 10, 3600),
    sessionSeconds: bounded('ABAP_DEBUGGER_SESSION_SECONDS', DEFAULT_LIMITS.sessionSeconds, 60, 14_400),
    callSeconds: bounded('ABAP_DEBUGGER_CALL_SECONDS', DEFAULT_LIMITS.callSeconds, 10, 3600),
    maxCaptures: bounded('ABAP_DEBUGGER_MAX_CAPTURES', DEFAULT_LIMITS.maxCaptures, 1, 100),
    maxSessions: bounded('ABAP_DEBUGGER_MAX_SESSIONS', DEFAULT_LIMITS.maxSessions, 1, 100),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const problems: string[] = [];

  let serviceKey: BTPServiceKey | undefined;
  const inlineKey = value(env, 'SAP_BTP_SERVICE_KEY');
  const keyFile = value(env, 'SAP_BTP_SERVICE_KEY_FILE');
  const wantsBtp = !!(inlineKey || keyFile);
  try {
    serviceKey = inlineKey ? parseServiceKey(inlineKey) : keyFile ? loadServiceKeyFile(keyFile) : undefined;
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }

  const url = wantsBtp ? (serviceKey?.abap?.url ?? serviceKey?.url) : value(env, 'SAP_URL');
  if (!url) {
    if (!wantsBtp) {
      problems.push(
        'SAP_URL is not set: the SAP system to debug, e.g. https://my-sap-host:44300 (or SAP_BTP_SERVICE_KEY_FILE for the BTP ABAP Environment).',
      );
    }
  } else {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol))
        problems.push(`SAP_URL must be an http(s) URL (got "${url}").`);
    } catch {
      problems.push(`SAP_URL is not a valid URL (got "${url}").`);
    }
  }

  const client = serviceKey?.abap?.sapClient ?? value(env, 'SAP_CLIENT');
  if (client && !/^\d{3}$/.test(client)) problems.push(`SAP_CLIENT must be three digits (got "${client}").`);

  const username = value(env, 'SAP_USER');
  const password = env.SAP_PASSWORD || undefined;
  const cookieFile = value(env, 'SAP_COOKIE_FILE');
  const cookieString = value(env, 'SAP_COOKIE_STRING');
  if (cookieFile) {
    try {
      resolveCookies(cookieFile, undefined);
    } catch (err) {
      problems.push(`SAP_COOKIE_FILE cannot be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const auth: AuthMode | undefined = serviceKey
    ? 'btp'
    : cookieFile || cookieString
      ? 'cookies'
      : username && password
        ? 'basic'
        : undefined;
  if (!auth && !wantsBtp) {
    problems.push(
      username
        ? 'SAP_USER is set without SAP_PASSWORD (or SAP_COOKIE_FILE / SAP_COOKIE_STRING).'
        : 'No credentials: set SAP_USER + SAP_PASSWORD, SAP_COOKIE_FILE or SAP_COOKIE_STRING, or SAP_BTP_SERVICE_KEY_FILE.',
    );
  }

  const portText = value(env, 'SAP_BTP_OAUTH_CALLBACK_PORT') ?? '0';
  const oauthCallbackPort = Number(portText);
  if (!Number.isInteger(oauthCallbackPort) || oauthCallbackPort < 0 || oauthCallbackPort > 65535) {
    problems.push(`SAP_BTP_OAUTH_CALLBACK_PORT must be a port number (got "${portText}").`);
  }

  const proxy = value(env, 'SAP_PROXY');
  if (proxy) {
    let protocol = '';
    try {
      protocol = new URL(proxy).protocol;
    } catch {
      // reported below
    }
    if (!['http:', 'https:'].includes(protocol)) {
      problems.push('SAP_PROXY must be an http(s) proxy URL, e.g. http://proxy.example:8080.');
    }
  }

  const limits = readLimits(env, problems);
  const sapGuiLookup = onUnlessOff(env, 'ABAP_DEBUGGER_SAP_GUI_LOOKUP', problems);

  if (problems.length > 0 || !url || !auth) return { problems };
  return {
    problems,
    config: {
      url,
      ...(client ? { client } : {}),
      language: value(env, 'SAP_LANGUAGE') ?? 'EN',
      auth,
      ...(username ? { username } : {}),
      ...(password && auth !== 'btp' ? { password } : {}),
      ...(cookieFile && auth === 'cookies' ? { cookieFile } : {}),
      ...(cookieString && auth === 'cookies' ? { cookieString } : {}),
      ...(serviceKey ? { serviceKey } : {}),
      oauthCallbackPort,
      ...(proxy ? { proxy } : {}),
      insecure: flag(env, 'SAP_INSECURE'),
      disableSaml: flag(env, 'SAP_DISABLE_SAML'),
      ...(value(env, 'SAP_ABAP_RELEASE') ? { abapRelease: value(env, 'SAP_ABAP_RELEASE') } : {}),
      limits,
      sapGuiLookup,
    },
  };
}

/** The ADT client for a configuration, and what is known of its logon user. */
export function createConnection(config: Config): SapConnection {
  const http = new AdtHttpClient({
    baseUrl: config.url,
    ...(config.client ? { client: config.client } : {}),
    language: config.language,
    insecure: config.insecure,
    disableSaml: config.disableSaml,
    ...(config.proxy ? { proxy: config.proxy } : {}),
    ...(config.serviceKey
      ? {
          bearerTokenProvider: createBearerTokenProvider(
            config.serviceKey,
            config.oauthCallbackPort,
            // The token endpoint takes the proxy too — but never SAP_INSECURE, which is about SAP's certificate.
            config.proxy ? createDispatcher({ proxy: config.proxy }) : undefined,
          ),
        }
      : {
          ...(config.username ? { username: config.username } : {}),
          ...(config.password ? { password: config.password } : {}),
          ...(config.cookieFile ? { cookieFile: config.cookieFile } : {}),
          ...(config.cookieString ? { cookieString: config.cookieString } : {}),
          ...(config.auth === 'cookies' ? { cookies: resolveCookies(config.cookieFile, config.cookieString) } : {}),
        }),
  });
  return {
    http,
    // Behind Basic or cookies SAP_USER IS the logon user; a BTP token names nobody (SAP does).
    ...(config.auth !== 'btp' && config.username ? { logonUser: config.username } : {}),
    ...(config.abapRelease ? { abapRelease: config.abapRelease } : {}),
    limits: config.limits,
    ...(config.sapGuiLookup ? {} : { sapGuiLookup: false }),
  };
}

/** The MCP server over HTTP (ABAP_DEBUGGER_TRANSPORT=http): on SAP BTP Cloud Foundry, or any host. */
export interface HttpConfig {
  port: number;
  host: string;
  /** The public URL OAuth metadata advertises, behind a reverse proxy (else the CF route). */
  publicUrl?: string;
  /** Static API keys (each grants the debug scope). */
  apiKeys: string[];
  /** CORS allowlist for browser MCP clients (exact origins). */
  allowedOrigins: string[];
  /** Keeps OAuth client registrations valid across deployments (else XSUAA's client secret signs them). */
  dcrSigningSecret?: string;
  /** Accept one SAP identity for every MCP user (a Basic destination, or SAP_USER). */
  allowSharedUser: boolean;
  /** SAP_BTP_DESTINATION: the system, and how each user logs on to it. */
  btpDestination?: string;
}

const list = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): { http?: HttpConfig; problems: string[] } {
  const problems: string[] = [];
  // Cloud Foundry hands the port over in PORT and routes to every interface.
  const portText = value(env, 'PORT') ?? value(env, 'ABAP_DEBUGGER_PORT') ?? '8080';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`ABAP_DEBUGGER_PORT must be a port number (got "${portText}").`);
  }
  const publicUrl = value(env, 'ABAP_DEBUGGER_PUBLIC_URL')?.replace(/\/+$/, '');
  if (publicUrl) {
    try {
      if (!['http:', 'https:'].includes(new URL(publicUrl).protocol)) throw new Error('protocol');
    } catch {
      problems.push(`ABAP_DEBUGGER_PUBLIC_URL must be an http(s) URL (got "${publicUrl}").`);
    }
  }
  const apiKeys = list(env.ABAP_DEBUGGER_API_KEYS);
  if (apiKeys.some((key) => key.length < 20)) {
    problems.push(
      'ABAP_DEBUGGER_API_KEYS: each key must be at least 20 characters (a random secret, e.g. openssl rand -hex 24).',
    );
  }
  const dcrSigningSecret = value(env, 'ABAP_DEBUGGER_DCR_SIGNING_SECRET');
  if (dcrSigningSecret && dcrSigningSecret.length < 32) {
    problems.push('ABAP_DEBUGGER_DCR_SIGNING_SECRET must be at least 32 characters.');
  }
  if (problems.length > 0) return { problems };
  const btpDestination = value(env, 'SAP_BTP_DESTINATION');
  return {
    problems,
    http: {
      port,
      host: value(env, 'ABAP_DEBUGGER_HOST') ?? (value(env, 'PORT') ? '0.0.0.0' : '127.0.0.1'),
      ...(publicUrl ? { publicUrl } : {}),
      apiKeys,
      allowedOrigins: list(env.ABAP_DEBUGGER_ALLOWED_ORIGINS),
      ...(dcrSigningSecret ? { dcrSigningSecret } : {}),
      allowSharedUser: flag(env, 'ABAP_DEBUGGER_ALLOW_SHARED_USER'),
      ...(btpDestination ? { btpDestination } : {}),
    },
  };
}

/** What every SAP connection takes from the environment, whichever way it logs on. */
export function loadConnectionSettings(env: NodeJS.ProcessEnv = process.env): {
  settings: { language: string; limits: DebugLimits; abapRelease?: string; sapGuiLookup?: boolean };
  problems: string[];
} {
  const problems: string[] = [];
  const limits = readLimits(env, problems);
  const abapRelease = value(env, 'SAP_ABAP_RELEASE');
  const sapGuiLookup = onUnlessOff(env, 'ABAP_DEBUGGER_SAP_GUI_LOOKUP', problems);
  return {
    problems,
    settings: {
      language: value(env, 'SAP_LANGUAGE') ?? 'EN',
      limits,
      ...(abapRelease ? { abapRelease } : {}),
      ...(sapGuiLookup ? {} : { sapGuiLookup: false }),
    },
  };
}

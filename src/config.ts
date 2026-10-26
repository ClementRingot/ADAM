/**
 * Configuration from the environment — the `env` block of the MCP client's server entry, or a
 * `--env-file`. The variable names are ARC-1's, so an ARC-1 `.env` works here unchanged.
 */

import { resolveCookies } from './adt/cookies.js';
import { AdtHttpClient, createDispatcher } from './adt/http.js';
import { type BTPServiceKey, createBearerTokenProvider, loadServiceKeyFile, parseServiceKey } from './adt/oauth.js';
import type { SapConnection } from './tools/debug-capture.js';

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
  };
}

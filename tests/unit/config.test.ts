/** Configuration from the environment (src/config.ts): every problem at once, and who the logon user is. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createConnection, loadConfig } from '../../src/config.js';

const SERVICE_KEY = JSON.stringify({
  url: 'https://abc.abap.eu10.hana.ondemand.com',
  abap: { url: 'https://abc-api.abap.eu10.hana.ondemand.com', sapClient: '100' },
  uaa: { url: 'https://sub.authentication.eu10.hana.ondemand.com', clientid: 'sb-x', clientsecret: 's3cret' },
});

describe('loadConfig', () => {
  it('lists every missing piece when nothing is set', () => {
    const { config, problems } = loadConfig({});
    expect(config).toBeUndefined();
    expect(problems).toEqual([
      expect.stringContaining('SAP_URL is not set'),
      expect.stringContaining('No credentials'),
    ]);
  });

  it('reads Basic authentication with its defaults', () => {
    const { config, problems } = loadConfig({
      SAP_URL: 'https://sap.example:44300',
      SAP_USER: 'developer',
      SAP_PASSWORD: 'secret',
      SAP_INSECURE: 'true',
    });
    expect(problems).toEqual([]);
    expect(config).toMatchObject({
      url: 'https://sap.example:44300',
      auth: 'basic',
      username: 'developer',
      password: 'secret',
      language: 'EN',
      insecure: true,
      disableSaml: false,
    });
    expect(config).not.toHaveProperty('client');
    expect(createConnection(config!).logonUser).toBe('developer');
  });

  it('reads cookies, keeping SAP_USER as the logon user', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'abap-debugger-')), 'cookies.txt');
    writeFileSync(file, '# Netscape HTTP Cookie File\nsap.example\tFALSE\t/\tTRUE\t0\tMYSAPSSO2\tticket\n');
    const { config } = loadConfig({ SAP_URL: 'https://sap.example', SAP_COOKIE_FILE: file, SAP_USER: 'dev' });
    expect(config).toMatchObject({ auth: 'cookies', cookieFile: file, username: 'dev' });
    expect(createConnection(config!).logonUser).toBe('dev');
    expect(loadConfig({ SAP_URL: 'https://sap.example', SAP_COOKIE_FILE: `${file}.missing` }).problems).toEqual([
      expect.stringContaining('SAP_COOKIE_FILE cannot be read'),
    ]);
  });

  it('takes URL and client from a BTP service key; a token names no logon user', () => {
    const { config, problems } = loadConfig({
      SAP_BTP_SERVICE_KEY: SERVICE_KEY,
      SAP_USER: 'ignored@example.com',
      SAP_ABAP_RELEASE: '919',
    });
    expect(problems).toEqual([]);
    expect(config).toMatchObject({
      url: 'https://abc-api.abap.eu10.hana.ondemand.com',
      client: '100',
      auth: 'btp',
      abapRelease: '919',
    });
    const connection = createConnection(config!);
    expect(connection.logonUser).toBeUndefined();
    expect(connection.abapRelease).toBe('919');
  });

  it('takes a corporate proxy for SAP and the BTP token requests', () => {
    const { config } = loadConfig({
      SAP_URL: 'https://sap.example',
      SAP_USER: 'u',
      SAP_PASSWORD: 'p',
      SAP_PROXY: 'http://user:secret@proxy.example:8080',
    });
    expect(config?.proxy).toBe('http://user:secret@proxy.example:8080');
    expect(
      loadConfig({ SAP_URL: 'https://sap', SAP_USER: 'u', SAP_PASSWORD: 'p', SAP_PROXY: 'proxy:8080' }).problems,
    ).toEqual(['SAP_PROXY must be an http(s) proxy URL, e.g. http://proxy.example:8080.']);
  });

  it('reads the debugging ceilings, defaults where unset, and names an invalid one', () => {
    const base = { SAP_URL: 'https://sap', SAP_USER: 'u', SAP_PASSWORD: 'p' };
    expect(loadConfig(base).config?.limits).toEqual({
      maxSeconds: 600,
      maxResultKB: 200,
      idleSeconds: 120,
      sessionSeconds: 900,
      callSeconds: 50,
      maxCaptures: 4,
      maxSessions: 4,
    });
    const { config } = loadConfig({
      ...base,
      ABAP_DEBUGGER_MAX_SECONDS: '1200',
      ABAP_DEBUGGER_MAX_RESULT_KB: '80',
      ABAP_DEBUGGER_IDLE_SECONDS: '300',
      ABAP_DEBUGGER_SESSION_SECONDS: '1800',
      ABAP_DEBUGGER_CALL_SECONDS: '25',
      ABAP_DEBUGGER_MAX_CAPTURES: '10',
      ABAP_DEBUGGER_MAX_SESSIONS: '2',
    });
    expect(config?.limits).toEqual({
      maxSeconds: 1200,
      maxResultKB: 80,
      idleSeconds: 300,
      sessionSeconds: 1800,
      callSeconds: 25,
      maxCaptures: 10,
      maxSessions: 2,
    });
    expect(createConnection(config as NonNullable<typeof config>).limits).toEqual(config?.limits);
    expect(loadConfig({ ...base, ABAP_DEBUGGER_IDLE_SECONDS: '5' }).problems).toEqual([
      'ABAP_DEBUGGER_IDLE_SECONDS must be a whole number from 10 to 3600 (got "5").',
    ]);
    expect(loadConfig({ ...base, ABAP_DEBUGGER_CALL_SECONDS: '5', ABAP_DEBUGGER_MAX_SESSIONS: '0' }).problems).toEqual([
      'ABAP_DEBUGGER_CALL_SECONDS must be a whole number from 10 to 3600 (got "5").',
      'ABAP_DEBUGGER_MAX_SESSIONS must be a whole number from 1 to 100 (got "0").',
    ]);
  });

  it('names each invalid value', () => {
    expect(loadConfig({ SAP_URL: 'ftp://sap', SAP_USER: 'u', SAP_PASSWORD: 'p' }).problems).toEqual([
      'SAP_URL must be an http(s) URL (got "ftp://sap").',
    ]);
    expect(loadConfig({ SAP_URL: 'not a url', SAP_USER: 'u', SAP_PASSWORD: 'p', SAP_CLIENT: '1' }).problems).toEqual([
      'SAP_URL is not a valid URL (got "not a url").',
      'SAP_CLIENT must be three digits (got "1").',
    ]);
    expect(loadConfig({ SAP_URL: 'https://sap', SAP_USER: 'u' }).problems).toEqual([
      'SAP_USER is set without SAP_PASSWORD (or SAP_COOKIE_FILE / SAP_COOKIE_STRING).',
    ]);
    expect(loadConfig({ SAP_BTP_SERVICE_KEY: '{"url":"x"}' }).problems).toEqual([
      'Invalid service key: missing "uaa" section',
    ]);
    expect(loadConfig({ SAP_BTP_SERVICE_KEY: SERVICE_KEY, SAP_BTP_OAUTH_CALLBACK_PORT: '70000' }).problems).toEqual([
      'SAP_BTP_OAUTH_CALLBACK_PORT must be a port number (got "70000").',
    ]);
  });
});

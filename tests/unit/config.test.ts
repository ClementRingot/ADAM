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

  it('reads Basic authentication with ARC-1-compatible names and defaults', () => {
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

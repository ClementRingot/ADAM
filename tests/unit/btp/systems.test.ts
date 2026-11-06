/** Several SAP systems from one deployment (src/btp/systems.ts): routes from destinations, and what refuses one. */
import type { AuthInfo } from '@arc-mcp/xsuaa-auth';
import type { Destination } from '@arc-mcp/xsuaa-auth/btp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BtpSystems, RETRY_MS, systemOf } from '../../../src/btp/systems.js';
import { DEFAULT_LIMITS } from '../../../src/tools/debug-limits.js';

const credentials = (extra: Record<string, unknown> = {}) => ({
  clientid: 'sb-client',
  clientsecret: 'secret',
  url: 'https://sub.authentication.eu10.hana.ondemand.com',
  ...extra,
});

const env: NodeJS.ProcessEnv = {
  VCAP_SERVICES: JSON.stringify({
    destination: [
      { credentials: credentials({ uri: 'https://destination-configuration.cfapps.eu10.hana.ondemand.com' }) },
    ],
    connectivity: [
      {
        credentials: credentials({
          onpremise_proxy_host: 'connectivityproxy.internal.cf.eu10.hana.ondemand.com',
          onpremise_proxy_http_port: '20003',
          token_service_url: 'https://sub.authentication.eu10.hana.ondemand.com',
        }),
      },
    ],
  }),
};

function destination(
  name: string,
  sid: string | undefined,
  client: string | undefined,
  overrides: Partial<Destination> = {},
): Destination {
  return {
    Name: name,
    URL: `http://${name.toLowerCase()}-virtual:50000`,
    Authentication: 'PrincipalPropagation',
    ProxyType: 'OnPremise',
    User: '',
    Password: '',
    ...(client ? { 'sap-client': client } : {}),
    originalProperties: { ...(sid ? { 'sap-sysid': sid } : {}) },
    ...overrides,
  };
}

const settings = { language: 'EN', limits: DEFAULT_LIMITS };
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

afterEach(() => vi.restoreAllMocks());

describe('systemOf', () => {
  it("reads a destination's system and client, else names the properties to add", () => {
    expect(systemOf(destination('S4D_PP', 's4d', '100'))).toEqual({ sid: 'S4D', client: '100' });
    expect(systemOf(destination('S4D_PP', undefined, '100'))).toEqual({
      problem:
        'Destination S4D_PP names no system for its MCP route /<SID>/<client>/mcp: add the additional property sap-sysid (the system ID, e.g. S4D) to it.',
    });
    expect(systemOf(destination('X', 'TOOLONG', undefined))).toEqual({
      problem:
        'Destination X names no system for its MCP route /<SID>/<client>/mcp: add the additional properties sap-sysid (the system ID, e.g. S4D; got "TOOLONG") and sap-client (three digits, e.g. 100) to it.',
    });
  });
});

describe('BtpSystems', () => {
  it('serves each destination at its own route, and says why the others serve nobody', async () => {
    const destinations: Record<string, Destination> = {
      S4D_PP: destination('S4D_PP', 'S4D', '100'),
      S4Q_PP: destination('S4Q_PP', 'S4Q', '100'),
      S4Q_BASIC: destination('S4Q_BASIC', 'S4Q', '200', { Authentication: 'BasicAuthentication', User: 'DEBUGGER' }),
      S4P_A: destination('S4P_A', 'S4P', '100'),
      S4P_B: destination('S4P_B', 'S4P', '100'),
      NO_SID: destination('NO_SID', undefined, '100'),
    };
    const lookup = vi.fn(async (_btp: unknown, name: string) => {
      const found = destinations[name];
      if (!found) throw new Error(`Destination ${name} not found`);
      return found;
    });
    const lookupForUser = vi.fn(async (_btp: unknown, name: string) => ({
      destination: destinations[name] as Destination,
      authTokens: { sapConnectivityAuth: 'Bearer user-jwt' },
    }));
    const systems = new BtpSystems(
      [...Object.keys(destinations), 'MISSING'],
      settings,
      env,
      lookup as never,
      lookupForUser as never,
    );

    const dev = await systems.route('s4d', '100');
    expect(dev).toMatchObject({ problems: [], sapGui: true });
    const alice = { token: jwt({ user_uuid: 'alice' }), clientId: 'c', scopes: ['debug'] } as AuthInfo;
    const devConn = await dev?.connect?.(alice, 'user::alice');
    const qasConn = await (await systems.route('S4Q', '100'))?.connect?.(alice, 'user::alice');
    // Each route reaches its own destination: two systems, two keys for the debugger's records.
    expect(lookupForUser.mock.calls.map((call) => call[1])).toEqual(['S4D_PP', 'S4Q_PP']);
    expect(devConn?.http.systemKey).not.toBe(qasConn?.http.systemKey);

    expect((await systems.route('S4Q', '200'))?.problems[0]).toContain(
      'A deployment that serves several systems (SAP_BTP_DESTINATIONS) takes only destinations that log each user on as themselves',
    );
    expect((await systems.route('S4P', '100'))?.problems).toEqual([
      'Destinations S4P_A and S4P_B all reach system S4P client 100: keep one of them in SAP_BTP_DESTINATIONS.',
    ]);
    expect(await systems.route('S4X', '100')).toBeUndefined();

    const overview = await systems.overview();
    expect(overview.map(({ destination: name, route }) => [name, route])).toEqual([
      ['S4D_PP', '/S4D/100/mcp'],
      ['S4Q_PP', '/S4Q/100/mcp'],
      ['S4Q_BASIC', '/S4Q/200/mcp'],
      ['S4P_A', '/S4P/100/mcp'],
      ['S4P_B', '/S4P/100/mcp'],
      ['NO_SID', undefined],
      ['MISSING', undefined],
    ]);
    expect(overview[0]).not.toHaveProperty('problem');
    expect(overview[5]?.problem).toContain('add the additional property sap-sysid');
    expect(overview[6]?.problem).toBe('Destination MISSING cannot be looked up: Destination MISSING not found');
    // Every destination was looked up once: what serves is not looked up again, the rest not within RETRY_MS.
    expect(lookup).toHaveBeenCalledTimes(7);
  });

  it('looks a failed destination up again, at most every RETRY_MS, until it serves', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error('Destination service unavailable'))
      .mockResolvedValue(destination('S4D_PP', 'S4D', '100'));
    const systems = new BtpSystems(['S4D_PP'], settings, env, lookup);
    expect(await systems.route('S4D', '100')).toBeUndefined();
    expect((await systems.overview())[0]?.problem).toBe(
      'Destination S4D_PP cannot be looked up: Destination service unavailable',
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    now += RETRY_MS;
    expect(await systems.route('S4D', '100')).toMatchObject({ problems: [] });
    now += RETRY_MS;
    await systems.route('S4D', '100');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('needs the Destination service bound', async () => {
    const systems = new BtpSystems(['S4D_PP'], settings, {}, vi.fn());
    expect((await systems.overview())[0]?.problem).toContain(
      'SAP_BTP_DESTINATIONS needs the Destination service bound to this app',
    );
  });
});

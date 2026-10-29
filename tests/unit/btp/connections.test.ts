/** SAP connections on SAP BTP (src/btp/connections.ts): the destination check and per-user identities. */
import type { AuthInfo } from '@arc-mcp/xsuaa-auth';
import type { BTPConfig, Destination } from '@arc-mcp/xsuaa-auth/btp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BtpConnections, identityHeaders, ownerOf, resolveBtpTarget } from '../../../src/btp/connections.js';
import { DEFAULT_LIMITS } from '../../../src/tools/debug-limits.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

afterEach(() => mockFetch.mockReset());

const credentials = (extra: Record<string, unknown> = {}) => ({
  clientid: 'sb-client',
  clientsecret: 'secret',
  url: 'https://sub.authentication.eu10.hana.ondemand.com',
  ...extra,
});

/** VCAP_SERVICES with the bindings an on-premise deployment has. */
function vcap(withConnectivity = true): NodeJS.ProcessEnv {
  return {
    VCAP_SERVICES: JSON.stringify({
      xsuaa: [
        { credentials: credentials({ xsappname: 'abapdbg', uaadomain: 'authentication.eu10.hana.ondemand.com' }) },
      ],
      destination: [
        { credentials: credentials({ uri: 'https://destination-configuration.cfapps.eu10.hana.ondemand.com' }) },
      ],
      ...(withConnectivity
        ? {
            connectivity: [
              {
                credentials: credentials({
                  onpremise_proxy_host: 'connectivityproxy.internal.cf.eu10.hana.ondemand.com',
                  onpremise_proxy_http_port: '20003',
                  token_service_url: 'https://sub.authentication.eu10.hana.ondemand.com',
                }),
              },
            ],
          }
        : {}),
    }),
  };
}

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    Name: 'A4H_PP',
    URL: 'http://a4h-virtual:50000',
    Authentication: 'PrincipalPropagation',
    ProxyType: 'OnPremise',
    User: '',
    Password: '',
    'sap-client': '001',
    ...overrides,
  };
}

const lookup = (dest: Destination) => vi.fn(async () => dest);
const options = { allowSharedUser: false };

/** A three-part token with these claims (the bearer middleware verified it before). */
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('resolveBtpTarget', () => {
  it('takes a principal-propagation destination, each user as themselves', async () => {
    const target = await resolveBtpTarget('A4H_PP', options, vcap(), lookup(destination()));
    expect(target).toMatchObject({ name: 'A4H_PP', perUser: true, destination: { URL: 'http://a4h-virtual:50000' } });
  });

  it('refuses what cannot debug safely or at all', async () => {
    await expect(resolveBtpTarget('X', options, {}, lookup(destination()))).rejects.toThrow(
      'needs the Destination service bound',
    );
    await expect(
      resolveBtpTarget('X', options, vcap(), lookup(destination({ Authentication: 'BasicAuthentication' }))),
    ).rejects.toThrow('every user would debug as one SAP user');
    await expect(
      resolveBtpTarget('X', options, vcap(), lookup(destination({ Authentication: 'NoAuthentication' }))),
    ).rejects.toThrow('a debugger needs PrincipalPropagation');
    await expect(
      resolveBtpTarget('X', options, vcap(), lookup(destination({ URL: 'https://a4h-virtual:44300' }))),
    ).rejects.toThrow('not http://');
    await expect(resolveBtpTarget('X', options, vcap(false), lookup(destination()))).rejects.toThrow(
      'bind the Connectivity service',
    );
  });

  it('accepts a shared Basic destination only when the administrator allows it', async () => {
    const basic = destination({ Authentication: 'BasicAuthentication', User: 'DEBUGGER', Password: 'pw' });
    const target = await resolveBtpTarget('A4H_BASIC', { allowSharedUser: true }, vcap(), lookup(basic));
    expect(target.perUser).toBe(false);
  });
});

describe('identities', () => {
  it('turns each kind of per-user token into its headers', () => {
    expect(identityHeaders({ sapConnectivityAuth: 'Bearer user-jwt' }, 'D')).toEqual({
      'SAP-Connectivity-Authentication': 'Bearer user-jwt',
    });
    expect(identityHeaders({ bearerToken: 'abap-token' }, 'D')).toEqual({ Authorization: 'Bearer abap-token' });
    expect(identityHeaders({ samlAssertionAuthorization: 'SAML2.0 abc' }, 'D')).toEqual({
      Authorization: 'SAML2.0 abc',
      'x-sap-security-session': 'create',
    });
    expect(() => identityHeaders({}, 'D')).toThrow('returned no identity');
  });

  it('keys the calling MCP user by their XSUAA user, else by the client', () => {
    const token = jwt({ user_uuid: 'u-1', zid: 'zone-1', sub: 's' });
    expect(ownerOf({ token, clientId: 'c', scopes: [] } as AuthInfo)).toBe('user:zone-1:u-1');
    expect(ownerOf({ token: 'an-api-key-of-twenty-chars', clientId: 'api-key-1', scopes: [] } as AuthInfo)).toBe(
      'client:api-key-1',
    );
    expect(ownerOf(undefined)).toBe('client:anonymous');
  });
});

describe('BtpConnections', () => {
  const settings = { language: 'EN', limits: DEFAULT_LIMITS };
  const btp = { destinationUrl: 'x' } as unknown as BTPConfig;

  it("gives each user their own client, carrying their latest identity, and refuses an API key's call", async () => {
    const internet = destination({
      ProxyType: 'Internet',
      URL: 'https://abap.example',
      Authentication: 'OAuth2UserTokenExchange',
    });
    const lookupForUser = vi
      .fn()
      .mockResolvedValueOnce({ destination: internet, authTokens: { bearerToken: 'first' } })
      .mockResolvedValueOnce({ destination: internet, authTokens: { bearerToken: 'second' } });
    const connections = new BtpConnections(
      { btp, name: 'ABAP_ENV', destination: internet, perUser: true },
      settings,
      lookupForUser,
    );
    const alice = { token: jwt({ user_uuid: 'alice' }), clientId: 'c', scopes: ['debug'] } as AuthInfo;
    const first = await connections.connect(alice, 'user::alice');
    const again = await connections.connect(alice, 'user::alice');
    expect(again).toBe(first);
    expect(lookupForUser).toHaveBeenLastCalledWith(btp, 'ABAP_ENV', alice.token, expect.anything());

    mockFetch.mockResolvedValueOnce(mockResponse(200, 'ok'));
    await first.http.get('/sap/bc/adt/core/discovery');
    const [url, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://abap.example/sap/bc/adt/core/discovery?sap-client=001&sap-language=EN');
    // The second call's token: an interactive session started earlier keeps the user's latest identity.
    expect(init.headers.Authorization).toBe('Bearer second');
    expect(first.logonUser).toBeUndefined();

    await expect(
      connections.connect({ token: 'an-api-key-of-twenty-chars', clientId: 'k', scopes: [] } as AuthInfo, 'client:k'),
    ).rejects.toThrow('needs your XSUAA user token');
  });

  it('shares one technical client for a Basic destination, its user being the logon user', async () => {
    const basic = destination({
      ProxyType: 'Internet',
      URL: 'https://a4h.example',
      Authentication: 'BasicAuthentication',
      User: 'DEBUGGER',
      Password: 'pw',
    });
    const connections = new BtpConnections({ btp, name: 'A4H', destination: basic, perUser: false }, settings);
    const a = await connections.connect(undefined, 'client:a');
    expect(await connections.connect(undefined, 'client:b')).toBe(a);
    expect(a.logonUser).toBe('DEBUGGER');
    expect(a).not.toHaveProperty('sapGuiLookup');
    const off = new BtpConnections(
      { btp, name: 'A4H', destination: basic, perUser: false },
      {
        ...settings,
        sapGuiLookup: false,
      },
    );
    expect((await off.connect(undefined, 'client:a')).sapGuiLookup).toBe(false);
    mockFetch.mockResolvedValueOnce(mockResponse(200, 'ok'));
    await a.http.get('/sap/bc/adt/core/discovery');
    const [, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('DEBUGGER:pw').toString('base64')}`);
  });
});

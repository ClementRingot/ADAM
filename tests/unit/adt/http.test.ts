/**
 * The minimal ADT HTTP client (src/adt/http.ts): CSRF, cookies, stateful sessions and their close
 * request, the two resends SAP allows (401, 403 "Required") — and no others.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, ProxyAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdtApiError, AdtNetworkError } from '../../../src/adt/errors.js';
import { AdtHttpClient, type AdtHttpConfig } from '../../../src/adt/http.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

interface Sent {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function sent(): Sent[] {
  return mockFetch.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), ...(init as Omit<Sent, 'url'>) }));
}

const BASIC = `Basic ${Buffer.from('dev:pw').toString('base64')}`;
const token = (value = 'T1', cookies: string[] = []) => mockResponse(200, '', { 'x-csrf-token': value }, cookies);

function client(extra: Partial<AdtHttpConfig> = {}): AdtHttpClient {
  return new AdtHttpClient({
    baseUrl: 'http://sap:8000/',
    client: '001',
    language: 'EN',
    username: 'dev',
    password: 'pw',
    ...extra,
  });
}

afterEach(() => mockFetch.mockReset());

describe('requests', () => {
  it('sends client, language and Basic auth, fetching a CSRF token before the first POST', async () => {
    mockFetch
      .mockResolvedValueOnce(token('T1', ['SAP_SESSIONID_A4H_001=s1; path=/']))
      .mockResolvedValueOnce(mockResponse(200, '<ok/>'));
    const resp = await client().post('/sap/bc/adt/debugger/breakpoints', '<x/>', 'application/xml', {
      Accept: 'application/xml',
    });
    expect(resp).toMatchObject({ statusCode: 200, body: '<ok/>' });
    const [probe, post] = sent();
    expect(probe).toMatchObject({ method: 'HEAD', headers: { 'X-CSRF-Token': 'fetch', Authorization: BASIC } });
    expect(probe?.url.pathname).toBe('/sap/bc/adt/core/discovery');
    expect(post?.url.searchParams.get('sap-client')).toBe('001');
    expect(post?.url.searchParams.get('sap-language')).toBe('EN');
    expect(post?.headers).toMatchObject({
      'X-CSRF-Token': 'T1',
      'Content-Type': 'application/xml',
      Accept: 'application/xml',
      Authorization: BASIC,
      Cookie: 'SAP_SESSIONID_A4H_001=s1',
    });
    expect(post?.body).toBe('<x/>');
  });

  it('needs no token for a GET, and asks SAP not to redirect to SAML when told to', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, 'source'));
    await client({ disableSaml: true }).get('/sap/bc/adt/programs/programs/zx/source/main');
    const [get] = sent();
    expect(get?.headers['X-SAP-SAML2']).toBe('disabled');
    expect(get?.url.searchParams.get('saml2')).toBe('disabled');
    expect(get?.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it('fetches the token with GET where HEAD is refused, and from the legacy discovery where core is missing', async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(405, ''))
      .mockResolvedValueOnce(mockResponse(404, 'no core discovery'))
      .mockResolvedValueOnce(token('LEGACY'))
      .mockResolvedValueOnce(mockResponse(200, ''));
    await client().post('/sap/bc/adt/debugger?method=stepOver');
    expect(sent().map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'HEAD /sap/bc/adt/core/discovery',
      'GET /sap/bc/adt/core/discovery',
      'GET /sap/bc/adt/discovery',
      'POST /sap/bc/adt/debugger',
    ]);
    expect(sent()[3]?.headers['X-CSRF-Token']).toBe('LEGACY');
  });

  it('says so when the token fetch is not authenticated', async () => {
    mockFetch.mockResolvedValue(mockResponse(401, ''));
    await expect(client().post('/sap/bc/adt/debugger/breakpoints')).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('Authentication failed (401) (sap-client=001)'),
    });
  });

  it('turns a logon page into a 401 instead of a successful answer', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, '<!DOCTYPE html><html><form id="logonForm"></form></html>', { 'content-type': 'text/html' }),
    );
    await expect(client().get('/sap/bc/adt/core/http/systeminformation')).rejects.toMatchObject({
      statusCode: 401,
      sapMessage: expect.stringContaining('logon page'),
    });
  });

  it("carries SAP's sentence out of an error document", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(
        404,
        '<?xml version="1.0"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><message lang="EN">Generic</message><localizedMessage lang="EN">Class ZCL_X does not exist &amp; never did</localizedMessage></exc:exception>',
      ),
    );
    const err = await client()
      .get('/sap/bc/adt/oo/classes/zcl_x/source/main')
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AdtApiError);
    expect(err).toMatchObject({ statusCode: 404, sapMessage: 'Class ZCL_X does not exist & never did' });
    expect((err as AdtApiError).responseBody).toContain('localizedMessage');
  });
});

describe('resends', () => {
  it('never resends a POST SAP answered with 503 — a debugger step must not run twice', async () => {
    mockFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(mockResponse(503, 'Service unavailable'));
    await expect(client().post('/sap/bc/adt/debugger?method=stepContinue')).rejects.toMatchObject({ statusCode: 503 });
    expect(sent()).toHaveLength(2);
  });

  it('refreshes a stale CSRF token once when SAP asks for one', async () => {
    mockFetch
      .mockResolvedValueOnce(token('OLD'))
      .mockResolvedValueOnce(mockResponse(403, 'CSRF token validation failed', { 'x-csrf-token': 'Required' }))
      .mockResolvedValueOnce(token('NEW'))
      .mockResolvedValueOnce(mockResponse(200, 'done'));
    expect((await client().post('/sap/bc/adt/debugger?method=stepOver')).body).toBe('done');
    expect(sent().map((call) => call.headers['X-CSRF-Token'])).toEqual(['fetch', 'OLD', 'fetch', 'NEW']);
  });

  it('reports any other 403 at once', async () => {
    mockFetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(mockResponse(403, 'No authorization'));
    await expect(client().post('/sap/bc/adt/debugger/breakpoints')).rejects.toMatchObject({ statusCode: 403 });
    expect(sent()).toHaveLength(2);
  });

  it('renews an expired session once on 401, re-reading the cookie file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'abap-debugger-')), 'cookies.txt');
    writeFileSync(file, 'MYSAPSSO2=old\n');
    const http = client({ username: undefined, password: undefined, cookieFile: file, cookies: { MYSAPSSO2: 'old' } });
    mockFetch.mockImplementationOnce(async () => {
      writeFileSync(file, 'MYSAPSSO2=fresh\n');
      return mockResponse(401, '');
    });
    mockFetch.mockResolvedValueOnce(mockResponse(200, 'ok'));
    expect((await http.get('/sap/bc/adt/core/http/systeminformation')).body).toBe('ok');
    expect(sent().map((call) => call.headers.Cookie)).toEqual(['MYSAPSSO2=old', 'MYSAPSSO2=fresh']);
  });

  it('asks the token provider for a fresh token after a 401', async () => {
    const provider = vi.fn(async (options?: { forceRefresh?: boolean }) => (options?.forceRefresh ? 'new' : 'old'));
    mockFetch.mockResolvedValueOnce(mockResponse(401, '')).mockResolvedValueOnce(mockResponse(200, 'ok'));
    await client({ username: undefined, password: undefined, bearerTokenProvider: provider }).get('/sap/bc/adt/x');
    expect(sent().map((call) => call.headers.Authorization)).toEqual(['Bearer old', 'Bearer new']);
    expect(provider).toHaveBeenLastCalledWith({ forceRefresh: true });
  });
});

describe('proxy', () => {
  it('sends every request through SAP_PROXY when one is set, and directly otherwise', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, 'ok'));
    await client({ proxy: 'http://proxy.example:8080' }).get('/sap/bc/adt/x');
    await client().get('/sap/bc/adt/x');
    const [proxied, direct] = mockFetch.mock.calls.map((call) => (call[1] as { dispatcher: unknown }).dispatcher);
    expect(proxied).toBeInstanceOf(ProxyAgent);
    expect(direct).toBeInstanceOf(Agent);
    expect(direct).not.toBeInstanceOf(ProxyAgent);
  });

  it('shares one connection pool between a client and its stateful sessions', async () => {
    mockFetch.mockResolvedValue(mockResponse(200, 'ok'));
    const root = client({ proxy: 'http://proxy.example:8080' });
    await root.get('/sap/bc/adt/x');
    await root.openStatefulSession().get('/sap/bc/adt/x');
    const [first, second] = mockFetch.mock.calls.map((call) => (call[1] as { dispatcher: unknown }).dispatcher);
    expect(second).toBe(first);
  });
});

describe('stateful sessions', () => {
  const contextCookie = (server: string) => `sap-contextid=SID%3aANON%3a${server}%3aCTX-NEW; path=/`;

  it('share the login cookies and the token, never the context', async () => {
    const root = client();
    mockFetch.mockResolvedValueOnce(
      mockResponse(200, '', { 'x-csrf-token': 'T1' }, ['SAP_SESSIONID_A4H_001=s1; path=/', contextCookie('root')]),
    );
    await root.head('/sap/bc/adt/core/discovery');
    const session = root.openStatefulSession();
    mockFetch.mockResolvedValueOnce(mockResponse(200, '', {}, [contextCookie('appserver-a')]));
    await session.post('/sap/bc/adt/debugger?method=attach');
    const [, attach] = sent();
    expect(attach?.headers['X-sap-adt-sessiontype']).toBe('stateful');
    expect(attach?.headers['X-CSRF-Token']).toBe('T1');
    expect(attach?.headers.Cookie).toBe('SAP_SESSIONID_A4H_001=s1');
    expect(session.sessionContextId).toBe('SID%3aANON%3aappserver-a%3aCTX-NEW');
    expect(root.sessionContextId).toBe('SID%3aANON%3aroot%3aCTX-NEW');
  });

  it("close with Eclipse's close-session request on their own context", async () => {
    const session = client().openStatefulSession();
    mockFetch.mockResolvedValueOnce(mockResponse(200, '', {}, [contextCookie('appserver-a')]));
    await session.get('/sap/bc/adt/core/http/systeminformation');
    mockFetch.mockResolvedValueOnce(mockResponse(200, ''));
    await expect(session.endStatefulSession()).resolves.toBe(true);
    const close = sent()[1];
    expect(close?.url.pathname).toBe('/sap/bc/adt/core/http/sessions');
    expect(close?.headers).toMatchObject({
      'sap-adt-purpose': 'close-session',
      'sap-contextid': 'SID%3aANON%3aappserver-a%3aCTX-NEW',
      'X-sap-adt-sessiontype': 'stateless',
    });
    expect(close?.headers.Cookie).toContain('sap-contextid=SID%3aANON%3aappserver-a%3aCTX-NEW');
  });

  it('close on NW 7.50 through discovery, report a refusal, and skip a session without context', async () => {
    const session = client().openStatefulSession();
    mockFetch.mockResolvedValueOnce(mockResponse(200, '', {}, [contextCookie('a')]));
    await session.get('/sap/bc/adt/x');
    mockFetch.mockResolvedValueOnce(mockResponse(404, '')).mockResolvedValueOnce(mockResponse(200, ''));
    await expect(session.endStatefulSession()).resolves.toBe(true);
    expect(sent()[2]).toMatchObject({ method: 'HEAD' });

    const refused = client().openStatefulSession();
    mockFetch.mockResolvedValueOnce(mockResponse(200, '', {}, [contextCookie('b')]));
    await refused.get('/sap/bc/adt/x');
    mockFetch.mockResolvedValueOnce(mockResponse(500, 'boom'));
    await expect(refused.endStatefulSession()).resolves.toBe(false);

    mockFetch.mockReset();
    await expect(client().openStatefulSession().endStatefulSession()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('routed to a server, name it on every request but the token fetch and the close', async () => {
    const session = client().openStatefulSession({ server: 'sapaas_S4D_01' });
    expect(session.routedTo).toBe('sapaas_S4D_01');
    mockFetch
      .mockResolvedValueOnce(token('T1', [contextCookie('sappas_S4D_00')]))
      .mockResolvedValueOnce(mockResponse(200, '<dbg:attach/>'))
      .mockResolvedValueOnce(mockResponse(200, ''));
    await session.post('/sap/bc/adt/debugger?method=attach', undefined, undefined, { Accept: '*/*' });
    await expect(session.endStatefulSession()).resolves.toBe(true);
    const [fetchToken, attach, close] = sent();
    // The token belongs to the session's own server, which checks it before it forwards anything.
    expect(fetchToken?.headers).not.toHaveProperty('X-sap-adt-server-instance');
    expect(attach?.headers).toMatchObject({
      'X-sap-adt-server-instance': 'sapaas_S4D_01',
      'sap-adt-saplb': 'fetch',
      saplb: 'sapaas_S4D_01',
      'X-sap-adt-sessiontype': 'stateful',
      'X-CSRF-Token': 'T1',
    });
    // The close ends the session where it is; the ABAP session it opened on the routed server goes with it.
    expect(close?.url.pathname).toBe('/sap/bc/adt/core/http/sessions');
    expect(close?.headers).not.toHaveProperty('X-sap-adt-server-instance');
    expect(close?.headers).not.toHaveProperty('sap-adt-saplb');
    expect(close?.headers).not.toHaveProperty('saplb');
    expect(client().openStatefulSession().routedTo).toBeUndefined();
  });
});

describe('deadlines', () => {
  it('refuses to start a request past its deadline or after its signal aborted', async () => {
    await expect(client().get('/sap/bc/adt/x', undefined, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
      AdtNetworkError,
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(client().get('/sap/bc/adt/x', undefined, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AdtNetworkError',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('wraps a fetch that fails or times out as a network error', async () => {
    mockFetch.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    const err = await client()
      .get('/sap/bc/adt/x', undefined, { fetchTimeoutMs: 5 })
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AdtNetworkError);
    expect((err as AdtNetworkError).isTimeout).toBe(true);
    // The fetch got a signal that ends with the per-fetch timeout.
    expect(sent()[0]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('names the reason undici keeps in the causes of "fetch failed"', async () => {
    // A proxy refusing the tunnel, as undici reports it: the reason is two causes down.
    const tunnel = new Error('Proxy response (407) !== 200 when HTTP Tunneling');
    mockFetch.mockRejectedValueOnce(
      new TypeError('fetch failed', { cause: new Error('Request was cancelled.', { cause: tunnel }) }),
    );
    await expect(client().get('/sap/bc/adt/x')).rejects.toThrow(
      'ADT network error: fetch failed: Proxy response (407) !== 200 when HTTP Tunneling',
    );
    // A refused connection to every address of a host: no message, only a code.
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed', { cause: refused }));
    await expect(client().get('/sap/bc/adt/x')).rejects.toThrow('ADT network error: fetch failed: ECONNREFUSED');
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client().get('/sap/bc/adt/x')).rejects.toThrow(/^ADT network error: fetch failed$/);
  });
});

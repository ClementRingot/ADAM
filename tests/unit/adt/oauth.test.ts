/**
 * BTP ABAP Environment login (src/adt/oauth.ts): the loopback callback, and a token provider whose
 * concurrent callers share one browser login. The "browser" is simulated: it calls the callback.
 */
import { get } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBearerTokenProvider, parseServiceKey, startCallbackServer } from '../../../src/adt/oauth.js';

const browser = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock('node:child_process', () => ({
  execFile: (_command: string, args: string[], callback: (err: Error | null) => void) => {
    const authorize = new URL(args.at(-1) as string);
    browser.opened.push(authorize.toString());
    const redirect = new URL(authorize.searchParams.get('redirect_uri') as string);
    redirect.searchParams.set('code', 'CODE-1');
    redirect.searchParams.set('state', authorize.searchParams.get('state') as string);
    get(redirect.toString().replace('localhost', '127.0.0.1'), (res) => res.resume());
    callback(null);
  },
}));

const KEY = parseServiceKey(
  JSON.stringify({
    url: 'https://abc.abap.eu10.hana.ondemand.com',
    uaa: { url: 'https://sub.authentication.eu10.hana.ondemand.com', clientid: 'sb-client', clientsecret: 'sec' },
  }),
);

function hit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  browser.opened = [];
});

describe('parseServiceKey', () => {
  it('requires the ABAP url and the uaa credentials', () => {
    expect(KEY.uaa.clientid).toBe('sb-client');
    expect(() => parseServiceKey('nope')).toThrow('failed to parse');
    expect(() => parseServiceKey('{"uaa":{}}')).toThrow('missing "url"');
    expect(() => parseServiceKey('{"url":"u","uaa":{"url":"x","clientid":"c"}}')).toThrow('uaa.clientsecret');
  });
});

describe('startCallbackServer', () => {
  it('accepts the code only with the expected state', async () => {
    const { code, server } = startCallbackServer(0, 'STATE');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    expect(await hit(`http://127.0.0.1:${port}/elsewhere`)).toBe(404);
    expect(await hit(`http://127.0.0.1:${port}/callback?code=X&state=WRONG`)).toBe(400);
    expect(await hit(`http://127.0.0.1:${port}/callback?code=GOOD&state=STATE`)).toBe(200);
    await expect(code).resolves.toBe('GOOD');
  });

  it('rejects when the login fails', async () => {
    const { code, server } = startCallbackServer(0, 'S');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    const rejected = expect(code).rejects.toThrow('OAuth authorization failed: access_denied');
    expect(await hit(`http://127.0.0.1:${port}/callback?error=access_denied&state=S`)).toBe(400);
    await rejected;
  });
});

describe('createBearerTokenProvider', () => {
  it('logs in once for concurrent callers, caches the token, and refreshes on demand', async () => {
    const tokens = vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      const params = new URLSearchParams(init.body);
      const grant = params.get('grant_type');
      return new Response(
        JSON.stringify({
          access_token: grant === 'refresh_token' ? 'access-2' : 'access-1',
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: 'refresh-1',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', tokens);
    const provider = createBearerTokenProvider(KEY, 0);

    expect(await Promise.all([provider(), provider()])).toEqual(['access-1', 'access-1']);
    expect(browser.opened).toHaveLength(1);
    const authorize = new URL(browser.opened[0] as string);
    expect(authorize.origin + authorize.pathname).toBe(
      'https://sub.authentication.eu10.hana.ondemand.com/oauth/authorize',
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const exchange = new URLSearchParams(tokens.mock.calls[0]?.[1].body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('CODE-1');
    expect(exchange.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    expect(tokens.mock.calls[0]?.[1].headers.Authorization).toBe(
      `Basic ${Buffer.from('sb-client:sec').toString('base64')}`,
    );

    expect(await provider()).toBe('access-1');
    expect(tokens).toHaveBeenCalledTimes(1);

    expect(await provider({ forceRefresh: true })).toBe('access-2');
    expect(new URLSearchParams(tokens.mock.calls[1]?.[1].body).get('refresh_token')).toBe('refresh-1');
    expect(browser.opened).toHaveLength(1);
  });
});

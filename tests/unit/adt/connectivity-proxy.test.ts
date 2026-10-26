/**
 * The BTP Connectivity proxy (src/adt/http.ts `connectivityProxy`), against a real local proxy that,
 * like SAP's, refuses CONNECT and forwards plain HTTP only.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AdtHttpClient } from '../../../src/adt/http.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
}

let proxy: Server | undefined;

afterEach(async () => {
  await new Promise((resolve) => proxy?.close(resolve) ?? resolve(undefined));
  proxy = undefined;
});

async function startProxy(seen: Seen[]): Promise<number> {
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    // SAP hands out the CSRF token on the fetch probe.
    res.writeHead(200, {
      ...(req.method === 'HEAD' ? { 'x-csrf-token': 'T' } : {}),
      'set-cookie': 'SAP_SESSIONID_A4H_001=s1; path=/',
    });
    res.end('ok');
  });
  server.on('connect', (req, socket) => {
    seen.push({ method: 'CONNECT', url: req.url ?? '', headers: req.headers });
    socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n');
  });
  proxy = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('the Connectivity proxy', () => {
  it('forwards each request as plain HTTP proxying, with the current token and the user identity', async () => {
    const seen: Seen[] = [];
    const port = await startProxy(seen);
    let token = 'token-1';
    const client = new AdtHttpClient({
      baseUrl: 'http://a4h-virtual:50000',
      client: '001',
      authHeaders: async () => ({ 'SAP-Connectivity-Authentication': 'Bearer user-jwt' }),
      connectivityProxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port,
        getProxyToken: async () => token,
        locationId: 'LOC1',
      },
    });

    await client.get('/sap/bc/adt/core/discovery');
    token = 'token-2';
    // A POST fetches its CSRF token first: HEAD, then the POST.
    await client.post('/sap/bc/adt/debugger/breakpoints', '<x/>', 'application/xml');

    expect(seen.map((request) => request.method)).toEqual(['GET', 'HEAD', 'POST']);
    expect(seen[0]?.url).toMatch(/^http:\/\/a4h-virtual:50000\/sap\/bc\/adt\/core\/discovery\?sap-client=001/);
    expect(seen[0]?.headers).toMatchObject({
      host: 'a4h-virtual:50000',
      'proxy-authorization': 'Bearer token-1',
      'sap-connectivity-scc-location_id': 'LOC1',
      'sap-connectivity-authentication': 'Bearer user-jwt',
    });
    // A renewed token takes over; the session's cookies and CSRF token ride along.
    expect(seen[2]?.headers).toMatchObject({
      'proxy-authorization': 'Bearer token-2',
      'x-csrf-token': 'T',
      cookie: expect.stringContaining('SAP_SESSIONID_A4H_001=s1'),
    });
    // A stateful session goes the same way.
    const session = client.openStatefulSession();
    await session.get('/sap/bc/adt/core/http/systeminformation');
    expect(seen[3]?.headers).toMatchObject({
      'proxy-authorization': 'Bearer token-2',
      'x-sap-adt-sessiontype': 'stateful',
    });
  });
});

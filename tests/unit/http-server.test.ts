/**
 * The MCP server over Streamable HTTP (src/http-server.ts): authentication, one MCP user per key or
 * token, and the tools against the fake SAP — driven by the SDK's own HTTP client.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type HttpConfig, loadHttpConfig } from '../../src/config.js';
import {
  createHttpApp,
  type HttpSap,
  type HttpSystems,
  httpSap,
  lazyConnections,
  listen,
} from '../../src/http-server.js';
import { setDebugTimingsForTests } from '../../src/tools/debug-capture.js';
import { resetDebuggingForTests } from '../../src/tools/debug-registry.js';
import { openDebugSessionId } from '../../src/tools/debug-session.js';
import { createConnection, installFakeSap } from '../helpers/fake-sap.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

const KEY_A = 'key-a-0123456789abcdef';
const KEY_B = 'key-b-0123456789abcdef';
const config: Pick<HttpConfig, 'port' | 'apiKeys' | 'allowedOrigins'> = {
  port: 0,
  apiKeys: [KEY_A, KEY_B],
  allowedOrigins: [],
};

let server: Server | undefined;
const clients: Client[] = [];

async function serve(sap: HttpSap, env: NodeJS.ProcessEnv = {}, httpConfig = config): Promise<string> {
  server = await listen(createHttpApp(httpConfig, sap, env), 0, '127.0.0.1');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function mcpClient(base: string, key: string, path = '/mcp'): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  clients.push(client);
  return client;
}

const XSUAA_ENV = {
  VCAP_SERVICES: JSON.stringify({
    xsuaa: [
      {
        credentials: {
          url: 'https://sub.authentication.eu10.hana.ondemand.com',
          clientid: 'sb-abapdbg!t1',
          clientsecret: 'secret',
          xsappname: 'abapdbg!t1',
          uaadomain: 'authentication.eu10.hana.ondemand.com',
        },
      },
    ],
  }),
};

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';

beforeAll(() => {
  setDebugTimingsForTests({ armDelayMs: 0, triggerSettleMs: 200 });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server?.closeAllConnections();
  server = undefined;
  await resetDebuggingForTests();
  mockFetch.mockReset();
});

describe('the MCP server over HTTP', () => {
  it('answers /health openly and /mcp only with a credential', async () => {
    const base = await serve({ problems: [] });
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ok', name: 'abap-debugger-mcp' });
    const anonymous = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(anonymous.status).toBe(401);
    const wrongKey = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-key-of-this-server', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrongKey.status).toBe(401);
  });

  it('refuses to start without any way to authenticate callers', () => {
    expect(() => createHttpApp({ ...config, apiKeys: [] }, { problems: [] }, {})).toThrow();
  });

  it('serves the tools to each caller on their own connection, and keeps sessions apart', async () => {
    installFakeSap(mockFetch, { hit: true });
    const connect = vi.fn(async () => createConnection());
    const base = await serve({ problems: [], connect });
    const alice = await mcpClient(base, KEY_A);
    const bob = await mcpClient(base, KEY_B);

    const tools = await alice.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'abap_debug',
      'abap_debug_session',
      'abap_breakpoints',
      'abap_source',
      'abap_search',
    ]);
    // Listing the tools reaches no SAP system.
    expect(connect).not.toHaveBeenCalled();

    const started = JSON.parse(
      text(
        await alice.callTool({
          name: 'abap_debug',
          arguments: { type: 'CLAS', name: 'ZCL_ORDER', line: 9, interactive: true },
        }),
      ),
    );
    expect(started).toMatchObject({ hit: true, session: 'S1', position: { line: 9 } });
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 'api-key-1' }), 'client:api-key-1');
    expect(openDebugSessionId('client:api-key-1')).toBe('S1');

    // Bob cannot drive Alice's session.
    const bobStep = await bob.callTool({ name: 'abap_debug_session', arguments: { action: 'step', session: 'S1' } });
    expect(text(bobStep)).toContain('No interactive debug session is open');

    const step = JSON.parse(text(await alice.callTool({ name: 'abap_debug_session', arguments: { action: 'step' } })));
    expect(step).toMatchObject({ session: 'S1', position: { line: 10 } });
    const end = JSON.parse(text(await alice.callTool({ name: 'abap_debug_session', arguments: { action: 'end' } })));
    expect(end).toMatchObject({ ended: true, release: { released: true } });
  });

  it('reports what keeps the server from reaching SAP to every tool call', async () => {
    const base = await serve({ problems: ['SAP_URL is not set.'] });
    const client = await mcpClient(base, KEY_A);
    const result = await client.callTool({ name: 'abap_search', arguments: { query: 'Z*' } });
    expect(text(result)).toContain('SAP_URL is not set.');
  });

  it('says when it cannot open the caller’s SAP connection', async () => {
    const base = await serve({
      problems: [],
      connect: async () => {
        throw new Error('Destination A4H_PP returned no identity for this user');
      },
    });
    const client = await mcpClient(base, KEY_A);
    const result = await client.callTool({ name: 'abap_search', arguments: { query: 'Z*' } });
    expect(text(result)).toBe('Cannot open your SAP connection: Destination A4H_PP returned no identity for this user');
  });

  it('offers OAuth discovery for MCP clients when XSUAA is bound', async () => {
    const base = await serve({ problems: [] }, XSUAA_ENV, { ...config, apiKeys: [] });
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({ resource_name: 'ABAP Debugger', scopes_supported: ['debug'] });
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toHaveProperty('registration_endpoint');
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata');
  });
});

describe('several SAP systems from one deployment', () => {
  const DEV = 'http://dev:8000';
  const QAS = 'http://qas:8000';
  /** Two systems that serve, one refused, and a destination that named no system. */
  function systems(): HttpSystems & { connects: string[] } {
    const connects: string[] = [];
    const serving = (baseUrl: string): HttpSap => ({
      problems: [],
      sapGui: true,
      connect: async (_authInfo, owner) => {
        connects.push(`${baseUrl} ${owner}`);
        return createConnection({ baseUrl });
      },
    });
    const routes: Record<string, HttpSap> = {
      'S4D/100': serving(DEV),
      'S4Q/100': serving(QAS),
      'S4P/100': {
        problems: ['Destination S4P_BASIC uses BasicAuthentication: every user would debug as one SAP user.'],
      },
    };
    return {
      connects,
      route: async (sid, client) => routes[`${sid.toUpperCase()}/${client}`],
      overview: async () => [
        { destination: 'S4D_PP', route: '/S4D/100/mcp' },
        { destination: 'S4Q_PP', route: '/S4Q/100/mcp' },
        { destination: 'S4P_BASIC', route: '/S4P/100/mcp', problem: 'it uses BasicAuthentication' },
        { destination: 'NO_SID', problem: 'add the additional property sap-sysid' },
      ],
    };
  }
  const publicUrl = 'https://abapdbg.cfapps.eu10.hana.ondemand.com';

  it('serves each system at its own route, and keeps the same user’s sessions on two systems apart', async () => {
    installFakeSap(mockFetch, { hit: true });
    const sap = systems();
    const base = await serve({ problems: [], systems: sap });
    const dev = await mcpClient(base, KEY_A, '/S4D/100/mcp');
    const qas = await mcpClient(base, KEY_A, '/s4q/100/mcp');
    const start = async (client: Client) =>
      JSON.parse(
        text(
          await client.callTool({
            name: 'abap_debug',
            arguments: { type: 'CLAS', name: 'ZCL_ORDER', line: 9, interactive: true },
          }),
        ),
      );
    // The same MCP user and SAP user, at once: one session per system.
    expect(await start(dev)).toMatchObject({ hit: true, session: 'S1' });
    expect(await start(qas)).toMatchObject({ hit: true, session: 'S2' });
    expect(sap.connects).toEqual([`${DEV} client:api-key-1`, `${QAS} client:api-key-1`]);
    const devKey = createConnection({ baseUrl: DEV }).http.systemKey;
    const qasKey = createConnection({ baseUrl: QAS }).http.systemKey;
    expect(openDebugSessionId('client:api-key-1', devKey)).toBe('S1');
    expect(openDebugSessionId('client:api-key-1', qasKey)).toBe('S2');
    // Each route drives its own system's session.
    const step = JSON.parse(text(await qas.callTool({ name: 'abap_debug_session', arguments: { action: 'step' } })));
    expect(step).toMatchObject({ session: 'S2', position: { line: 10 } });
    for (const client of [dev, qas]) {
      const end = JSON.parse(text(await client.callTool({ name: 'abap_debug_session', arguments: { action: 'end' } })));
      expect(end).toMatchObject({ ended: true });
    }
  });

  it('points /mcp to the routes, says why a route serves nobody, and knows no other system', async () => {
    const base = await serve({ problems: [], systems: systems() }, {}, { ...config, publicUrl } as typeof config);
    const overview = await mcpClient(base, KEY_A);
    const listed = text(await overview.callTool({ name: 'abap_search', arguments: { query: 'Z*' } }));
    expect(listed).toContain('This deployment serves several SAP systems, one MCP route each');
    expect(listed).toContain(`- ${publicUrl}/S4D/100/mcp — destination S4D_PP\n`);
    expect(listed).toContain(
      `- ${publicUrl}/S4P/100/mcp — destination S4P_BASIC, not serving: it uses BasicAuthentication`,
    );
    expect(listed).toContain('- destination NO_SID, no route: add the additional property sap-sysid');

    const refused = await mcpClient(base, KEY_A, '/S4P/100/mcp');
    const answer = text(await refused.callTool({ name: 'abap_search', arguments: { query: 'Z*' } }));
    expect(answer).toContain('Destination S4P_BASIC uses BasicAuthentication');
    expect(answer).toContain('The administrator of this deployment fixes them');

    const post = (path: string, key?: string) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await post('/S4D/100/mcp')).status).toBe(401);
    const unknown = await post('/S4X/100/mcp', KEY_A);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'No SAP system S4X client 100 on this deployment.' });
    // Segments that name no system are no route of a system.
    expect((await post('/a/b/mcp', KEY_A)).status).toBe(404);
  });

  it('gives each route its own OAuth protected-resource metadata', async () => {
    const base = await serve({ problems: [], systems: systems() }, XSUAA_ENV, {
      ...config,
      apiKeys: [],
      publicUrl,
    } as typeof config);
    const resource = await fetch(`${base}/.well-known/oauth-protected-resource/S4D/100/mcp`);
    expect(await resource.json()).toEqual({
      resource: `${publicUrl}/S4D/100/mcp`,
      authorization_servers: [`${publicUrl}/`],
      scopes_supported: ['debug'],
      resource_name: 'ABAP Debugger — S4D/100',
    });
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/S4X/100/mcp`)).status).toBe(404);
    // /mcp keeps its own.
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    const unauthorized = await fetch(`${base}/S4Q/100/mcp`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain(
      `resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/S4Q/100/mcp"`,
    );
  });
});

describe('the HTTP configuration', () => {
  it('binds where Cloud Foundry routes, and checks keys and secrets', () => {
    expect(loadHttpConfig({ PORT: '8081' }).http).toMatchObject({ port: 8081, host: '0.0.0.0', apiKeys: [] });
    expect(loadHttpConfig({}).http).toMatchObject({ port: 8080, host: '127.0.0.1' });
    expect(loadHttpConfig({ ABAP_DEBUGGER_API_KEYS: 'short' }).problems).toEqual([
      'ABAP_DEBUGGER_API_KEYS: each key must be at least 20 characters (a random secret, e.g. openssl rand -hex 24).',
    ]);
    expect(
      loadHttpConfig({ SAP_BTP_DESTINATION: 'A4H_PP', ABAP_DEBUGGER_ALLOW_SHARED_USER: 'true' }).http,
    ).toMatchObject({ btpDestination: 'A4H_PP', allowSharedUser: true });
    expect(loadHttpConfig({ SAP_BTP_DESTINATIONS: 'S4D_PP, S4Q_PP' }).http).toMatchObject({
      btpDestinations: ['S4D_PP', 'S4Q_PP'],
    });
    expect(loadHttpConfig({ SAP_BTP_DESTINATION: 'A4H_PP', SAP_BTP_DESTINATIONS: 'S4D_PP,S4D_PP' }).problems).toEqual([
      'Set SAP_BTP_DESTINATION (one system, at /mcp) or SAP_BTP_DESTINATIONS (several, at /<SID>/<client>/mcp each), not both.',
      'SAP_BTP_DESTINATIONS names S4D_PP more than once.',
    ]);
    const several = httpSap(loadHttpConfig({ SAP_BTP_DESTINATIONS: 'S4D_PP,S4Q_PP' }).http as HttpConfig, {});
    expect(several.systems).toBeDefined();
    expect(several.connect).toBeUndefined();
  });

  it('refuses one SAP identity for every caller unless allowed, and a browser login on a server', async () => {
    const http = loadHttpConfig({}).http as HttpConfig;
    const sap = { SAP_URL: 'https://sap.example', SAP_USER: 'DEV', SAP_PASSWORD: 'pw' };
    expect(httpSap(http, sap).problems[0]).toContain('every MCP user would debug as SAP user DEV');
    const shared = httpSap({ ...http, allowSharedUser: true }, sap);
    expect(shared.problems).toEqual([]);
    expect((await shared.connect?.(undefined, 'a'))?.logonUser).toBe('DEV');
    expect(httpSap({ ...http, btpDestination: 'A4H_PP' }, {}).connect).toBeDefined();
  });

  it('retries a destination that could not be resolved', async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('Destination service unavailable'))
      .mockResolvedValueOnce({ connect: async () => createConnection() });
    const connect = lazyConnections(open);
    await expect(connect(undefined, 'a')).rejects.toThrow('Destination service unavailable');
    await expect(connect(undefined, 'a')).resolves.toBeDefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
});

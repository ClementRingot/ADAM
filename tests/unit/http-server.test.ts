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
import { createHttpApp, type HttpSap, httpSap, lazyConnections, listen } from '../../src/http-server.js';
import { setDebugTimingsForTests } from '../../src/tools/debug-capture.js';
import { forgetDebugSessionsForTests, openDebugSessionId } from '../../src/tools/debug-session.js';
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

async function mcpClient(base: string, key: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  clients.push(client);
  return client;
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';

beforeAll(() => {
  setDebugTimingsForTests({ armDelayMs: 0, triggerSettleMs: 200 });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server?.closeAllConnections();
  server = undefined;
  forgetDebugSessionsForTests();
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
    const env = {
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
    const base = await serve({ problems: [] }, env, { ...config, apiKeys: [] });
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({ resource_name: 'ABAP Debugger', scopes_supported: ['debug'] });
    const metadata = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toHaveProperty('registration_endpoint');
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata');
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

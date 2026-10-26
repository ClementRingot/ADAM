/** The MCP surface (src/server.ts, src/tools/definitions.ts): what the model sees and how calls fail. */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AdtApiError, AdtNetworkError } from '../../src/adt/errors.js';
import type { AdtHttpClient } from '../../src/adt/http.js';
import { callTool, createMcpServer, SERVER_INSTRUCTIONS } from '../../src/server.js';
import { listTools } from '../../src/tools/definitions.js';
import { VERSION } from '../../src/version.js';

const failingConnection = (error: unknown) => ({
  http: { get: vi.fn().mockRejectedValue(error) } as unknown as AdtHttpClient,
});

describe('tools/list', () => {
  const tools = listTools();

  it('offers the capture, its interactive session and two helpers, with schemas generated from the validation', () => {
    expect(tools.map((tool) => tool.name)).toEqual(['abap_debug', 'abap_debug_session', 'abap_source', 'abap_search']);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.inputSchema).not.toHaveProperty('$schema');
      expect(JSON.stringify(tool.inputSchema)).not.toContain(String(Number.MAX_SAFE_INTEGER));
      for (const [name, property] of Object.entries(tool.inputSchema.properties as Record<string, object>)) {
        expect(property, `${tool.name}.${name}`).toHaveProperty('description');
      }
    }
    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(tools[1]?.annotations.readOnlyHint).toBe(false);
    expect(tools[2]?.annotations.readOnlyHint).toBe(true);
  });

  it('describes one move per session call, each action with its own fields', () => {
    const session = tools[1]?.inputSchema as unknown as { properties: Record<string, any>; required: string[] };
    expect(session.required).toEqual(['action']);
    expect(session.properties.action).toMatchObject({ enum: ['step', 'continue', 'inspect', 'end'] });
    expect(Object.keys(session.properties)).toEqual([
      'action',
      'session',
      'stepMode',
      'count',
      'until',
      'toLine',
      'timeoutSeconds',
      'variables',
      'stack',
      'terminate',
      'maxSeconds',
      'maxResultKB',
    ]);
    const debug = tools[0]?.inputSchema as unknown as { properties: Record<string, any> };
    expect(debug.properties.interactive).toMatchObject({ type: 'boolean' });
    expect(debug.properties.steps).toMatchObject({ maximum: 10000 });
    expect(debug.properties.until).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('keeps the breakpoint item schema strict and bounded', () => {
    const debug = tools[0]?.inputSchema as unknown as { properties: Record<string, any> };
    expect(debug.properties.breakpoints).toMatchObject({ type: 'array', maxItems: 20 });
    expect(debug.properties.breakpoints.items).toMatchObject({ additionalProperties: false });
    expect(Object.keys(debug.properties.breakpoints.items.properties)).toEqual([
      'type',
      'name',
      'line',
      'method',
      'include',
      'condition',
      'message',
      'statement',
      'exceptionClass',
      'hits',
    ]);
    expect(debug.properties.breakpoints.items.properties.message).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['id', 'number'],
    });
    expect(debug.properties.timeoutSeconds).toMatchObject({ type: 'integer', minimum: 1, maximum: 240 });
  });

  it('reports the package version and the workflow instructions', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(SERVER_INSTRUCTIONS).toContain('abap_source');
    expect(createMcpServer({ problems: [] })).toBeDefined();
  });
});

describe('tools/call', () => {
  it('answers an unknown tool and invalid input without touching SAP', async () => {
    const connection = failingConnection(new Error('must not be called'));
    const unknown = await callTool({ connection, problems: [] }, 'abap_run', {});
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content[0]?.text).toContain('Tools: abap_debug, abap_debug_session, abap_source, abap_search');
    const invalid = await callTool({ connection, problems: [] }, 'abap_search', { query: '' });
    expect(invalid.content[0]?.text).toBe(
      'Invalid abap_search input:\nquery: Too small: expected string to have >=1 characters',
    );
    expect(connection.http.get).not.toHaveBeenCalled();
  });

  it('reports the configuration problems to every call', async () => {
    const result = await callTool({ problems: ['SAP_URL is not set.'] }, 'abap_search', { query: 'Z*' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('abap-debugger is not configured:\n- SAP_URL is not set.');
  });

  it("turns SAP's refusals and network failures into readable tool errors", async () => {
    const forbidden = new AdtApiError(
      '<exc:exception xmlns:exc="x"><localizedMessage>No authorization for S_DEVELOP</localizedMessage></exc:exception>',
      403,
      '/sap/bc/adt/repository/informationsystem/search?query=Z',
      '<exc:exception xmlns:exc="x"><localizedMessage>No authorization for S_DEVELOP</localizedMessage></exc:exception>',
    );
    const refused = await callTool({ connection: failingConnection(forbidden), problems: [] }, 'abap_search', {
      query: 'Z*',
    });
    expect(refused.content[0]?.text).toBe(
      'SAP refused the request (HTTP 403 at /sap/bc/adt/repository/informationsystem/search): No authorization for S_DEVELOP The SAP user lacks an authorization for this; debugging needs S_DEVELOP with OBJTYPE DEBUG, ACTVT 03.',
    );
    const offline = await callTool(
      { connection: failingConnection(new AdtNetworkError('connect ECONNREFUSED')), problems: [] },
      'abap_search',
      { query: 'Z*' },
    );
    expect(offline.content[0]?.text).toBe(
      'ADT network error: connect ECONNREFUSED. Check SAP_URL and the network path to the SAP system (SAP_PROXY behind a corporate proxy).',
    );
  });
});

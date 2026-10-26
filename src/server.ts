/**
 * The MCP server: three tools over one SAP connection. Invalid input is answered before anything
 * reaches SAP; SAP's own refusals come back as tool errors the model can act on.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { parseDebuggerException } from './adt/debugger.js';
import { AdtApiError, AdtNetworkError } from './adt/errors.js';
import type { SapConnection } from './tools/debug-capture.js';
import { listTools, TOOLS } from './tools/definitions.js';
import { errorResult, formatIssues, type ToolResult } from './tools/result.js';
import { VERSION } from './version.js';

export interface ServerState {
  connection?: SapConnection;
  /** Why there is no connection (configuration problems), reported by every tool call. */
  problems: string[];
}

export const SERVER_INSTRUCTIONS = [
  'ABAP debugger for the connected SAP system. Workflow: find the object (abap_search), read its active source with line numbers (abap_source; a class method with method=…), then capture one run with abap_debug — breakpoints, the trigger that runs the code, and every variable you want to see, all in the same call.',
  'A capture follows one run of the program and releases it before returning: nothing can be inspected afterwards, so ask for all variables, steps and stops up front, and run another capture to look again.',
  'Triggers: unittest runs the harmless ABAP Unit tests (of triggerName or the breakpoint object); http GETs an OData path; none waits while the user runs the code themselves as the same SAP user (a Fiori app, a report).',
  'Not sure where the code runs? Stop on what it does instead of a line: the message it issues, the exception it raises, a statement kind such as COMMIT WORK.',
].join('\n');

function describeError(err: unknown): string {
  if (err instanceof AdtApiError) {
    const exception = parseDebuggerException(err.responseBody);
    const sap = exception?.conflictText ?? exception?.message ?? err.sapMessage;
    const hint =
      err.statusCode === 401
        ? ' Check the credentials: SAP_USER/SAP_PASSWORD, the cookies, or the BTP login.'
        : err.statusCode === 403
          ? ' The SAP user lacks an authorization for this; debugging needs S_DEVELOP with OBJTYPE DEBUG, ACTVT 03.'
          : '';
    return `SAP refused the request (HTTP ${err.statusCode} at ${err.path.split('?', 1)[0]}): ${sap}${hint}`;
  }
  if (err instanceof AdtNetworkError) {
    return `${err.message.replace(/\.?$/, '.')} Check SAP_URL and the network path to the SAP system (SAP_PROXY behind a corporate proxy).`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** One tool call: validate, then run on the connection, never letting an exception escape. */
export async function callTool(state: ServerState, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return errorResult(`Unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(', ')}.`);
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return errorResult(`Invalid ${name} input:\n${formatIssues(parsed.error)}`);
  if (!state.connection) {
    return errorResult(
      `abap-debugger is not configured:\n- ${state.problems.join('\n- ')}\nSet these in the env block of the MCP client's abap-debugger entry, then restart the server.`,
    );
  }
  try {
    return await tool.run(state.connection, parsed.data as never);
  } catch (err) {
    return errorResult(describeError(err));
  }
}

export function createMcpServer(state: ServerState): Server {
  const server = new Server(
    { name: 'abap-debugger', version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(state, request.params.name, request.params.arguments),
  );
  return server;
}

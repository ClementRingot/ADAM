/**
 * The MCP server: three tools over one SAP connection. Invalid input is answered before anything
 * reaches SAP; SAP's own refusals come back as tool errors the model can act on.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { SapConnection, ToolContext } from './tools/connection.js';
import { throttledProgress } from './tools/debug-limits.js';
import { listTools, TOOLS } from './tools/definitions.js';
import { describeError, errorResult, formatIssues, type ToolResult } from './tools/result.js';
import { VERSION } from './version.js';

export interface ServerState {
  connection?: SapConnection;
  /** Over HTTP: the calling user's connection, opened on the first tool call that needs SAP. */
  connect?: () => Promise<SapConnection>;
  /** Over HTTP: the calling MCP user, who alone reaches their interactive session. */
  owner?: string;
  /** Why there is no connection (configuration problems), reported by every tool call. */
  problems: string[];
}

export const SERVER_INSTRUCTIONS = [
  'ABAP debugger for the connected SAP system. Workflow: find the object (abap_search), read its active source with line numbers (abap_source; a class method with method=…), then capture one run with abap_debug — breakpoints, the trigger that runs the code, and every variable you want to see, all in the same call.',
  'A capture follows one run of the program and releases it before returning: nothing can be inspected afterwards, so ask for all variables, steps and stops up front, and run another capture to look again.',
  'Triggers: unittest runs the harmless ABAP Unit tests (of triggerName or the breakpoint object); http GETs an OData path; none waits while the user runs the code themselves as the same SAP user (a Fiori app, a report).',
  'Not sure where the code runs? Stop on what it does instead of a line: the message it issues, the exception it raises, a statement kind such as COMMIT WORK — or, from a first stop, wherever a variable changes (watch).',
  'Two modes: one-shot (default) records the whole run in one call — stops, variables, and as many steps as maxSeconds/maxResultKB allow (past 20 steps a compact trace). Interactive (interactive: true) holds the program at its first stop: then abap_debug_session step / continue / inspect / end, one move per call, until you end it — end it when done, the program holds a work process meanwhile.',
  'A call that would outlast its time (default 50 s) answers running: true with a session id, and the work goes on: call abap_debug_session action wait for its answer.',
].join('\n');

/** One tool call: validate, then run on the connection, never letting an exception escape. */
export async function callTool(
  state: ServerState,
  name: string,
  args: unknown,
  context: ToolContext = {},
): Promise<ToolResult> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return errorResult(`Unknown tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(', ')}.`);
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return errorResult(`Invalid ${name} input:\n${formatIssues(parsed.error)}`);
  if (!state.connection && !state.connect) {
    return errorResult(
      `abap-debugger is not configured:\n- ${state.problems.join('\n- ')}\nSet these in the env block of the MCP client's abap-debugger entry, then restart the server.`,
    );
  }
  let connection = state.connection;
  if (!connection) {
    try {
      connection = await (state.connect as () => Promise<SapConnection>)();
    } catch (err) {
      return errorResult(`Cannot open your SAP connection: ${describeError(err)}`);
    }
  }
  try {
    return await tool.run(connection, parsed.data as never, {
      ...context,
      ...(state.owner ? { owner: state.owner } : {}),
    });
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
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Progress only when the client asked for it (a progressToken); a cancelled call ends early.
    const progressToken = request.params._meta?.progressToken;
    let sent = 0;
    const progress =
      progressToken === undefined
        ? undefined
        : throttledProgress((message) => {
            sent += 1;
            extra
              .sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: sent, message },
              })
              .catch(() => {});
          });
    return callTool(state, request.params.name, request.params.arguments, {
      signal: extra.signal,
      ...(progress ? { progress } : {}),
    });
  });
  return server;
}

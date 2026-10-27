/**
 * The tools the model sees. Each JSON schema is generated from the Zod schema that validates the
 * call, so the two cannot drift; tests/unit/server.test.ts snapshots the result.
 */

import { z } from 'zod';
import { BreakpointsInputSchema, handleBreakpoints } from './breakpoints.js';
import type { SapConnection, ToolContext } from './connection.js';
import { handleDebugCapture } from './debug-capture.js';
import { type DebugInput, DebugInputSchema } from './debug-input.js';
import { handleDebugSession, startDebugSession } from './debug-session.js';
import { DebugSessionInputSchema } from './debug-session-input.js';
import type { ToolResult } from './result.js';
import { handleSearch, SearchInputSchema } from './search.js';
import { handleSource, SourceInputSchema } from './source.js';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  run: (conn: SapConnection, input: never, context: ToolContext) => Promise<ToolResult>;
}

const DEBUG_DESCRIPTION = [
  'Debug ABAP code on the connected SAP system in ONE call: arm breakpoints (lines or class methods in CLAS, PROG or FUNC objects, optionally with an ABAP condition; or where a message is issued, a statement kind runs, an exception is raised), run the code (its harmless ABAP Unit tests, an OData GET, or wait while you run it yourself as the same SAP user), and at every stop of that one run record the position, the call stack, the variables and optional steps — then release the program and remove the breakpoints.',
  'The program runs once, however many stops you ask for: a breakpoint in a loop with hits 5 shows five iterations of the same run. Nothing stays stopped after the call returns, so name every variable you need up front; to look again, run another capture — or start an interactive session (interactive: true) and decide each move with abap_debug_session.',
  'Lines are numbered as abap_source shows the ACTIVE source. Per capture: at most 20 breakpoints and 50 stops, and as many steps as the budgets allow — the run is followed until its result size (maxResultKB, default 40 KB) or inspection time (maxSeconds, default 120 s) runs out, then goes on without stopping. Past 20 steps from one stop, the steps come back as a compact trace; until ends them at a line or once a variable changed.',
  "Result: hit; breakpoints (set, with the hits they made, or refused with SAP's reason); debuggee; stops (at, stoppedAt, stack and variables on a breakpoint's first stop — its later stops carry only values, unchanged structures and tables marked so; steps, or a trace of a long run: path = the lines executed per frame, (9-12)×300 = a loop, changes = values where they changed); release; trigger; warnings. Without a stop: reason and hint.",
  'A call answers within ABAP_DEBUGGER_CALL_SECONDS (default 50 s). A capture still waiting for its stop or following its run then answers running: true with its session id, and goes on: abap_debug_session action wait picks up its result, action end stops it.',
  "It never changes variables or the program flow, never debugs system code, and only debugs the session's own SAP user; it refuses when Eclipse or VS Code already debugs that user.",
].join('\n');

const SESSION_DESCRIPTION = [
  'One move of the program an interactive capture holds (abap_debug with interactive: true), then where it stands — its position, the code around it, the watched variables — so you decide the next move from what you see.',
  'step: statement by statement — stepMode over (default), into a call, out to the caller; count steps at once (past 20 they come back as a compact trace), until a line or until a variable changed. continue: run to the next breakpoint (each stop as in abap_debug), or to toLine. inspect: read any variables where it stands (or the whole frame), and the call stack. end: let the program run to its end — or terminate: true to abort it, e.g. before it commits.',
  'wait: a move (or a capture) that outlasts its call — ABAP_DEBUGGER_CALL_SECONDS, default 50 s — answers running: true and goes on in the background; wait returns its answer once it is done.',
  "The program waits in a work process between calls, so end the session when you are done; it is also released after a while without a call (ABAP_DEBUGGER_IDLE_SECONDS, default 120 s) and after ABAP_DEBUGGER_SESSION_SECONDS (default 15 min). Every answer says how long it has left. Apart from terminate, it never changes variables or the program's flow.",
].join('\n');

export const TOOLS: ToolDefinition[] = [
  {
    name: 'abap_debug',
    title: 'Capture one ABAP run in the debugger',
    description: DEBUG_DESCRIPTION,
    schema: DebugInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: ((conn: SapConnection, input: DebugInput, context: ToolContext) =>
      input.interactive
        ? startDebugSession(conn, input, context)
        : handleDebugCapture(conn, input, context)) as ToolDefinition['run'],
  },
  {
    name: 'abap_debug_session',
    title: 'Drive an interactive ABAP debug session',
    description: SESSION_DESCRIPTION,
    schema: DebugSessionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: handleDebugSession as ToolDefinition['run'],
  },
  {
    name: 'abap_breakpoints',
    title: 'List or remove what the debugger left for your SAP user',
    description:
      "list: your capture or interactive session on this server, the breakpoints a capture could not remove (its server process was killed, or SAP refused the removal — the next capture removes them too), and whether a debugger listener is registered for your SAP user on SAP. delete: end your capture or session and remove those leftovers; listener: true also removes the listener — SAP removes it by user, Eclipse's included. Use it when a capture is refused because a debugger listens, or the user's requests stop at odd places. SAP has no request that lists every breakpoint of a user: Eclipse's own are in Eclipse.",
    schema: BreakpointsInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: handleBreakpoints as ToolDefinition['run'],
  },
  {
    name: 'abap_source',
    title: 'Read active ABAP source with line numbers',
    description:
      "The ACTIVE source with its line numbers: of a class (main source or a local-class include), a program or a function module — numbered as abap_debug breakpoints use them — and of interfaces, includes, CDS views, behavior and service definitions. A service binding (SRVB) shows its service definitions: from a Fiori app's binding, follow SRVD → CDS views → BDEF → behavior pool to the code to debug. Narrow a source with method, lineStart/lineEnd or grep.",
    schema: SourceInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: handleSource as ToolDefinition['run'],
  },
  {
    name: 'abap_search',
    title: 'Find ABAP objects',
    description:
      'Find repository objects of any type by name, name start or pattern: classes, interfaces, programs and includes, function groups and modules, CDS views, behavior definitions, service definitions and bindings, UI5 apps… — each with its exact name, type, what it is, package and description. E.g. the service binding and definition behind a Fiori app (then the CDS views and behavior pools they lead to), or the unit-test class to use as triggerName.',
    schema: SearchInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: handleSearch as ToolDefinition['run'],
  },
];

/** Drop what carries no meaning for the model: the `$schema` URI and the safe-integer bounds of `.int()`. */
function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (key === 'maximum' && child === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && child === Number.MIN_SAFE_INTEGER) continue;
    out[key] = clean(child);
  }
  return out;
}

export function listTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: clean(z.toJSONSchema(tool.schema, { io: 'input' })) as { type: 'object'; [key: string]: unknown },
    annotations: tool.annotations,
  }));
}

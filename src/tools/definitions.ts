/**
 * The tools the model sees. Each JSON schema is generated from the Zod schema that validates the
 * call, so the two cannot drift; tests/unit/server.test.ts snapshots the result.
 */

import { z } from 'zod';
import type { SapConnection, ToolContext } from './connection.js';
import { handleDebugCapture } from './debug-capture.js';
import { DebugInputSchema } from './debug-input.js';
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
  'The program runs once, however many stops you ask for: a breakpoint in a loop with hits 5 shows five iterations of the same run. Nothing stays stopped after the call returns, so name every variable you need up front; to look again, run another capture.',
  'Lines are numbered as abap_source shows the ACTIVE source. Per capture: at most 20 breakpoints and 50 stops, and as many steps as the budgets allow — the run is followed until its result size (maxResultKB, default 40 KB) or inspection time (maxSeconds, default 120 s) runs out, then goes on without stopping. Past 20 steps from one stop, the steps come back as a compact trace; until ends them at a line or once a variable changed.',
  "Result: hit; breakpoints (set, with the hits they made, or refused with SAP's reason); debuggee; stops (at, stoppedAt, stack and variables on a breakpoint's first stop — its later stops carry only values, unchanged structures and tables marked so; steps, or a trace of a long run: path = the lines executed per frame, (9-12)×300 = a loop, changes = values where they changed); release; trigger; warnings. Without a stop: reason and hint.",
  "It never changes variables or the program flow, never debugs system code, and only debugs the session's own SAP user; it refuses when Eclipse or VS Code already debugs that user.",
].join('\n');

export const TOOLS: ToolDefinition[] = [
  {
    name: 'abap_debug',
    title: 'Capture one ABAP run in the debugger',
    description: DEBUG_DESCRIPTION,
    schema: DebugInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: handleDebugCapture as ToolDefinition['run'],
  },
  {
    name: 'abap_source',
    title: 'Read active ABAP source with line numbers',
    description:
      'The ACTIVE source of a class (main source or a local-class include), a program or a function module, with the line numbers abap_debug breakpoints use. Narrow it with method, lineStart/lineEnd or grep.',
    schema: SourceInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: handleSource as ToolDefinition['run'],
  },
  {
    name: 'abap_search',
    title: 'Find ABAP objects',
    description:
      'Find objects by name or pattern (quick search): their exact name, type, package and description — e.g. the class behind a service, or the unit-test class to use as triggerName.',
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

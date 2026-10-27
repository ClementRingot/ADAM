/**
 * abap_debug_session input: one move of an interactive session per call. The fields each action
 * takes are checked here, so a misplaced one is named before anything reaches SAP.
 */

import { z } from 'zod';
import { UntilSchema } from './debug-input.js';

const ACTION_FIELDS: Record<string, readonly string[]> = {
  step: ['stepMode', 'count', 'until', 'variables', 'maxSeconds', 'maxResultKB'],
  continue: ['toLine', 'timeoutSeconds', 'variables', 'maxResultKB'],
  inspect: ['variables', 'stack', 'maxResultKB'],
  wait: [],
  end: ['terminate'],
};

export const DEBUG_SESSION_INPUT_SHAPE = {
  action: z
    .enum(['step', 'continue', 'inspect', 'wait', 'end'])
    .describe(
      'step: run statement by statement (stepMode, count, until). continue: run on to the next breakpoint, or to toLine. inspect: read variables or the call stack where the program stands. wait: the answer of a capture or move that outlasted its call (it said running: true). end: let the program run to its end (or terminate it) and close the session; on a capture still running, stop it.',
    ),
  session: z
    .string()
    .max(20)
    .optional()
    .describe('The session id abap_debug returned (default: your current capture or session).'),
  stepMode: z
    .enum(['over', 'into', 'out'])
    .optional()
    .describe('step: over (default) stays in the method; into follows a call; out returns to the caller.'),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe(
      'step: how many steps (default 1; with until and no count: until it holds). More than 20 come back as a compact trace; maxSeconds and maxResultKB bound the run.',
    ),
  until: UntilSchema.optional().describe(
    'step: end the steps early, once the program stands on a line of the source they started in, and/or once a variable changed.',
  ),
  toLine: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'continue: run to this line of the source the program stands in instead of the next breakpoint (it still stops at a breakpoint on the way).',
    ),
  timeoutSeconds: z.coerce
    .number()
    .int()
    .min(1, 'timeoutSeconds must be 1-900.')
    .max(900, 'timeoutSeconds must be 1-900.')
    .optional()
    .describe('continue: how long to wait for the next stop (1-900, default 60).'),
  variables: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe(
      "step / continue: the variables to watch from now on, read after every step and at every stop (replacing the ones named before). inspect: read these now, structures expanded and tables' first rows (default: every variable of the frame).",
    ),
  stack: z.boolean().optional().describe('inspect: include the call stack.'),
  terminate: z
    .boolean()
    .optional()
    .describe(
      'end: abort the program where it stands instead of letting it run to its end — e.g. so that it does not commit. Its open database changes are rolled back.',
    ),
  maxSeconds: z.coerce
    .number()
    .int()
    .min(10)
    .max(3600)
    .optional()
    .describe("step: time budget of this call (default 120); the server's ceiling applies."),
  maxResultKB: z.coerce
    .number()
    .int()
    .min(5)
    .max(1000)
    .optional()
    .describe("Size budget of this answer in KB (default 40); the server's ceiling applies."),
};

export const DebugSessionInputSchema = z
  .object(DEBUG_SESSION_INPUT_SHAPE)
  .strict()
  .superRefine((input, ctx) => {
    const allowed = new Set(['action', 'session', ...(ACTION_FIELDS[input.action] ?? [])]);
    for (const [field, value] of Object.entries(input)) {
      if (value !== undefined && !allowed.has(field)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} does not apply to action "${input.action}" (it takes ${ACTION_FIELDS[input.action]?.join(', ') || 'nothing else'}).`,
        });
      }
    }
  });

export type DebugSessionInput = z.infer<typeof DebugSessionInputSchema>;

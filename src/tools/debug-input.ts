/**
 * abap_debug input: one Zod schema — the JSON schema the model sees is generated from it
 * (src/tools/definitions.ts) — plus the cross-field rules. Ported from ARC-1
 * (src/handlers/debug-input.ts), with the descriptions ARC-1's schema budget had to cut.
 */

import { z } from 'zod';
import { normalizeObjectType } from '../abap/object-types.js';

const LINE_TYPES = new Set(['CLAS', 'PROG', 'FUNC']);
const EXCEPTION_CLASS = /^[A-Za-z0-9_/]{1,30}$/;

/** A message as a MESSAGE statement issues it: class, number, and optionally its type. */
const MessageSchema = z
  .object({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_/]{1,20}$/, 'message.id must be a message class, e.g. ZSD')
      .describe('Message class, e.g. ZSD.'),
    number: z.coerce
      .string()
      .regex(/^\d{1,3}$/, 'message.number must be 1-3 digits, e.g. 042')
      .describe('Message number, e.g. 042.'),
    type: z
      .string()
      .regex(/^[SIWEAX]$/i, 'message.type must be one of S, I, W, E, A, X')
      .optional()
      .describe('S, I, W, E, A or X; any type when omitted.'),
  })
  .strict();

/** One stop of the debugged run; type/name default to the top-level ones. */
const DebugBreakpointSchema = z
  .object({
    type: z.string().max(10).optional().describe('CLAS, PROG or FUNC. Default: the top-level type.'),
    name: z.string().max(40).optional().describe('Object name. Default: the top-level name.'),
    line: z.coerce
      .number()
      .optional()
      .describe(
        '1-based line of the ACTIVE source, numbered as abap_source shows it (the main source, or the class include named in `include`). A line without a statement moves to the next lines SAP accepts.',
      ),
    method: z
      .string()
      .max(128)
      .optional()
      .describe(
        'CLAS only, instead of line: stop at the first statement of this method — get_total, zif_order~process, or a local-class method such as lhc_travel~validate_dates.',
      ),
    include: z
      .enum(['implementations', 'testclasses'])
      .optional()
      .describe('CLAS only: the local-class include the line or method is in (detected for lhc_/lcl_/ltc_ methods).'),
    condition: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "ABAP condition SAP evaluates at the breakpoint: the run stops there only where it holds, e.g. lv_index = 500 or ls_item-matnr = 'X' AND sy-tabix > 10 — reach one iteration of a long loop. SAP stops anyway when it cannot evaluate it, and the stop says so.",
      ),
    message: MessageSchema.optional().describe(
      "Instead of line/method: stop where a MESSAGE statement issues this message, e.g. { id: 'ZSD', number: '042', type: 'E' } — where does this error come from? Messages built without a MESSAGE statement (RAP new_message, BAPI return tables) are not caught.",
    ),
    statement: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9 _-]{0,59}$/, 'statement must be an ABAP statement kind, e.g. COMMIT WORK')
      .optional()
      .describe(
        'Instead of line/method: stop at every ABAP statement of this kind, e.g. COMMIT WORK or CALL FUNCTION. When SAP does not know the kind, the refusal lists the ones it does.',
      ),
    exceptionClass: z
      .string()
      .regex(EXCEPTION_CLASS, 'exceptionClass must be an ABAP class name')
      .optional()
      .describe('Instead of line/method: stop where this exception class is raised.'),
    hits: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "How many times this breakpoint may stop the run, e.g. in a loop (1-50, default 1). A line or method breakpoint's stops after the first carry only the values.",
      ),
  })
  .strict();

export const DEBUG_INPUT_SHAPE = {
  type: z
    .string()
    .max(10)
    .optional()
    .describe('Object type of `line`, and the default of every breakpoint: CLAS, PROG or FUNC.'),
  name: z
    .string()
    .max(40)
    .optional()
    .describe('Object name of `line`, and the default of every breakpoint and of the unit-test trigger.'),
  line: z.coerce.number().optional().describe('Shorthand for one breakpoint at this 1-based line of type + name.'),
  breakpoints: z
    .array(DebugBreakpointSchema)
    .max(20)
    .optional()
    .describe(
      'The stops of the run (max 20): each a line, a CLAS method, a message, a statement kind or an exception class. One run can stop in several objects.',
    ),
  exceptionClass: z
    .string()
    .regex(EXCEPTION_CLASS, 'exceptionClass must be an ABAP class name')
    .optional()
    .describe('Also (or only) stop where this exception class is raised, e.g. CX_SY_ZERODIVIDE.'),
  trigger: z
    .enum(['unittest', 'http', 'none'])
    .optional()
    .describe(
      'What runs the code. unittest (default): the harmless ABAP Unit tests of triggerName, else of type + name, else of the first breakpoint object (FUNC: its function group). http: a GET of url. none: the capture only waits timeoutSeconds while you run the code yourself (Fiori app, SE38, Postman) as the SAME SAP user.',
    ),
  triggerName: z
    .string()
    .max(40)
    .optional()
    .describe(
      'trigger=unittest: the class, program or function group whose unit tests run the code, when it is not the breakpoint object.',
    ),
  url: z
    .string()
    .max(4096)
    .optional()
    .describe(
      'trigger=http: a host-relative OData path on the connected system, e.g. /sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel?$top=1. GET only: saves and actions need a unit test or trigger=none.',
    ),
  variables: z
    .array(z.string().min(1).max(200))
    .max(20)
    .optional()
    .describe(
      'Read at every stop and after every step: LV_TOTAL, LS_HEAD-VBELN, LT_ITEMS, LT_ITEMS[3], ME->MV_STATE, SY-SUBRC (max 20). Structures expand one level, tables show their first 5 rows. Default: every variable of the stopped frame (up to 60). The run is released when the call returns, so ask for everything up front.',
    ),
  steps: z.coerce
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe(
      'Steps after each stop (0-20, default 0; at most 100 per capture); each records the new position and the variables.',
    ),
  stepMode: z
    .enum(['over', 'into', 'out'])
    .optional()
    .describe(
      'over (default): stay in the method; into: follow calls into the called method; out: return to the caller.',
    ),
  timeoutSeconds: z.coerce
    .number()
    .int()
    .min(1, 'timeoutSeconds must be 1-240.')
    .max(240, 'timeoutSeconds must be 1-240.')
    .optional()
    .describe('How long to wait for the first stop (1-240, default 60).'),
};

type DebugBreakpointInput = z.infer<typeof DebugBreakpointSchema>;

/** Rules for each `breakpoints` item (one stop of the run: a line, a method, or an event). */
function refineBreakpoints(
  input: { type?: string; name?: string; breakpoints?: DebugBreakpointInput[] },
  ctx: z.RefinementCtx,
): void {
  (input.breakpoints ?? []).forEach((item, index) => {
    const path = ['breakpoints', index];
    const kinds = [item.line, item.method, item.message, item.statement, item.exceptionClass].filter(
      (value) => value !== undefined,
    ).length;
    if (kinds !== 1) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `breakpoints[${index}] needs exactly one of line, method, message, statement or exceptionClass.`,
      });
    }
    if (item.line === undefined && item.method === undefined) {
      // An event breakpoint: no object, and nothing that only a line or method has.
      for (const field of ['type', 'name', 'include', 'condition'] as const) {
        if (item[field] !== undefined && kinds === 1) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `breakpoints[${index}].${field} only applies to a line or method breakpoint.`,
          });
        }
      }
      return;
    }
    const rawType = item.type ?? input.type;
    const type = rawType ? normalizeObjectType(rawType) : '';
    if (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1)) {
      ctx.addIssue({ code: 'custom', path, message: `breakpoints[${index}].line must be a positive integer.` });
    }
    if (!type || !(item.name ?? input.name)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `breakpoints[${index}] needs type (CLAS, PROG or FUNC) and name, its own or the top-level ones.`,
      });
    } else if (!LINE_TYPES.has(type)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `breakpoints[${index}]: type must be CLAS, PROG or FUNC (got "${rawType}").`,
      });
    }
    if ((item.method !== undefined || item.include !== undefined) && type !== 'CLAS') {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `breakpoints[${index}]: method/include are only supported for type="CLAS".`,
      });
    }
  });
}

export const DebugInputSchema = z
  .object(DEBUG_INPUT_SHAPE)
  .strict()
  .superRefine((input, ctx) => {
    const type = input.type ? normalizeObjectType(input.type) : '';
    if (input.line === undefined && input.exceptionClass === undefined && (input.breakpoints?.length ?? 0) === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['breakpoints'],
        message:
          'abap_debug needs a breakpoint: breakpoints (a line or a CLAS method each), line (with type + name), and/or exceptionClass.',
      });
    }
    refineBreakpoints(input, ctx);
    if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) {
      ctx.addIssue({ code: 'custom', path: ['line'], message: 'line must be a positive integer (1-based).' });
    }
    if (input.line !== undefined && (!input.name || !type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'A line breakpoint needs type (CLAS, PROG or FUNC) and name.',
      });
    } else if (input.line !== undefined && !LINE_TYPES.has(type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: `type must be CLAS, PROG or FUNC (got "${input.type}").`,
      });
    }
    if (input.trigger === 'http' && !input.url) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'trigger="http" needs url (a host-relative OData path).',
      });
    }
  });

export type DebugInput = z.infer<typeof DebugInputSchema>;

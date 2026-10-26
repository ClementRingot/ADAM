/**
 * abap_source — the ACTIVE source of a class, program or function module with its line numbers,
 * read from the very URI the debugger sets breakpoints on: a line seen here is a line abap_debug
 * can stop at.
 */

import { z } from 'zod';
import { abaplintVersionFor, locateMethod } from '../abap/method-locator.js';
import { detectLocalHandlerInclude, normalizeObjectType, sourceUri } from '../abap/object-types.js';
import { readSource, resolveFunctionGroup } from '../adt/repository.js';
import type { SapConnection } from './debug-capture.js';
import { errorResult, type ToolResult, textResult } from './result.js';

/** More would flood the model's context; a range, a method or a grep narrows it. */
const MAX_LINES = 1500;
const GREP_CONTEXT = 1;
const SOURCE_TYPES = new Set(['CLAS', 'PROG', 'FUNC']);

export const SourceInputSchema = z
  .object({
    type: z.string().max(10).describe('CLAS, PROG or FUNC.'),
    name: z.string().min(1).max(40).describe('Object name.'),
    include: z
      .enum(['implementations', 'testclasses', 'definitions'])
      .optional()
      .describe(
        'CLAS only: a local-class include instead of the main source — implementations (local classes, e.g. RAP handlers lhc_*), testclasses (ABAP Unit), definitions (local types). Detected for lhc_/lcl_/ltc_ methods.',
      ),
    method: z
      .string()
      .max(128)
      .optional()
      .describe(
        'CLAS only: just this method (get_total, zif_order~process, lhc_travel~validate_dates), numbered as in the whole source.',
      ),
    lineStart: z.coerce.number().int().min(1).optional().describe('First line to return (1-based).'),
    lineEnd: z.coerce.number().int().min(1).optional().describe('Last line to return.'),
    grep: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Case-insensitive regular expression: only matching lines (and one line around each) are returned.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    const type = normalizeObjectType(input.type);
    if (!SOURCE_TYPES.has(type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: `type must be CLAS, PROG or FUNC (got "${input.type}").`,
      });
    }
    if ((input.include !== undefined || input.method !== undefined) && type !== 'CLAS') {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'include and method are only supported for type="CLAS".',
      });
    }
    if (input.lineStart !== undefined && input.lineEnd !== undefined && input.lineEnd < input.lineStart) {
      ctx.addIssue({ code: 'custom', path: ['lineEnd'], message: 'lineEnd must not be before lineStart.' });
    }
    if (input.grep !== undefined) {
      try {
        new RegExp(input.grep, 'i');
      } catch {
        ctx.addIssue({ code: 'custom', path: ['grep'], message: 'grep must be a valid regular expression.' });
      }
    }
  });

export type SourceInput = z.infer<typeof SourceInputSchema>;

function numbered(lines: string[], numbers: number[], width: number, marks?: Set<number>): string {
  const out: string[] = [];
  let previous: number | undefined;
  for (const number of numbers) {
    if (marks && previous !== undefined && number > previous + 1) out.push('--');
    const separator = marks && !marks.has(number) ? '-' : ':';
    out.push(`${String(number).padStart(width)}${separator} ${lines[number - 1] ?? ''}`);
    previous = number;
  }
  return out.join('\n');
}

export async function handleSource(conn: SapConnection, input: SourceInput): Promise<ToolResult> {
  const type = normalizeObjectType(input.type) as 'CLAS' | 'PROG' | 'FUNC';
  const name = input.name.trim().toUpperCase();
  const include = input.include ?? (input.method ? detectLocalHandlerInclude(input.method) : undefined);
  let group: string | undefined;
  if (type === 'FUNC') {
    group = await resolveFunctionGroup(conn.http, name);
    if (!group) return errorResult(`Cannot resolve the function group of ${name}. Check the name with abap_search.`);
  }
  const uri = sourceUri(type, name, include, group);
  const lines = (await readSource(conn.http, uri, 'active')).replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const where = include ? `include ${include}` : 'main source';

  let from = 1;
  let to = lines.length;
  let methodName: string | undefined;
  if (input.method) {
    const found = locateMethod(lines.join('\n'), name, input.method, abaplintVersionFor(conn.abapRelease));
    if (!found.found) return errorResult(`${found.error} Searched the ${where} of ${name}.`);
    ({ startLine: from, endLine: to } = found);
    methodName = found.name;
  }
  from = Math.max(from, input.lineStart ?? from);
  to = Math.min(to, input.lineEnd ?? to);
  if (from > to) return errorResult(`${type} ${name} (${where}) has ${lines.length} lines; the range is empty.`);

  let numbers = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  let marks: Set<number> | undefined;
  if (input.grep) {
    const pattern = new RegExp(input.grep, 'i');
    marks = new Set(numbers.filter((number) => pattern.test(lines[number - 1] ?? '')));
    const shown = new Set<number>();
    for (const number of marks) {
      for (let near = number - GREP_CONTEXT; near <= number + GREP_CONTEXT; near++) {
        if (near >= from && near <= to) shown.add(near);
      }
    }
    numbers = [...shown].sort((a, b) => a - b);
    if (numbers.length === 0) {
      return textResult(`${type} ${name} — ${where} (active): no line of ${from}-${to} matches /${input.grep}/i.`);
    }
  }
  const truncated = numbers.length > MAX_LINES;
  if (truncated) numbers = numbers.slice(0, MAX_LINES);

  const header = [
    `${type} ${name} — ${where} (active)${methodName ? `, method ${methodName}` : ''}, lines ${from}-${to} of ${lines.length}${marks ? `, ${marks.size} matching` : ''}.`,
  ];
  if (include !== 'definitions') {
    const item = JSON.stringify({ type, name, ...(include ? { include } : {}), line: 'N' }).replace('"N"', 'N');
    header.push(`abap_debug breakpoints item for line N: ${item}`);
  }
  const footer = truncated
    ? `\n… ${MAX_LINES} lines shown; narrow with lineStart/lineEnd, method or grep for the rest.`
    : '';
  return textResult(`${header.join('\n')}\n${numbered(lines, numbers, String(to).length, marks)}${footer}`);
}

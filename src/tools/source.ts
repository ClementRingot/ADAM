/**
 * abap_source — the ACTIVE source of a class, program or function module with its line numbers,
 * read from the very URI the debugger sets breakpoints on: a line seen here is a line abap_debug
 * can stop at. Interfaces, includes, CDS objects, behavior and service definitions, and service
 * bindings read the same way: they lead from a Fiori app to the code the debugger stops in.
 */

import { z } from 'zod';
import { abaplintVersionFor, locateMethod } from '../abap/method-locator.js';
import {
  detectLocalHandlerInclude,
  normalizeObjectType,
  READ_ONLY_SOURCE_TYPES,
  readOnlySourceUri,
  sourceUri,
} from '../abap/object-types.js';
import { readServiceBinding, readSource, resolveFunctionGroup, type ServiceBinding } from '../adt/repository.js';
import type { SapConnection } from './connection.js';
import { errorResult, type ToolResult, textResult } from './result.js';

/** More would flood the model's context; a range, a method or a grep narrows it. */
const MAX_LINES = 1500;
const GREP_CONTEXT = 1;
/** Where abap_debug sets breakpoints. */
const BREAKPOINT_TYPES = new Set(['CLAS', 'PROG', 'FUNC']);
const SOURCE_TYPES = new Set([...BREAKPOINT_TYPES, ...READ_ONLY_SOURCE_TYPES, 'SRVB']);
const TYPE_LIST = 'CLAS, PROG, FUNC, INTF, INCL, DDLS, DCLS, DDLX, BDEF, SRVD or SRVB';

export const SourceInputSchema = z
  .object({
    type: z
      .string()
      .max(10)
      .describe(
        'CLAS, PROG or FUNC (where breakpoints go); INTF, INCL, DDLS (CDS view), DCLS, DDLX, BDEF (behavior definition), SRVD (service definition) or SRVB (service binding: its service definitions) to follow a Fiori app to its code.',
      ),
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
      ctx.addIssue({ code: 'custom', path: ['type'], message: `type must be ${TYPE_LIST} (got "${input.type}").` });
    }
    if ((input.include !== undefined || input.method !== undefined) && type !== 'CLAS') {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'include and method are only supported for type="CLAS".',
      });
    }
    if (type === 'SRVB' && (input.lineStart !== undefined || input.lineEnd !== undefined || input.grep !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'A service binding has no source lines: leave out lineStart, lineEnd and grep.',
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

const call = (tool: string, args: Record<string, string>) => `${tool} ${JSON.stringify(args)}`;

/** A service binding as text: each service version and the service definition behind it. */
function describeBinding(binding: ServiceBinding, name: string): string {
  const kind = [binding.bindingType === 'ODATA' ? 'OData' : binding.bindingType, binding.odataVersion, binding.category]
    .filter(Boolean)
    .join(' ');
  const lines = [
    `SRVB ${binding.name || name} — service binding${kind ? ` (${kind})` : ''}, ${binding.published ? 'published' : 'not published'}${binding.packageName ? `, package ${binding.packageName}` : ''}.`,
  ];
  if (binding.description) lines.push(`Description: ${binding.description}`);
  const definitions = new Set<string>();
  for (const service of binding.services) {
    for (const version of service.versions) {
      lines.push(
        `Service ${service.name}, version ${version.version || '?'}: service definition ${version.serviceDefinition || '?'}${version.releaseState ? ` (${version.releaseState})` : ''}`,
      );
      if (version.serviceDefinition) definitions.add(version.serviceDefinition);
    }
  }
  for (const definition of definitions) {
    lines.push(`Next: ${call('abap_source', { type: 'SRVD', name: definition })} — the entities it exposes.`);
  }
  return lines.join('\n');
}

/** What a behavior or service definition leads to, for the header. */
function leads(type: string, source: string): string[] {
  if (type === 'BDEF') {
    const pools = [...new Set([...source.matchAll(/implementation\s+in\s+class\s+([\w/]+)/gi)].map((m) => m[1]))];
    return pools.map(
      (pool) =>
        `Behavior pool ${pool?.toUpperCase()}: ${call('abap_source', { type: 'CLAS', name: pool?.toUpperCase() ?? '', include: 'implementations' })} shows its handler classes (lhc_*).`,
    );
  }
  if (type === 'SRVD') {
    const exposed = [...source.matchAll(/^\s*expose\s+([\w/]+)(?:\s+as\s+([\w/]+))?/gim)].map(
      (m) => `${m[1]?.toUpperCase()}${m[2] ? ` as ${m[2]}` : ''}`,
    );
    return exposed.length > 0
      ? [
          `Exposes ${exposed.join(', ')}. Each is a CDS view (DDLS); a RAP entity's behavior definition (BDEF) has the name of its root view and names its behavior pool.`,
        ]
      : [];
  }
  return [];
}

export async function handleSource(conn: SapConnection, input: SourceInput): Promise<ToolResult> {
  const type = normalizeObjectType(input.type);
  const name = input.name.trim().toUpperCase();
  if (type === 'SRVB') return textResult(describeBinding(await readServiceBinding(conn.http, name), name));
  const include = input.include ?? (input.method ? detectLocalHandlerInclude(input.method) : undefined);
  let uri: string;
  if (BREAKPOINT_TYPES.has(type)) {
    let group: string | undefined;
    if (type === 'FUNC') {
      group = await resolveFunctionGroup(conn.http, name);
      if (!group) return errorResult(`Cannot resolve the function group of ${name}. Check the name with abap_search.`);
    }
    uri = sourceUri(type as 'CLAS' | 'PROG' | 'FUNC', name, include, group);
  } else {
    uri = readOnlySourceUri(type, name);
  }
  const lines = (await readSource(conn.http, uri, 'active')).replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const where = include ? `include ${include}` : BREAKPOINT_TYPES.has(type) ? 'main source' : 'source';

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
  if (BREAKPOINT_TYPES.has(type) && include !== 'definitions') {
    const item = JSON.stringify({ type, name, ...(include ? { include } : {}), line: 'N' }).replace('"N"', 'N');
    header.push(`abap_debug breakpoints item for line N: ${item}`);
  } else if (type === 'INCL') {
    header.push(
      'No breakpoints in includes yet: set them in the class, program or function module that runs this code.',
    );
  }
  header.push(...leads(type, lines.join('\n')));
  const footer = truncated
    ? `\n… ${MAX_LINES} lines shown; narrow with lineStart/lineEnd, method or grep for the rest.`
    : '';
  return textResult(`${header.join('\n')}\n${numbered(lines, numbers, String(to).length, marks)}${footer}`);
}

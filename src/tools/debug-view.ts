/**
 * How the debugger's state reads in a result: positions numbered like abap_source, the call stack,
 * variables (structures one level deep, the first rows of tables) and their compact form after steps.
 */

import type { Debuggee, DebuggerSession, DebugStackFrame, DebugVariable } from '../adt/debugger.js';
import { debuggerErrorText } from '../adt/debugger.js';

const MAX_FRAME_VARIABLES = 60;

const MAX_EXPANDED_STRUCTURES = 20;

const MAX_EXPANDED_TABLES = 5;

const MAX_COMPONENTS = 30;

const MAX_TABLE_ROWS = 5;

const MAX_VALUE_CHARS = 500;

const MAX_STACK_FRAMES = 15;

export interface CapturedVariable {
  name: string;
  scope?: string;
  type?: string;
  kind: string;
  value?: string;
  truncated?: true;
  lines?: number;
  rows?: unknown[];
  components?: Record<string, string>;
  error?: string;
}

function clip(value: string): { value: string; truncated?: true } {
  return value.length > MAX_VALUE_CHARS ? { value: value.slice(0, MAX_VALUE_CHARS), truncated: true } : { value };
}

/** A string keeps its blanks — they count (`CONV string( 124 )` is `'124 '`, `strlen` 4); other kinds lose SAP's padding. */
function shownValue(variable: DebugVariable): string {
  return variable.metaType === 'string' ? variable.value : variable.value.trim();
}

/** One-line rendering for structure components, table rows and step values. */
function compactValue(variable: DebugVariable): string {
  if (variable.metaType === 'table') return `table[${variable.tableLines ?? 0}]`;
  if (variable.metaType === 'structure') return 'structure';
  return clip(shownValue(variable)).value;
}

function describeVariable(variable: DebugVariable, scope?: string): CapturedVariable {
  const type = variable.declaredType || variable.actualType || variable.technicalType;
  const base: CapturedVariable = {
    name: variable.name || variable.id,
    ...(scope ? { scope } : {}),
    ...(type ? { type } : {}),
    kind: variable.metaType || 'unknown',
  };
  if (variable.metaType === 'table') return { ...base, lines: variable.tableLines ?? 0 };
  if (variable.metaType === 'structure') return base;
  const clipped = clip(shownValue(variable));
  return { ...base, value: clipped.value, ...(clipped.truncated || variable.incomplete ? { truncated: true } : {}) };
}

/** Group child-variable rows by the parent each was requested for. */
function childrenByParent(
  response: Awaited<ReturnType<DebuggerSession['childVariables']>>,
): Map<string, DebugVariable[]> {
  const byId = new Map(response.variables.map((variable) => [variable.id, variable]));
  const grouped = new Map<string, DebugVariable[]>();
  for (const row of response.hierarchies) {
    const child = byId.get(row.childId);
    if (!child) continue;
    const list = grouped.get(row.parentId) ?? [];
    list.push(child);
    grouped.set(row.parentId, list);
  }
  return grouped;
}

function componentsOf(children: DebugVariable[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const child of (children ?? []).slice(0, MAX_COMPONENTS)) out[child.name || child.id] = compactValue(child);
  return out;
}

/** Expand structures one level and the first rows of tables — two batched requests, never per variable. */
async function expand(session: DebuggerSession, pairs: Array<{ variable: DebugVariable; out: CapturedVariable }>) {
  const structures = pairs.filter((pair) => pair.variable.metaType === 'structure').slice(0, MAX_EXPANDED_STRUCTURES);
  const tables = pairs
    .filter((pair) => pair.variable.metaType === 'table' && (pair.variable.tableLines ?? 0) > 0)
    .slice(0, MAX_EXPANDED_TABLES);
  if (structures.length > 0) {
    const grouped = childrenByParent(await session.childVariables(structures.map((pair) => pair.variable.id)));
    for (const pair of structures) pair.out.components = componentsOf(grouped.get(pair.variable.id));
  }
  if (tables.length === 0) return;
  const rowIds = tables.flatMap((pair) => {
    const base = pair.variable.id.replace(/\[\]$/, '');
    const count = Math.min(pair.variable.tableLines ?? 0, MAX_TABLE_ROWS);
    return Array.from({ length: count }, (_, index) => `${base}[${index + 1}]`);
  });
  const rows = await session.variables(rowIds);
  const rowById = new Map(rows.map((row) => [row.id.toUpperCase(), row]));
  const structuredRows = rows.filter((row) => row.metaType === 'structure');
  const rowComponents =
    structuredRows.length > 0
      ? childrenByParent(await session.childVariables(structuredRows.map((row) => row.id)))
      : undefined;
  for (const pair of tables) {
    const base = pair.variable.id.replace(/\[\]$/, '');
    const count = Math.min(pair.variable.tableLines ?? 0, MAX_TABLE_ROWS);
    pair.out.rows = Array.from({ length: count }, (_, index) => {
      const row = rowById.get(`${base}[${index + 1}]`.toUpperCase());
      if (!row) return null;
      return row.metaType === 'structure' ? componentsOf(rowComponents?.get(row.id)) : compactValue(row);
    });
  }
}

/** A requested name SAP did not return: the frame read has no such variable. */
export const NOT_VISIBLE = 'not visible in the stopped frame';

export async function readNamedVariables(
  session: DebuggerSession,
  names: readonly string[],
): Promise<CapturedVariable[]> {
  let found: DebugVariable[] = [];
  const failures = new Map<string, string>();
  try {
    found = await session.variables(names);
  } catch {
    // One unknown expression can fail the whole batch — retry one by one to say which.
    for (const name of names) {
      try {
        found.push(...(await session.variables([name])));
      } catch (err) {
        failures.set(name, debuggerErrorText(err));
      }
    }
  }
  const pairs: Array<{ variable: DebugVariable; out: CapturedVariable }> = [];
  // SAP echoes the expression as ID; a 1:1 answer can also be matched by position.
  const byPosition = found.length === names.length && failures.size === 0;
  const result = names.map((name, index): CapturedVariable => {
    const variable =
      found.find((candidate) => candidate.id.toUpperCase() === name || candidate.name.toUpperCase() === name) ??
      (byPosition ? found[index] : undefined);
    if (!variable) return { name, kind: 'unknown', error: failures.get(name) ?? NOT_VISIBLE };
    const out = { ...describeVariable(variable), name };
    pairs.push({ variable, out });
    return out;
  });
  await expand(session, pairs);
  return result;
}

/**
 * The stopped frame's variables. Releases differ in what `@ROOT` holds (docs/adt-debugger-protocol.md):
 * real variable rows directly, or scope nodes (pseudo ids like `@…`, or children without a variable
 * row of their own) whose children are the variables. Both are read; scopes in one batched request.
 */
export async function readFrameVariables(session: DebuggerSession, warnings: string[]): Promise<CapturedVariable[]> {
  const root = await session.childVariables(['@ROOT']);
  const rootVariableIds = new Set(root.variables.map((variable) => variable.id));
  const scopes = root.hierarchies.filter(
    (row) =>
      row.parentId === '@ROOT' && row.childId && (row.childId.startsWith('@') || !rootVariableIds.has(row.childId)),
  );
  const scopeName = new Map(scopes.map((row) => [row.childId, row.childName || row.childId]));
  const rows: Array<{ variable: DebugVariable; scope?: string }> = root.variables
    .filter((variable) => !variable.id.startsWith('@') && !scopeName.has(variable.id))
    .map((variable) => ({ variable }));
  if (scopes.length > 0) {
    const grouped = childrenByParent(await session.childVariables(scopes.map((row) => row.childId)));
    for (const [parentId, children] of grouped) {
      for (const variable of children) rows.push({ variable, scope: scopeName.get(parentId) });
    }
  }
  if (rows.length > MAX_FRAME_VARIABLES) {
    warnings.push(
      `The frame has ${rows.length} variables; the first ${MAX_FRAME_VARIABLES} are shown. Name the ones you need in "variables" to read them in full.`,
    );
  }
  const pairs = rows.slice(0, MAX_FRAME_VARIABLES).map(({ variable, scope }) => ({
    variable,
    out: describeVariable(variable, scope),
  }));
  // Locals: one level of structure components; table rows only when a table is named explicitly.
  await expand(
    session,
    pairs.filter((pair) => pair.variable.metaType === 'structure'),
  );
  return pairs.map((pair) => pair.out);
}

/** A frame's position numbered like abap_source: its URI's line. Without a URI, the line within `include`. */
export function describeFrame(frame: DebugStackFrame): Record<string, unknown> {
  const procedure = [frame.eventType, frame.eventName].filter(Boolean).join(' ');
  const position = frame.uri ? sourcePosition(frame.uri) : undefined;
  const line = position?.line ?? frame.line;
  return {
    ...(procedure ? { procedure } : {}),
    program: frame.program,
    ...(!position && frame.include && frame.include !== frame.program ? { include: frame.include } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(frame.uri ? { uri: frame.uri } : {}),
  };
}

/** Where the debuggee waited, numbered like the stops (its URI's line); without a URI, the line within `include`. */
export function debuggeePosition(debuggee: Debuggee): Record<string, unknown> {
  const line = debuggee.uri ? sourcePosition(debuggee.uri)?.line : undefined;
  if (line !== undefined) return { line, uri: debuggee.uri };
  return { include: debuggee.include, ...(debuggee.line !== undefined ? { includeLine: debuggee.line } : {}) };
}

/** The frames worth showing: customer code (system frames counted), at most MAX_STACK_FRAMES. */
export function describeStack(stack: DebugStackFrame[]): Record<string, unknown> {
  const visible = stack.filter((frame) => !frame.systemProgram);
  return {
    ...(stack.length > 0 ? { stack: visible.slice(0, MAX_STACK_FRAMES).map(describeFrame) } : {}),
    ...(stack.length > visible.length ? { hiddenSystemFrames: stack.length - visible.length } : {}),
  };
}

/** `/sap/bc/adt/…/source/main#start=9,4` → lower-cased path + line. */
export function sourcePosition(uri: string): { uri: string; line: number } | undefined {
  const [path, fragment] = uri.split('#', 2);
  const line = Number(/start=(\d+)/.exec(fragment ?? '')?.[1]);
  return path && Number.isInteger(line) ? { uri: path.toLowerCase(), line } : undefined;
}

/** The frame the top entry runs in, with the stack depth: a step that changes it entered a call or returned. */
function frameKey(stack: readonly DebugStackFrame[]): string {
  const [top] = stack;
  return top ? [stack.length, top.program, top.include, top.eventType, top.eventName].join('|') : '';
}

export type FrameMove = 'entered' | 'returned' | 'changed';

export function frameMove(from: readonly DebugStackFrame[], to: readonly DebugStackFrame[]): FrameMove | undefined {
  if (frameKey(from) === frameKey(to)) return undefined;
  if (to.length > from.length) return 'entered';
  return to.length < from.length ? 'returned' : 'changed';
}

export const FRAME_MOVE_WARNING =
  'A step with "frame" moved to another method (entered = into a call, returned = back to the caller): its values are read there, so a variable of the same name is a different variable.';

/** A watched variable after a step, as at a stop: its text, a structure's components, or a table's line count and first rows. */
export function stepValue(variable: CapturedVariable): string | Record<string, unknown> {
  if (variable.kind === 'structure') return variable.components ?? {};
  if (variable.kind === 'table') {
    const lines = variable.lines ?? 0;
    return variable.rows ? { lines, rows: variable.rows } : `table[${lines}]`;
  }
  return variable.value ?? '';
}

/**
 * Variables in their compact form — text, a structure's components, a table's lines and first rows —
 * as after a step or at a breakpoint's later stops. A structure or table equal to the one `previous`
 * remembers (the previous step in the same frame, or the breakpoint's previous stop) reads
 * `unchanged`; `previous` is updated. A name SAP refused goes to `refused` when given (steps leave it
 * out of the frame's later reads), else to `errors`.
 */
export function compactValues(
  variables: readonly CapturedVariable[],
  previous: Map<string, string>,
  refused?: Map<string, string>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const notVisible: string[] = [];
  const errors = refused ?? new Map<string, string>();
  for (const variable of variables) {
    if (variable.error === NOT_VISIBLE) notVisible.push(variable.name);
    else if (variable.error) errors.set(variable.name, variable.error);
    else {
      // Frame variables of different scopes may share a name.
      const key = variable.name in values && variable.scope ? `${variable.name} (${variable.scope})` : variable.name;
      const value = stepValue(variable);
      const rendered = typeof value === 'string' ? undefined : JSON.stringify(value);
      values[key] = rendered !== undefined && previous.get(key) === rendered ? 'unchanged' : value;
      if (rendered !== undefined) previous.set(key, rendered);
    }
  }
  return {
    ...(Object.keys(values).length > 0 ? { values } : {}),
    ...(notVisible.length > 0 ? { notVisible } : {}),
    ...(errors.size > 0 ? { errors: Object.fromEntries(errors) } : {}),
  };
}

/**
 * The watched variables after a step. A name SAP refuses is left out of the frame's later reads
 * (`refused`), so one bad expression cannot fail every step's batch.
 */
export async function readStepValues(
  session: DebuggerSession,
  names: readonly string[],
  refused: Map<string, string>,
  previous: Map<string, string>,
): Promise<Record<string, unknown>> {
  const read = await readNamedVariables(
    session,
    names.filter((name) => !refused.has(name)),
  );
  return compactValues(read, previous, refused);
}

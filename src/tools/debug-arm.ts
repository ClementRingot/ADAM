/**
 * Breakpoints: resolve each requested location against the ACTIVE source (lines SAP accepts, a
 * method's first statement), then arm them all as the session user's external breakpoints.
 */

import { abaplintVersionFor, locateMethod } from '../abap/method-locator.js';
import { detectLocalHandlerInclude } from '../abap/object-types.js';
import {
  type DebugBreakpointSpec,
  type DebugBreakpointState,
  type DebuggerSession,
  type DebugIdentity,
  debuggerErrorText,
  deleteBreakpoint,
  listDebugStatements,
  syncBreakpoints,
} from '../adt/debugger.js';
import type { AdtHttpClient } from '../adt/http.js';
import { resolveFunctionGroup as findFunctionGroup, readSource } from '../adt/repository.js';
import type { SapConnection } from './connection.js';

/** `line`: SAP refuses lines without a statement, so probe the next few lines too. */
const LINE_PROBE = 5;

/** `method`: probe from the METHOD statement to the first line SAP accepts. */
const METHOD_PROBE = 16;

const CLASS_INCLUDES = new Set(['implementations', 'testclasses']);

export class DebugInputError extends Error {}

/** One line or method breakpoint. */
export interface BreakpointLocation {
  type: string;
  name: string;
  line?: number;
  method?: string;
  include?: string;
  /** ABAP condition SAP evaluates there: the run stops only where it holds. */
  condition?: string;
  /** How many times it may stop the run (a loop). */
  hits: number;
}

/** A breakpoint on something the run does rather than a line: raise an exception, issue a message,
 *  execute a statement of a kind. SAP names where it stopped; there is no line to probe. */
export type EventLocation =
  | { kind: 'exception'; exceptionClass: string; hits: number }
  | { kind: 'message'; id: string; number: string; type: string; hits: number }
  | { kind: 'statement'; statement: string; hits: number };

export interface LineTarget {
  /** Source URI the breakpoint fragment `#start=<line>` is appended to. */
  uri: string;
  /** Lines to probe in order. */
  candidates: number[];
  label: string;
}

/** A resolved location, how many times it may stop the run, and where only (its condition). */
export type StopTarget = LineTarget & { hits: number; condition?: string };

/** What resolving the breakpoints reads, once per capture: several breakpoints often share a source. */
export interface ResolutionCache {
  sources: Map<string, Promise<string>>;
  groups: Map<string, Promise<string>>;
}

export const newResolutionCache = (): ResolutionCache => ({ sources: new Map(), groups: new Map() });

function lineRange(from: number, to: number): number[] {
  const lines: number[] = [];
  for (let line = Math.max(1, from); line <= Math.max(from, to); line++) lines.push(line);
  return lines;
}

/** A line that cannot carry a statement: blank, or a full-line comment (`*` in column 1, or `"`). */
function carriesNoStatement(text: string): boolean {
  const content = text.trim();
  return content === '' || text.startsWith('*') || content.startsWith('"');
}

/** The method's lines SAP may accept, from its METHOD statement on: at most METHOD_PROBE, blank and comment lines skipped. */
function methodCandidates(source: string, startLine: number, endLine: number): number[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const candidates: number[] = [];
  for (let line = startLine; line <= endLine && candidates.length < METHOD_PROBE; line++) {
    if (!carriesNoStatement(lines[line - 1] ?? '')) candidates.push(line);
  }
  return candidates.length > 0 ? candidates : [startLine];
}

export function resolveFunctionGroup(conn: SapConnection, name: string, cache: ResolutionCache): Promise<string> {
  const key = name.toUpperCase();
  let group = cache.groups.get(key);
  if (!group) {
    group = findFunctionGroup(conn.http, name).then((found) => {
      if (!found) {
        throw new DebugInputError(`Cannot resolve the function group of ${name}. Check the name with abap_search.`);
      }
      return found;
    });
    cache.groups.set(key, group);
  }
  return group;
}

/** The ACTIVE source at `uri` — breakpoints apply to it, never to a draft. */
function activeSource(conn: SapConnection, uri: string, cache: ResolutionCache): Promise<string> {
  let source = cache.sources.get(uri);
  if (!source) {
    source = readSource(conn.http, uri, 'active');
    cache.sources.set(uri, source);
  }
  return source;
}

export async function resolveLineTarget(
  conn: SapConnection,
  location: BreakpointLocation,
  cache: ResolutionCache,
): Promise<LineTarget> {
  const { type, name, method } = location;
  const encoded = encodeURIComponent(name.toLowerCase());
  if (type === 'CLAS') {
    const include = location.include ?? (method ? detectLocalHandlerInclude(method) : undefined);
    if (include && !CLASS_INCLUDES.has(include)) {
      throw new DebugInputError(`include must be "implementations" or "testclasses" (got "${include}").`);
    }
    const base = `/sap/bc/adt/oo/classes/${encoded}`;
    const uri = include ? `${base}/includes/${include}` : `${base}/source/main`;
    const where = include ? `include "${include}"` : 'the main source';
    if (method !== undefined) {
      const source = await activeSource(conn, uri, cache);
      const found = locateMethod(source, name, method, abaplintVersionFor(conn.abapRelease));
      if (!found.found) {
        throw new DebugInputError(
          `${found.error} Searched ${where} of ${name}; give the breakpoint an include for local classes.`,
        );
      }
      return {
        uri,
        candidates: methodCandidates(source, found.startLine, found.endLine),
        label: `CLAS ${name} method ${method}`,
      };
    }
    const line = location.line as number;
    return {
      uri,
      candidates: lineRange(line, line + LINE_PROBE - 1),
      label: `CLAS ${name} ${where} line ${line}`,
    };
  }
  if (method !== undefined) throw new DebugInputError('method is only supported for type="CLAS"; use line.');
  const line = location.line as number;
  if (type === 'PROG') {
    return {
      uri: `/sap/bc/adt/programs/programs/${encoded}/source/main`,
      candidates: lineRange(line, line + LINE_PROBE - 1),
      label: `PROG ${name} line ${line}`,
    };
  }
  if (type === 'FUNC') {
    const group = await resolveFunctionGroup(conn, name, cache);
    return {
      uri: `/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}/fmodules/${encoded}/source/main`,
      candidates: lineRange(line, line + LINE_PROBE - 1),
      label: `FUNC ${name} line ${line}`,
    };
  }
  throw new DebugInputError(`Line breakpoints support type CLAS, PROG or FUNC (got "${type || '(none)'}").`);
}

/** A breakpoint armed for the run, as each stop is matched against it. */
export interface ArmedBreakpoint {
  /** Server id, shared by the external breakpoint and its debug-session copy. */
  id: string;
  /** Ids it had before SAP renumbered it (setting the run's own breakpoints may): SAP may still name them. */
  aliases?: string[];
  /** The clientId it was armed with, which SAP echoes: its key through the run, whatever its id. */
  clientId: string;
  /** Set in the run, but SAP's answer named no id: the first unknown id SAP names at a stop is its. */
  unconfirmed?: boolean;
  label: string;
  kind: 'line' | EventLocation['kind'];
  /** Line breakpoints: lower-cased source URI + the line SAP armed — how a stop is recognised on the stack. */
  uri?: string;
  /** Line breakpoints: the source URI as armed, to set it again in the run. */
  sourceUri?: string;
  line?: number;
  /** SAP stops here only where this holds — so a step merely passing the line is no stop of it. */
  condition?: string;
  /** Stops it may make before it is retired from the run. */
  maxHits: number;
  /** Its entry in the breakpoints report. */
  reportIndex: number;
}

/** An event breakpoint set in the debugged run only, once it first stops. */
export interface RunEvent {
  event: EventLocation;
  /** Its position among the request's event breakpoints (its clientId). */
  index: number;
  /** Its entry in the breakpoints report. */
  reportIndex: number;
}

export interface ArmedBreakpoints {
  /** Server ids of every breakpoint the capture left armed — the cleanup list. */
  ids: string[];
  armed: ArmedBreakpoint[];
  report: Array<Record<string, unknown>>;
  /** Event breakpoints armed in the run at its first stop (`armInRun`), not for the whole user. */
  inRun: RunEvent[];
  /** With an `ArmRoute`: the session whose sync armed them last — `disarm` removes them from it. */
  armedFrom?: AdtHttpClient;
}

/** Does SAP's `id` name this breakpoint — under its id or one it had before? */
export const isBreakpoint = (bp: ArmedBreakpoint, id: string): boolean =>
  bp.id === id || (bp.aliases?.includes(id) ?? false);

/** `target`: the location's position in the request — two locations may probe the same line numbers. */
const lineClientId = (target: number, line: number): string => `dbg-${target}-line-${line}`;

const eventClientId = (index: number, event: EventLocation): string => `dbg-${index}-${event.kind}`;

const isLineState = (state: DebugBreakpointState): boolean =>
  state.kind ? state.kind === 'line' : /-line-\d+$/.test(state.clientId);

/** How an event breakpoint reads in stops (`at`): `exception CX_…`, `message E042(ZSD)`, `statement COMMIT WORK`. */
function eventLabel(event: EventLocation): string {
  if (event.kind === 'exception') return `exception ${event.exceptionClass}`;
  if (event.kind === 'message') return `message ${event.type}${event.number}(${event.id})`;
  return `statement ${event.statement}`;
}

/** Its entry in the breakpoints report. */
function eventReport(event: EventLocation): Record<string, unknown> {
  if (event.kind === 'exception') return { kind: 'exception', exceptionClass: event.exceptionClass };
  if (event.kind === 'message') return { kind: 'message', message: `${event.type}${event.number}(${event.id})` };
  return { kind: 'statement', statement: event.statement };
}

function eventSpec(event: EventLocation, index: number): DebugBreakpointSpec {
  const clientId = eventClientId(index, event);
  if (event.kind === 'exception') return { kind: 'exception', clientId, exceptionClass: event.exceptionClass };
  if (event.kind === 'message') {
    return { kind: 'message', clientId, msgId: event.id, msgNo: event.number, msgTy: event.type };
  }
  return { kind: 'statement', clientId, statement: event.statement };
}

/** SAP's answer for event breakpoint `index`: by the clientId it echoes, else by what the breakpoint names. */
function eventState(
  states: DebugBreakpointState[],
  event: EventLocation,
  index: number,
): DebugBreakpointState | undefined {
  const clientId = eventClientId(index, event);
  return (
    states.find((state) => state.clientId === clientId) ??
    states.find(
      (state) =>
        state.kind === event.kind &&
        !state.clientId &&
        (event.kind === 'exception'
          ? state.exceptionClass?.toUpperCase() === event.exceptionClass
          : event.kind === 'message'
            ? state.msgId?.toUpperCase() === event.id && state.msgNo === event.number
            : state.statement?.toUpperCase() === event.statement),
    )
  );
}

/**
 * SAP's answer for candidate `line` of target `index`: by the clientId it echoes, else by position —
 * the line alone when only one target was probed (`soleTarget`), as before several were possible.
 */
function stateFor(
  states: DebugBreakpointState[],
  index: number,
  target: LineTarget,
  line: number,
  soleTarget: boolean,
): DebugBreakpointState | undefined {
  return states.find(
    (state) =>
      isLineState(state) &&
      (state.clientId === lineClientId(index, line) ||
        (state.line === line && (soleTarget || (state.uri ?? '').toLowerCase() === target.uri.toLowerCase()))),
  );
}

/** First candidate SAP armed, with the line SAP reports (it may move a breakpoint to the next statement). */
function acceptedLine(
  target: LineTarget,
  index: number,
  states: DebugBreakpointState[],
  soleTarget: boolean,
): { requested: number; line: number } | undefined {
  for (const requested of target.candidates) {
    const state = stateFor(states, index, target, requested, soleTarget);
    if (state?.id) return { requested, line: state.line ?? requested };
  }
  return undefined;
}

/** A session on an application server, to arm the breakpoints from (`openArmingSessions`). */
export interface ArmingSession {
  server: string;
  http: AdtHttpClient;
}

/** Where the breakpoints are armed from: every session of `before`, then `last` — the user's SAP GUI server. */
export interface ArmRoute {
  before: readonly ArmingSession[];
  last: ArmingSession;
}

/**
 * Arm every line target on the first candidate SAP accepts (one probe POST carrying all candidates,
 * then a second sync keeping one line per target — two targets on the same line arm it once) plus
 * the event breakpoints, sent as they are in both. Conditions ride on the second sync only, as
 * vscode_abap_remote_fs sends them: the probe finds the line, then the condition goes onto the line
 * SAP armed. The report lists the line breakpoints first, then the event ones.
 *
 * External breakpoints stop every request of the SAP user — this server's own ADT requests too, and
 * a frequent statement (CLEAR) or an exception SAP code raises and catches stops them (seen live).
 * So with a line or method breakpoint to enter the run, the event breakpoints wait for its first stop
 * and are set in that run only (`armInRun`); without one, exception and message breakpoints are the
 * only way in and go external.
 *
 * With a `route`, the second sync runs from each of its sessions in turn, `route.last` (the user's
 * SAP GUI server) last: a SAP GUI run stops reliably only on the server that armed the breakpoints
 * last. A sync that fails there costs a warning, not the capture.
 */
export async function armBreakpoints(
  conn: SapConnection,
  identity: DebugIdentity,
  targets: readonly StopTarget[],
  events: readonly EventLocation[],
  armedIds: string[],
  route?: ArmRoute,
  warnings: string[] = [],
): Promise<ArmedBreakpoints> {
  const inRun = targets.length > 0;
  const eventSpecs = inRun ? [] : events.map(eventSpec);
  const lineSpec = (index: number, line: number, withCondition = false): DebugBreakpointSpec => {
    const condition = withCondition ? targets[index]?.condition : undefined;
    return {
      kind: 'line',
      clientId: lineClientId(index, line),
      uri: targets[index]?.uri ?? '',
      line,
      ...(condition ? { condition } : {}),
    };
  };
  const remember = (states: DebugBreakpointState[]): DebugBreakpointState[] => {
    armedIds.splice(0, armedIds.length, ...states.flatMap((state) => (state.id ? [state.id] : [])));
    return states;
  };

  const probe = remember(
    await syncBreakpoints(conn.http, identity, [
      ...targets.flatMap((target, index) => target.candidates.map((line) => lineSpec(index, line))),
      ...eventSpecs,
    ]),
  );
  const sole = targets.length === 1;
  const accepted = targets.map((target, index) => acceptedLine(target, index, probe, sole));
  const positionKey = (index: number, line: number): string => `${targets[index]?.uri.toLowerCase()}#${line}`;
  /** Position → the first target that armed it. */
  const owner = new Map<string, number>();
  accepted.forEach((hit, index) => {
    if (hit && !owner.has(positionKey(index, hit.line))) owner.set(positionKey(index, hit.line), index);
  });
  let states = probe;
  const finalSpecs = (): DebugBreakpointSpec[] => [
    ...[...owner.values()].map((index) => lineSpec(index, accepted[index]?.requested ?? 0, true)),
    ...eventSpecs,
  ];
  let armedFrom: AdtHttpClient | undefined;
  if (route && probe.some((state) => state.id)) {
    for (const { server, http } of [...route.before, route.last]) {
      try {
        states = remember(await syncBreakpoints(http, identity, finalSpecs()));
        armedFrom = http;
      } catch (err) {
        warnings.push(
          `Could not arm the breakpoints from application server ${server} (${debuggerErrorText(err)}): a SAP GUI run there may not stop.`,
        );
      }
    }
  }
  // The probe may have armed several candidate lines per target — keep exactly one each, with its condition.
  const conditioned = [...owner.values()].some((index) => targets[index]?.condition);
  const narrow = conditioned || probe.filter((state) => state.id && isLineState(state)).length > owner.size;
  if (!armedFrom && narrow) states = remember(await syncBreakpoints(conn.http, identity, finalSpecs()));

  const armed: ArmedBreakpoint[] = [];
  const report: Array<Record<string, unknown>> = [];
  targets.forEach((target, index) => {
    const hit = accepted[index];
    const first = hit ? owner.get(positionKey(index, hit.line)) : undefined;
    const state = hit && first === index ? stateFor(states, index, target, hit.requested, sole) : undefined;
    const condition = target.condition ? { condition: target.condition } : {};
    if (hit && first !== undefined && first !== index) {
      const other = targets[first];
      report.push({
        kind: 'line',
        location: target.label,
        status: 'duplicate',
        of: other?.label,
        ...condition,
        ...(target.condition !== other?.condition
          ? {
              note: 'SAP keeps one breakpoint per line, with one condition: its stops are reported for the first. To stop on either condition, join both with OR in one breakpoint.',
            }
          : {}),
      });
    } else if (hit && state?.id) {
      const line = state.line ?? hit.line;
      armed.push({
        id: state.id,
        clientId: state.clientId || lineClientId(index, hit.requested),
        label: target.label,
        kind: 'line',
        uri: target.uri.toLowerCase(),
        sourceUri: target.uri,
        line,
        ...condition,
        maxHits: target.hits,
        reportIndex: report.length,
      });
      report.push({
        kind: 'line',
        location: target.label,
        status: 'set',
        line,
        uri: `${target.uri}#start=${line}`,
        ...condition,
      });
    } else if (hit && first === index) {
      // The probe armed the line, the final sync did not keep it: with a condition, SAP refused the condition.
      report.push({
        kind: 'line',
        location: target.label,
        status: 'refused',
        error:
          state?.error ?? (target.condition ? 'SAP did not accept the condition' : 'SAP did not keep the breakpoint'),
        line: hit.line,
        ...condition,
      });
    } else {
      const refusal = target.candidates
        .map((line) => stateFor(probe, index, target, line, sole)?.error)
        .find((error) => error);
      report.push({
        kind: 'line',
        location: target.label,
        status: 'refused',
        error: state?.error ?? refusal ?? 'SAP did not accept a breakpoint there',
        triedLines: target.candidates,
        ...condition,
      });
    }
  });
  const unknownStatements: Array<Record<string, unknown>> = [];
  const runEvents: RunEvent[] = [];
  events.forEach((event, index) => {
    if (inRun) {
      // Set at the run's first stop: until then the report says so.
      runEvents.push({ event, index, reportIndex: report.length });
      report.push({ ...eventReport(event), status: 'pending', scope: 'run' });
      return;
    }
    const state = eventState(states, event, index);
    if (state?.id) {
      armed.push({
        id: state.id,
        clientId: eventClientId(index, event),
        label: eventLabel(event),
        kind: event.kind,
        maxHits: event.hits,
        reportIndex: report.length,
      });
      report.push({ ...eventReport(event), status: 'set' });
    } else {
      const entry = { ...eventReport(event), status: 'refused', error: state?.error ?? 'not accepted by SAP' };
      report.push(entry);
      if (event.kind === 'statement') unknownStatements.push(entry);
    }
  });
  if (unknownStatements.length > 0) {
    // Best effort: SAP's own list of statement kinds lets the next call name one it knows.
    try {
      const known = (await listDebugStatements(conn.http)).map((statement) => statement.name).filter(Boolean);
      if (known.length > 0) for (const entry of unknownStatements) entry.known = known.slice(0, 100);
    } catch {
      // the refusal stands on its own
    }
  }
  return { ids: [...armedIds], armed, report, inRun: runEvents, ...(armedFrom ? { armedFrom } : {}) };
}

/** A pending run event that never got set: the run did not stop. */
export function unsetRunEvents(
  armed: ArmedBreakpoints,
  note = 'it is set in the debugged run at its first stop, and the run never stopped',
): void {
  for (const { reportIndex } of armed.inRun) {
    const entry = armed.report[reportIndex];
    if (entry?.status === 'pending') {
      entry.status = 'not set';
      entry.note = note;
    }
  }
}

/**
 * At the run's first stop: set its event breakpoints in this run only (`scope=debugger`). The run's
 * breakpoint set is replaced as a whole, so its line breakpoints go along — SAP may renumber them,
 * and the ids it names later are matched through `aliases`. `cleanup` collects the new ids for the
 * release. A refusal leaves the run's line breakpoints as they were.
 */
export async function armInRun(
  session: DebuggerSession,
  armed: ArmedBreakpoints,
  cleanup: string[],
  warnings: string[],
): Promise<void> {
  if (armed.inRun.length === 0) return;
  const lines = armed.armed.filter((bp) => bp.kind === 'line' && bp.sourceUri && bp.line !== undefined);
  const specs: DebugBreakpointSpec[] = [
    ...lines.map(
      (bp): DebugBreakpointSpec => ({
        kind: 'line',
        clientId: bp.clientId,
        uri: bp.sourceUri as string,
        line: bp.line as number,
        ...(bp.condition ? { condition: bp.condition } : {}),
      }),
    ),
    ...armed.inRun.map(({ event, index }) => eventSpec(event, index)),
  ];
  let states: DebugBreakpointState[];
  try {
    states = await session.syncRunBreakpoints(specs);
  } catch (err) {
    for (const { reportIndex } of armed.inRun) {
      const entry = armed.report[reportIndex];
      if (entry) Object.assign(entry, { status: 'refused', error: debuggerErrorText(err) });
    }
    warnings.push(`Could not set the event breakpoints in the debugged run: ${debuggerErrorText(err)}.`);
    return;
  }
  if (states.length === 0) {
    // SAP took the set without echoing it: the line breakpoints keep their ids, the event ones learn
    // theirs from the first stop that names them.
    for (const { event, index, reportIndex } of armed.inRun) {
      armed.armed.push({
        id: eventClientId(index, event),
        clientId: eventClientId(index, event),
        unconfirmed: true,
        label: eventLabel(event),
        kind: event.kind,
        maxHits: event.hits,
        reportIndex,
      });
      const entry = armed.report[reportIndex];
      if (entry) entry.status = 'set';
    }
    return;
  }
  for (const bp of lines) {
    const state = states.find((candidate) => candidate.clientId === bp.clientId);
    if (state?.id && state.id !== bp.id) {
      bp.aliases = [...(bp.aliases ?? []), bp.id];
      bp.id = state.id;
      cleanup.push(state.id);
    } else if (!state?.id) {
      warnings.push(`SAP did not keep ${bp.label} in the run when its event breakpoints were set there.`);
    }
  }
  for (const { event, index, reportIndex } of armed.inRun) {
    const state = eventState(states, event, index);
    const entry = armed.report[reportIndex] ?? {};
    if (state?.id) {
      armed.armed.push({
        id: state.id,
        clientId: eventClientId(index, event),
        label: eventLabel(event),
        kind: event.kind,
        maxHits: event.hits,
        reportIndex,
      });
      cleanup.push(state.id);
      entry.status = 'set';
    } else {
      Object.assign(entry, { status: 'refused', error: state?.error ?? 'not accepted by SAP' });
    }
  }
}

/** Removing the external breakpoints: while they are armed, a request of this server can itself stop
 *  at one (an exception SAP code raises) and wait for an attach — so the removal has a short budget. */
const DISARM_BUDGET_MS = 15_000;

/**
 * Remove the capture's external breakpoints; false when SAP did not confirm they are gone. `via`: the
 * session that armed them (`ArmedBreakpoints.armedFrom`) — removing the last one switches debugging
 * off only on the server that removes it. When that session fails, the empty sync falls back to
 * `conn.http`.
 */
export async function disarm(
  conn: SapConnection,
  identity: DebugIdentity,
  ids: readonly string[],
  warnings: string[],
  via: AdtHttpClient = conn.http,
): Promise<boolean> {
  const options = { deadline: Date.now() + DISARM_BUDGET_MS };
  let failed = false;
  for (const id of ids) {
    try {
      await deleteBreakpoint(via, identity, id, 'external', options);
    } catch {
      failed = true;
    }
  }
  if (!failed) return true;
  let error: unknown;
  for (const http of via === conn.http ? [via] : [via, conn.http]) {
    try {
      await syncBreakpoints(http, identity, [], 'external', { deadline: Date.now() + DISARM_BUDGET_MS });
      return true;
    } catch (err) {
      error = err;
    }
  }
  warnings.push(
    `Could not remove the capture's external breakpoints: ${debuggerErrorText(error)}. The next capture of this user removes them, or abap_breakpoints with action "delete".`,
  );
  return false;
}

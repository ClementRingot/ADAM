/**
 * ABAP debugger over ADT REST (`/sap/bc/adt/debugger/*`) — the building blocks of the `abap_debug`
 * captures and interactive sessions.
 *
 * Contract (corroborated by abap-adt-api, vscode_abap_remote_fs and vibing-steampunk — see
 * docs/adt-debugger-protocol.md):
 * - breakpoints and the listener are keyed by `debuggingMode=user` + `requestUser` + `terminalId` +
 *   `ideId`; `requestUser` MUST be the real SAP logon user (an empty one matches nothing);
 * - the listener is a long poll that answers with the stopped debuggee, or an empty body at timeout;
 * - attach → stack → variables → step → release must share ONE stateful session (`sap-contextid`)
 *   whose requests SAP runs on the debuggee's application server, so `DebuggerSession` is
 *   constructed with the session `openRoutedSession()` returns, once `checkRoute()` confirmed it.
 *
 * Deliberately absent: variable writes (`setVariableValue`), `stepJumpToLine` and system debugging —
 * the debugger observes a run, it never changes what the program does. `terminateDebuggee` aborts
 * it only when an interactive session is ended with `terminate`, or as the release's last resort.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { AdtApiError } from './errors.js';
import type { AdtHttpClient, AdtRequestOptions, AdtResponse } from './http.js';
import { SAPLB_HEADER } from './routing-headers.js';
import { ABSENT_STATUSES, SYSTEM_INFORMATION_ACCEPT, SYSTEM_INFORMATION_PATH } from './session-user.js';
import { asNode, asNodes, attr, escapeXml, parseXml, text, type XmlNode } from './xml.js';

const DEBUGGER_PATH = '/sap/bc/adt/debugger';
const BREAKPOINTS_PATH = '/sap/bc/adt/debugger/breakpoints';
const WATCHPOINTS_PATH = '/sap/bc/adt/debugger/watchpoints';
const LISTENERS_PATH = '/sap/bc/adt/debugger/listeners';
const STACK_QUERY = 'method=getStack&emode=_&semanticURIs=true';
/** Extra HTTP budget on top of the server-side listener timeout before the client gives up. */
const LISTEN_HTTP_GRACE_SECONDS = 30;
const AS_XML = 'application/vnd.sap.as+xml';
const VARIABLES_CONTENT_TYPE = `${AS_XML};charset=UTF-8;dataname=com.sap.adt.debugger.Variables`;
const CHILD_VARIABLES_CONTENT_TYPE = `${AS_XML};charset=UTF-8;dataname=com.sap.adt.debugger.ChildVariables`;
const SUBTYPE_KEY = 'com.sap.adt.communicationFramework.subType';

function flag(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'x';
}

function toInt(value: string): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The shared ADT XML boundary: entities decoded once, single repeated elements left unwrapped
 *  (every reader below goes through `asNodes`, which accepts one node or many). `exact` keeps the
 *  texts' leading and trailing blanks — a variable's value needs them. */
function parseDocument(xml: string, exact = false): XmlNode {
  return asNode(parseXml(xml, exact)) ?? {};
}

/** Children of `<asx:abap><asx:values><DATA>` — every debugger ABAP-XML envelope uses it. */
function abapData(xml: string, exact = false): XmlNode | undefined {
  return asNodes(asNode(asNode(parseDocument(xml, exact).abap)?.values)?.DATA)[0];
}

// ─── Identity ──────────────────────────────────────────────────────

/** The (requestUser, terminalId, ideId) triple every listener/breakpoint request carries. */
export interface DebugIdentity {
  /** SAP logon user, upper case — the only user a capture ever debugs. */
  user: string;
  terminalId: string;
  ideId: string;
}

const randomId = (): string => randomUUID().replace(/-/g, '').toUpperCase();

/** A fresh identity per capture: a full breakpoint sync then only ever touches the capture's own set. */
export function createDebugIdentity(user: string): DebugIdentity {
  return { user: user.trim().toUpperCase(), terminalId: randomId(), ideId: randomId() };
}

function identityQuery(identity: DebugIdentity, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    debuggingMode: 'user',
    requestUser: identity.user,
    terminalId: identity.terminalId,
    ideId: identity.ideId,
    ...extra,
  }).toString();
}

// ─── Errors ────────────────────────────────────────────────────────

/** The parts of an ADT debugger exception document worth acting on. */
export interface DebuggerException {
  type?: string;
  /** `com.sap.adt.communicationFramework.subType`, e.g. debuggeeEnded, conflictDetected. */
  subType?: string;
  message?: string;
  conflictText?: string;
}

export function parseDebuggerException(xml: string | undefined): DebuggerException | undefined {
  if (!xml?.includes('exception')) return undefined;
  let exception: XmlNode | undefined;
  try {
    exception = asNode(parseDocument(xml).exception);
  } catch {
    return undefined;
  }
  if (!exception) return undefined;
  const properties = asNodes(asNode(exception.properties)?.entry);
  const property = (key: string): string | undefined => {
    const entry = properties.find((candidate) => attr(candidate, 'key') === key);
    const value = entry ? text(entry).trim() : '';
    return value || undefined;
  };
  const message = text(exception.localizedMessage).trim() || text(exception.message).trim();
  const type = attr(asNode(exception.type) ?? {}, 'id');
  return {
    ...(type ? { type } : {}),
    ...(property(SUBTYPE_KEY) ? { subType: property(SUBTYPE_KEY) } : {}),
    ...(message ? { message } : {}),
    ...(property('conflictText') ? { conflictText: property('conflictText') } : {}),
  };
}

/** The debugger subType carried by a failed ADT call, if SAP sent one. */
export function debuggerErrorSubType(err: unknown): string | undefined {
  return err instanceof AdtApiError ? parseDebuggerException(err.responseBody)?.subType : undefined;
}

/** SAP's human-readable sentence for a failed debugger call (falls back to the error message). */
export function debuggerErrorText(err: unknown): string {
  if (err instanceof AdtApiError) {
    const exception = parseDebuggerException(err.responseBody);
    const textual = exception?.conflictText ?? exception?.message;
    if (textual) return textual;
  }
  return err instanceof Error ? err.message : String(err);
}

export function isConflictSubType(subType: string | undefined): boolean {
  return subType === 'conflictDetected' || subType === 'conflictNotification';
}

/** The debuggee is gone or no longer attached — the release path treats both as "released". */
export function isEndedSubType(subType: string | undefined): boolean {
  return subType === 'debuggeeEnded' || subType === 'noSessionAttached';
}

// ─── Breakpoints ───────────────────────────────────────────────────

export type DebugBreakpointScope = 'external' | 'debugger';

export type DebugBreakpointSpec =
  | {
      kind: 'line';
      clientId: string;
      /** Source URI without fragment. */
      uri: string;
      line: number;
      /** ABAP condition SAP evaluates at the line: the run stops there only where it holds. */
      condition?: string;
    }
  | { kind: 'exception'; clientId: string; exceptionClass: string }
  /** A MESSAGE statement issuing this message; an empty `msgTy` matches every type. */
  | { kind: 'message'; clientId: string; msgId: string; msgNo: string; msgTy: string }
  /** Every ABAP statement of a kind SAP lists (`listDebugStatements`), e.g. COMMIT WORK. */
  | { kind: 'statement'; clientId: string; statement: string };

/** One breakpoint of a full sync, as the ADT debugger takes it (abap-adt-api `formatBreakpoint`). */
function breakpointXml(spec: DebugBreakpointSpec): string {
  const client = `clientId="${escapeXml(spec.clientId)}" skipCount="0"`;
  switch (spec.kind) {
    case 'line':
      return `<breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="line" ${client} adtcore:uri="${escapeXml(`${spec.uri}#start=${spec.line}`)}"${spec.condition ? ` condition="${escapeXml(spec.condition)}"` : ''}/>`;
    case 'exception':
      return `<breakpoint kind="exception" ${client} exceptionClass="${escapeXml(spec.exceptionClass)}"/>`;
    case 'message':
      return `<breakpoint kind="message" ${client} msgId="${escapeXml(spec.msgId)}" msgNo="${escapeXml(spec.msgNo)}" msgTy="${escapeXml(spec.msgTy)}"/>`;
    case 'statement':
      return `<breakpoint kind="statement" ${client} statement="${escapeXml(spec.statement)}"/>`;
  }
}

export interface DebugBreakpointState {
  clientId: string;
  kind: string;
  /** Server-assigned id; absent when SAP refused the breakpoint. */
  id?: string;
  uri?: string;
  line?: number;
  exceptionClass?: string;
  condition?: string;
  msgId?: string;
  msgNo?: string;
  statement?: string;
  /** SAP's refusal, e.g. "Cannot create a breakpoint at this position". */
  error?: string;
}

/** POST body that synchronizes this identity's breakpoint set (`syncScope full` → exactly `specs`). */
export function buildBreakpointsXml(
  identity: DebugIdentity,
  specs: readonly DebugBreakpointSpec[],
  scope: DebugBreakpointScope,
): string {
  const items = specs.map(breakpointXml).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" scope="${scope}" debuggingMode="user"` +
    ` requestUser="${escapeXml(identity.user)}" terminalId="${escapeXml(identity.terminalId)}"` +
    ` ideId="${escapeXml(identity.ideId)}" systemDebugging="false" deactivated="false">` +
    `<syncScope mode="full"></syncScope>${items}</dbg:breakpoints>`
  );
}

export function parseBreakpointsResponse(xml: string): DebugBreakpointState[] {
  if (!xml.trim()) return [];
  const breakpoints = asNodes(asNode(parseDocument(xml).breakpoints)?.breakpoint);
  return breakpoints.map((node) => {
    const [uri, fragment] = attr(node, 'uri').split('#', 2);
    const line = fragment ? toInt(/start=(\d+)/.exec(fragment)?.[1] ?? '') : undefined;
    const id = attr(node, 'id');
    const error = attr(node, 'errorMessage');
    const optional = (name: string, key = name): Record<string, string> => {
      const value = attr(node, name);
      return value ? { [key]: value } : {};
    };
    return {
      clientId: attr(node, 'clientId'),
      kind: attr(node, 'kind'),
      ...(id ? { id } : {}),
      ...(uri ? { uri } : {}),
      ...(line !== undefined ? { line } : {}),
      ...optional('exceptionClass'),
      ...optional('condition'),
      ...optional('msgId'),
      ...optional('msgNo'),
      ...optional('statement'),
      ...(error ? { error } : {}),
    };
  });
}

/** Replace this identity's breakpoint set with `specs` (an empty list clears it). */
export async function syncBreakpoints(
  http: AdtHttpClient,
  identity: DebugIdentity,
  specs: readonly DebugBreakpointSpec[],
  scope: DebugBreakpointScope = 'external',
  options?: AdtRequestOptions,
): Promise<DebugBreakpointState[]> {
  const resp = await http.post(
    BREAKPOINTS_PATH,
    buildBreakpointsXml(identity, specs, scope),
    'application/xml',
    { Accept: 'application/xml' },
    options,
  );
  return parseBreakpointsResponse(resp.body);
}

export async function deleteBreakpoint(
  http: AdtHttpClient,
  identity: DebugIdentity,
  id: string,
  scope: DebugBreakpointScope = 'external',
  options?: AdtRequestOptions,
): Promise<void> {
  await http.delete(
    `${BREAKPOINTS_PATH}/${encodeURIComponent(id)}?${identityQuery(identity, { scope })}`,
    { Accept: 'application/xml' },
    options,
  );
}

/** An ABAP statement kind a `statement` breakpoint can stop at. */
export interface DebugStatement {
  name: string;
  description: string;
  group: string;
}

/** The statement kinds SAP offers for statement breakpoints (abap-adt-api `debuggerStatements`). */
export async function listDebugStatements(http: AdtHttpClient, options?: AdtRequestOptions): Promise<DebugStatement[]> {
  const resp = await http.get(`${BREAKPOINTS_PATH}/statements`, { Accept: 'application/xml' }, options);
  if (!resp.body.trim()) return [];
  return asNodes(asNode(parseDocument(resp.body).statements)?.statement).map((node) => ({
    name: attr(node, 'name'),
    description: attr(node, 'description'),
    group: attr(node, 'group'),
  }));
}

// ─── Listener ──────────────────────────────────────────────────────

/** A debuggee stopped at a breakpoint and waiting for an attach (`STPDA_DEBUGGEE`). */
export interface Debuggee {
  id: string;
  user: string;
  program: string;
  include: string;
  line?: number;
  kind: string;
  attachImpossible: boolean;
  /** The application server the debuggee waits on (`INSTANCE_NAME`, the name `sap-contextid` carries). */
  instance?: string;
  uri?: string;
  objectType?: string;
  objectName?: string;
}

export function parseDebuggee(xml: string): Debuggee | undefined {
  if (!xml.trim()) return undefined;
  const node = asNodes(abapData(xml)?.STPDA_DEBUGGEE)[0];
  if (!node) return undefined;
  const field = (name: string): string => text(node[name]).trim();
  const id = field('DEBUGGEE_ID');
  if (!id) return undefined;
  const line = toInt(field('LINE_CURR'));
  return {
    id,
    user: field('DEBUGGEE_USER'),
    program: field('PRG_CURR'),
    include: field('INCL_CURR'),
    ...(line !== undefined ? { line } : {}),
    kind: field('DBGEE_KIND'),
    attachImpossible: flag(field('IS_ATTACH_IMPOSSIBLE')),
    ...(field('INSTANCE_NAME') ? { instance: field('INSTANCE_NAME') } : {}),
    ...(field('URI') ? { uri: field('URI') } : {}),
    ...(field('TYPE') ? { objectType: field('TYPE') } : {}),
    ...(field('NAME') ? { objectName: field('NAME') } : {}),
  };
}

export type DebugListenResult =
  | { status: 'caught'; debuggee: Debuggee }
  | { status: 'timeout' }
  | { status: 'conflict'; message: string };

/**
 * Is another IDE (Eclipse, VS Code, another capture) already listening for this user? Returns
 * SAP's conflict text, or undefined. A release without the conflict check answers 404/405 — the
 * listener's own `checkConflict=true` still protects that case.
 */
export async function findListenerConflict(
  http: AdtHttpClient,
  identity: DebugIdentity,
  options?: AdtRequestOptions,
): Promise<string | undefined> {
  try {
    const resp = await http.get(
      `${LISTENERS_PATH}?${identityQuery(identity, { checkConflict: 'true' })}`,
      { Accept: '*/*' },
      options,
    );
    const exception = parseDebuggerException(resp.body);
    if (isConflictSubType(exception?.subType)) return exception?.conflictText ?? exception?.message ?? 'conflict';
    return undefined;
  } catch (err) {
    if (isConflictSubType(debuggerErrorSubType(err))) return debuggerErrorText(err);
    if (err instanceof AdtApiError && [404, 405].includes(err.statusCode)) return undefined;
    throw err;
  }
}

/**
 * Long-poll until a debuggee of `identity.user` stops at a breakpoint, SAP reports a conflict, or the
 * server-side `timeoutSeconds` elapses (empty body). Run it on the STATELESS client: SAP keeps a
 * poll running until its timeout even after the client stops waiting, and a stateful session answers
 * one request at a time.
 */
export async function listenForDebuggee(
  http: AdtHttpClient,
  identity: DebugIdentity,
  timeoutSeconds: number,
  options: AdtRequestOptions = {},
): Promise<DebugListenResult> {
  const query = identityQuery(identity, {
    checkConflict: 'true',
    isNotifiedOnConflict: 'true',
    timeout: String(Math.max(1, Math.floor(timeoutSeconds))),
  });
  let body: string;
  try {
    const resp = await http.post(
      `${LISTENERS_PATH}?${query}`,
      undefined,
      undefined,
      { Accept: AS_XML },
      { fetchTimeoutMs: (timeoutSeconds + LISTEN_HTTP_GRACE_SECONDS) * 1000, ...options },
    );
    body = resp.body;
  } catch (err) {
    if (isConflictSubType(debuggerErrorSubType(err))) return { status: 'conflict', message: debuggerErrorText(err) };
    throw err;
  }
  if (!body.trim()) return { status: 'timeout' };
  const exception = parseDebuggerException(body);
  if (exception) {
    if (isConflictSubType(exception.subType)) {
      return { status: 'conflict', message: exception.conflictText ?? exception.message ?? 'conflict' };
    }
    throw new AdtApiError(exception.message ?? 'Debugger listener failed', 500, LISTENERS_PATH, body);
  }
  const debuggee = parseDebuggee(body);
  return debuggee ? { status: 'caught', debuggee } : { status: 'timeout' };
}

/** One long poll lasts at most this long; the registration survives between polls. */
const LISTEN_CHUNK_SECONDS = 120;
/** Between two polls SAP answered at once (it should not): a pause instead of a busy loop. */
const LISTEN_REPOLL_PAUSE_MS = 1000;

/**
 * Listen for `totalSeconds` in all: one long poll after another, each at most LISTEN_CHUNK_SECONDS,
 * so a long wait never rides on a single request (proxies and the Cloud Connector cut long ones).
 * The registration survives a poll's empty answer, and a debuggee that stops between two polls
 * waits for the next one. Ends on a stop, a conflict, an error, the total time, or `signal`.
 */
export async function listenUntil(
  http: AdtHttpClient,
  identity: DebugIdentity,
  totalSeconds: number,
  options: AdtRequestOptions = {},
): Promise<DebugListenResult> {
  const end = Date.now() + totalSeconds * 1000;
  for (;;) {
    const left = Math.ceil((end - Date.now()) / 1000);
    if (left <= 0 || options.signal?.aborted) return { status: 'timeout' };
    const started = Date.now();
    const chunk = Math.min(left, LISTEN_CHUNK_SECONDS);
    const result = await listenForDebuggee(http, identity, chunk, options);
    if (result.status !== 'timeout') return result;
    if (Date.now() - started < (chunk * 1000) / 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(LISTEN_REPOLL_PAUSE_MS, Math.max(0, end - Date.now()))),
      );
    }
  }
}

/**
 * Remove the user's listener registration. In user mode SAP keys it by user ALONE (IDE_ID = user,
 * TERMINAL_ID = '%_USER'), so a DELETE quoting our ids would match nothing and the registration would
 * swallow the next debuggee. Removing it also drops the user's external breakpoints (SAP behavior).
 */
export async function stopListener(http: AdtHttpClient, user: string, options?: AdtRequestOptions): Promise<void> {
  const query = new URLSearchParams({ debuggingMode: 'user', requestUser: user.toUpperCase() }).toString();
  await http.delete(`${LISTENERS_PATH}?${query}`, { Accept: '*/*' }, options);
}

// ─── The debuggee's server ─────────────────────────────────────────
//
// The attach must run on the debuggee's application server: the key SAP attaches with
// (`ABDBG_ACTIVATION-DBGKEY`) is valid there only, and an attach refused elsewhere has already deleted
// the debuggee's waiting entry — every later attach fails too (CL_ABDBG_ACT_FOR_ATTACH__USER, ATTACH).
// SAP's ADT handler runs a request on the server it names in `X-sap-adt-server-instance` (an instance
// of TH_SERVER_LIST, as INSTANCE_NAME names the debuggee's): the server that receives it forwards it
// there over RFC, on one RFC connection that lives as long as the stateful HTTP session — the
// debugger's ABAP session there (CL_ADT_WB_RES_APP, `get_debugger_destination`). So a debugger session
// is a stateful session routed to the debuggee's server, wherever the load balancer put it; nothing
// probes for servers. See docs/adt-debugger-protocol.md §5.

/** A request SAP's ADT handler could not forward to another application server (CX_ADT_REST_ROUTING). */
export function isRoutingError(err: unknown): boolean {
  if (!(err instanceof AdtApiError)) return false;
  const exception = parseDebuggerException(err.responseBody);
  return (
    exception?.type === 'ExceptionRequestRooting' ||
    exception?.subType === 'ExceptionOnTargetServer' ||
    exception?.subType === 'NoAuthorization'
  );
}

/**
 * A stateful session whose every request SAP runs on application server `server` (see
 * `AdtHttpClient.openStatefulSession`); a plain stateful session without one. The caller ends it
 * with `endSession`.
 */
export function openRoutedSession(http: AdtHttpClient, server: string | undefined): AdtHttpClient {
  return http.openStatefulSession(server ? { server } : {});
}

/** Where SAP ran a request of a routed session. */
export type RouteCheck =
  /** The server that received it forwarded it to the routed server. */
  | { status: 'forwarded' }
  /** The session itself is on the routed server. */
  | { status: 'local' }
  /** A release that names no server (SAP_BASIS 7.50): the session's own server is unknown too. */
  | { status: 'unknown' }
  /** SAP ran it on the server that received it, another one: this release does not route ADT requests. */
  | { status: 'ignored'; ranOn: string }
  /** SAP could not forward it (the RFC to the routed server failed): its own sentence. */
  | { status: 'failed'; error: string };

/** A server name as `sap-adt-saplb` gives it MD5-encoded (profile parameter is/instname_encoding = md5). */
const ENCODED_SERVER = /^[0-9a-f]{32}$/i;

const sameServer = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * Where SAP runs the requests of `session` (from `openRoutedSession`), asked with one harmless request
 * before anything depends on it: an attach run on the wrong server fails and spoils the debuggee. The
 * handler that runs a request itself names its server in `sap-adt-saplb`; one it forwards does not. A
 * release without the resource (SAP_BASIS 7.50) routes no HTTP request either: there the server the
 * session landed on (`sap-contextid`) tells. A transport or authorization failure that is no routing
 * failure propagates.
 */
export async function checkRoute(
  session: AdtHttpClient,
  server: string,
  options: AdtRequestOptions = {},
): Promise<RouteCheck> {
  let resp: AdtResponse | undefined;
  try {
    resp = await session.get(SYSTEM_INFORMATION_PATH, { Accept: SYSTEM_INFORMATION_ACCEPT }, options);
  } catch (err) {
    if (isRoutingError(err)) return { status: 'failed', error: debuggerErrorText(err) };
    if (!(err instanceof AdtApiError && ABSENT_STATUSES.has(err.statusCode))) throw err;
  }
  const ranOn = resp?.headers[SAPLB_HEADER]?.trim();
  const landed = contextServer(session.sessionContextId);
  // An encoded name cannot be compared: SAP ran the request itself, which it does only on the routed server.
  if (ranOn && (sameServer(ranOn, server) || ENCODED_SERVER.test(ranOn))) return { status: 'local' };
  const elsewhere = ranOn ?? (resp ? undefined : landed);
  if (elsewhere && !sameServer(elsewhere, server)) {
    logger.debug('SAP did not route a debugger request', { routedTo: server, ranOn: elsewhere });
    return { status: 'ignored', ranOn: elsewhere };
  }
  if (landed && sameServer(landed, server)) return { status: 'local' };
  return resp ? { status: 'forwarded' } : { status: 'unknown' };
}

/**
 * The application server that answers a request on `http` (`sap-adt-saplb`), for what a server's name
 * tells — an AS ABAP instance or a BTP ABAP Environment pod. Undefined where SAP does not say; never throws.
 */
export async function answeringServer(
  http: AdtHttpClient,
  options: AdtRequestOptions = {},
): Promise<string | undefined> {
  try {
    const resp = await http.get(
      SYSTEM_INFORMATION_PATH,
      { Accept: SYSTEM_INFORMATION_ACCEPT, [SAPLB_HEADER]: 'fetch' },
      { ...options, suppressNotFoundLog: true },
    );
    return resp.headers[SAPLB_HEADER]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The application server a session is pinned to, from its `sap-contextid` (`SID:ANON:<server>:<id>`). */
export function contextServer(contextId: string | undefined): string | undefined {
  if (!contextId) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(contextId);
  } catch {
    return undefined;
  }
  const parts = decoded.split(':');
  return parts.length >= 4 && parts[0] === 'SID' && parts[2] ? parts[2] : undefined;
}

/**
 * Best-effort: close a session from `openStatefulSession()` the way Eclipse ADT does
 * (`AdtHttpClient.endStatefulSession`: the dedicated close-session request on its context).
 */
export async function endSession(session: AdtHttpClient, options: AdtRequestOptions = {}): Promise<void> {
  // Best-effort and never throws: a session SAP did not close only lives until its session timeout.
  await session.endStatefulSession(options);
}

// ─── Session documents ─────────────────────────────────────────────

/** A breakpoint SAP says the run stopped at (attach and step answers). */
export interface ReachedBreakpoint {
  id: string;
  kind: string;
  /** SAP could not evaluate the breakpoint's condition and stopped anyway (as SAP words it). */
  unresolvableCondition?: string;
  /** Character offset in the condition where its evaluation failed, when SAP says. */
  conditionErrorOffset?: number;
}

function parseReachedBreakpoints(node: XmlNode): ReachedBreakpoint[] {
  return asNodes(asNode(node.reachedBreakpoints)?.breakpoint).map((bp) => {
    const unresolvable = attr(bp, 'unresolvableCondition').trim();
    const offset = toInt(attr(bp, 'unresolvableConditionErrorOffset'));
    const failed = unresolvable !== '' && unresolvable.toLowerCase() !== 'false';
    return {
      id: attr(bp, 'id'),
      kind: attr(bp, 'kind'),
      ...(failed ? { unresolvableCondition: unresolvable } : {}),
      ...(failed && offset !== undefined ? { conditionErrorOffset: offset } : {}),
    };
  });
}

export interface DebugAttachInfo {
  steppingPossible: boolean;
  postMortem: boolean;
  /**
   * SAP found no free work process for exclusive debugging and attached non-exclusively: the program
   * rolls out after each debugger interaction, which commits its open database work.
   */
  nonExclusive: boolean;
  reachedBreakpoints: ReachedBreakpoint[];
}

export function parseAttachResponse(xml: string): DebugAttachInfo {
  const node = asNode(parseDocument(xml).attach) ?? {};
  return {
    steppingPossible: attr(node, 'isSteppingPossible') === '' ? true : flag(attr(node, 'isSteppingPossible')),
    postMortem: flag(attr(node, 'isPostMortem')),
    nonExclusive: flag(attr(node, 'isNonExclusive')),
    reachedBreakpoints: parseReachedBreakpoints(node),
  };
}

/** A watchpoint of the attached run (abap-adt-api's `DebugWatchpoint`). */
export interface DebugWatchpoint {
  id: string;
  variableName: string;
  kind: string;
  active: boolean;
  expired: boolean;
  procedure: string;
  condition: string;
  oldValue: string;
  currentValue: string;
}

/** `<watchpoints><watchpoint id variableName kind active expired procedure><condition/>…`: attributes, and texts. */
export function parseWatchpoints(xml: string): DebugWatchpoint[] {
  if (!xml.trim()) return [];
  return asNodes(asNode(parseDocument(xml).watchpoints)?.watchpoint).map((node) => ({
    id: attr(node, 'id'),
    variableName: attr(node, 'variableName'),
    kind: attr(node, 'kind'),
    active: flag(attr(node, 'active')),
    expired: flag(attr(node, 'expired')),
    procedure: attr(node, 'procedure'),
    condition: text(node.condition),
    oldValue: text(node.oldValue),
    currentValue: text(node.currentValue),
  }));
}

export interface DebugStackFrame {
  position?: number;
  stackType: string;
  program: string;
  include: string;
  line?: number;
  eventType: string;
  eventName: string;
  systemProgram: boolean;
  uri?: string;
}

/** Stack entries in document order — the first entry is the frame the debuggee stopped in. */
export function parseStackResponse(xml: string): DebugStackFrame[] {
  const entries = asNodes(asNode(parseDocument(xml).stack)?.stackEntry);
  return entries.map((entry) => {
    const position = toInt(attr(entry, 'stackPosition'));
    const line = toInt(attr(entry, 'line'));
    const uri = attr(entry, 'uri');
    return {
      ...(position !== undefined ? { position } : {}),
      stackType: attr(entry, 'stackType'),
      program: attr(entry, 'programName'),
      include: attr(entry, 'includeName'),
      ...(line !== undefined ? { line } : {}),
      eventType: attr(entry, 'eventType'),
      eventName: attr(entry, 'eventName'),
      systemProgram: flag(attr(entry, 'systemProgram')),
      ...(uri ? { uri } : {}),
    };
  });
}

/** One `STPDA_ADT_VARIABLE` row. */
export interface DebugVariable {
  id: string;
  name: string;
  declaredType: string;
  actualType: string;
  /** simple | string | structure | table | objectref | dataref | class | object | boxref | … */
  metaType: string;
  technicalType: string;
  /** As SAP sent it, blanks included: a string's trailing blank is part of it (`CONV string( 124 )` = `'124 '`). */
  value: string;
  tableLines?: number;
  /** SAP truncated the value (IS_VALUE_INCOMPLETE). */
  incomplete: boolean;
}

export interface DebugVariableHierarchy {
  parentId: string;
  childId: string;
  childName: string;
}

function parseVariableNode(node: XmlNode): DebugVariable {
  const field = (name: string): string => text(node[name]);
  const tableLines = toInt(field('TABLE_LINES'));
  return {
    id: field('ID').trim(),
    name: field('NAME').trim(),
    declaredType: field('DECLARED_TYPE_NAME').trim(),
    actualType: field('ACTUAL_TYPE_NAME').trim(),
    metaType: field('META_TYPE').trim().toLowerCase(),
    technicalType: field('TECHNICAL_TYPE').trim(),
    value: field('VALUE'),
    ...(tableLines !== undefined ? { tableLines } : {}),
    incomplete: flag(field('IS_VALUE_INCOMPLETE')),
  };
}

export function parseVariablesResponse(xml: string): DebugVariable[] {
  if (!xml.trim()) return [];
  return asNodes(abapData(xml, true)?.STPDA_ADT_VARIABLE).map(parseVariableNode);
}

export function parseChildVariablesResponse(xml: string): {
  hierarchies: DebugVariableHierarchy[];
  variables: DebugVariable[];
} {
  if (!xml.trim()) return { hierarchies: [], variables: [] };
  const data = abapData(xml, true);
  const hierarchies = asNodes(asNode(data?.HIERARCHIES)?.STPDA_ADT_VARIABLE_HIERARCHY).map((node) => ({
    parentId: text(node.PARENT_ID).trim(),
    childId: text(node.CHILD_ID).trim(),
    childName: text(node.CHILD_NAME).trim(),
  }));
  const variables = asNodes(asNode(data?.VARIABLES)?.STPDA_ADT_VARIABLE).map(parseVariableNode);
  return { hierarchies, variables };
}

function asXmlEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${inner}</DATA></asx:values></asx:abap>`;
}

export function buildVariablesXml(ids: readonly string[]): string {
  return asXmlEnvelope(ids.map((id) => `<STPDA_ADT_VARIABLE><ID>${escapeXml(id)}</ID></STPDA_ADT_VARIABLE>`).join(''));
}

export function buildChildVariablesXml(parents: readonly string[]): string {
  const rows = parents
    .map(
      (parent) =>
        `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${escapeXml(parent)}</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY>`,
    )
    .join('');
  return asXmlEnvelope(`<HIERARCHIES>${rows}</HIERARCHIES>`);
}

// ─── Stateful session ──────────────────────────────────────────────

export type DebugStepMethod =
  | 'stepInto'
  | 'stepOver'
  | 'stepReturn'
  | 'stepContinue'
  | 'stepRunToLine'
  | 'terminateDebuggee';

export type DebugStepResult =
  | {
      status: 'stopped';
      steppingPossible: boolean;
      /** Ids of the breakpoints the run stopped at, when SAP names them. */
      reachedBreakpoints: string[];
      /** Those of them whose condition SAP could not evaluate (it stopped anyway). */
      unresolvableConditions?: ReachedBreakpoint[];
    }
  | { status: 'ended'; reason: string };

export interface DebugReleaseResult {
  released: boolean;
  /** continue = the program ran on to its end; terminate = SAP aborted the debuggee's session. */
  via: 'continue' | 'terminate' | 'none';
  detail?: string;
}

/**
 * One attached debug session. Construct it with a session from `openRoutedSession()` — the attach
 * lives in an ABAP session on the debuggee's server that only the same `sap-contextid`, routed there,
 * can reach again.
 */
export class DebuggerSession {
  private stackShape: 'unknown' | 'resource' | 'dispatcher' = 'unknown';

  constructor(
    private readonly http: AdtHttpClient,
    readonly identity: DebugIdentity,
    private options: AdtRequestOptions = {},
  ) {}

  /**
   * Later requests end by `deadline`, or once `signal` aborts — each move of an interactive session
   * brings its own.
   */
  retime(deadline: number, signal?: AbortSignal): void {
    const { signal: _previous, ...rest } = this.options;
    this.options = { ...rest, deadline, ...(signal ? { signal } : {}) };
  }

  async attach(debuggeeId: string): Promise<DebugAttachInfo> {
    const query = new URLSearchParams({
      method: 'attach',
      debuggeeId,
      dynproDebugging: 'true',
      debuggingMode: 'user',
      requestUser: this.identity.user,
    }).toString();
    const resp = await this.http.post(
      `${DEBUGGER_PATH}?${query}`,
      undefined,
      undefined,
      { Accept: '*/*' },
      this.options,
    );
    return parseAttachResponse(resp.body);
  }

  /**
   * The call stack. Newer releases serve `/debugger/stack`; 7.50 has no such resource (404) and
   * answers the same `getStack` on the dispatcher. The working shape is remembered per session.
   */
  async stack(): Promise<DebugStackFrame[]> {
    if (this.stackShape !== 'dispatcher') {
      try {
        const resp = await this.http.get(
          `${DEBUGGER_PATH}/stack?${STACK_QUERY}`,
          { Accept: '*/*' },
          { ...this.options, suppressNotFoundLog: true },
        );
        this.stackShape = 'resource';
        return parseStackResponse(resp.body);
      } catch (err) {
        // A 404 after the resource already answered on this session is news about the session.
        if (!(err instanceof AdtApiError && err.statusCode === 404) || this.stackShape === 'resource') throw err;
      }
    }
    const resp = await this.http.post(
      `${DEBUGGER_PATH}?${STACK_QUERY}`,
      undefined,
      undefined,
      { Accept: '*/*' },
      this.options,
    );
    this.stackShape = 'dispatcher';
    return parseStackResponse(resp.body);
  }

  /** Read variables by expression (`LV_X`, `LS_S-COMP`, `LT_T[2]`, `ME->MV_A`, `SY-SUBRC`). */
  async variables(ids: readonly string[]): Promise<DebugVariable[]> {
    if (ids.length === 0) return [];
    const resp = await this.http.post(
      `${DEBUGGER_PATH}?method=getVariables`,
      buildVariablesXml(ids),
      VARIABLES_CONTENT_TYPE,
      { Accept: AS_XML },
      this.options,
    );
    return parseVariablesResponse(resp.body);
  }

  /** Children of one or more nodes of the variable tree (`@ROOT` → scopes, a structure → components). */
  async childVariables(
    parents: readonly string[],
  ): Promise<{ hierarchies: DebugVariableHierarchy[]; variables: DebugVariable[] }> {
    if (parents.length === 0) return { hierarchies: [], variables: [] };
    const resp = await this.http.post(
      `${DEBUGGER_PATH}?method=getChildVariables`,
      buildChildVariablesXml(parents),
      CHILD_VARIABLES_CONTENT_TYPE,
      { Accept: AS_XML },
      this.options,
    );
    return parseChildVariablesResponse(resp.body);
  }

  /**
   * One debugger step. A debuggee that finished (or is gone) reports `ended`, never throws.
   * `stepRunToLine` takes the target line as `uri` (`…/source/main#start=12`), as abap-adt-api,
   * vscode_abap_remote_fs and vibing-steampunk send it.
   */
  async step(method: DebugStepMethod, uri?: string): Promise<DebugStepResult> {
    const query = new URLSearchParams({ method, ...(uri ? { uri } : {}) }).toString();
    try {
      const resp = await this.http.post(
        `${DEBUGGER_PATH}?${query}`,
        undefined,
        undefined,
        { Accept: '*/*' },
        this.options,
      );
      const exception = parseDebuggerException(resp.body);
      if (exception && isEndedSubType(exception.subType)) return { status: 'ended', reason: exception.subType ?? '' };
      const node = asNode(parseDocument(resp.body).step) ?? {};
      const stepping = attr(node, 'isSteppingPossible');
      const reached = parseReachedBreakpoints(node).filter((bp) => bp.id);
      const unresolvable = reached.filter((bp) => bp.unresolvableCondition);
      return {
        status: 'stopped',
        steppingPossible: stepping === '' ? true : flag(stepping),
        reachedBreakpoints: reached.map((bp) => bp.id),
        ...(unresolvable.length > 0 ? { unresolvableConditions: unresolvable } : {}),
      };
    } catch (err) {
      const subType = debuggerErrorSubType(err);
      if (isEndedSubType(subType)) return { status: 'ended', reason: subType ?? '' };
      throw err;
    }
  }

  /**
   * Stop this run from stopping at one breakpoint again: delete its session copy (the external one
   * is gone since the attach), as vscode_abap_remote_fs does for an attached thread.
   */
  async removeBreakpoint(id: string): Promise<void> {
    await deleteBreakpoint(this.http, this.identity, id, 'debugger', this.options);
  }

  /**
   * Replace the breakpoints of this attached run (`scope=debugger`) with `specs`. What is set here
   * stops this run only — never another request of the same SAP user, this server's own included.
   */
  async syncRunBreakpoints(specs: readonly DebugBreakpointSpec[]): Promise<DebugBreakpointState[]> {
    return syncBreakpoints(this.http, this.identity, specs, 'debugger', this.options);
  }

  /**
   * Watch `variableName` in this run: it stops wherever the variable changes — and `condition`, if
   * given, holds. The variable must be visible where the run stands. abap-adt-api's contract
   * (`debuggerCreateWatchpoint`); no request lists a run's watchpoints.
   */
  async createWatchpoint(variableName: string, condition = ''): Promise<DebugWatchpoint[]> {
    const query = new URLSearchParams({ variableName, condition, active: 'true' }).toString();
    const resp = await this.http.post(
      `${WATCHPOINTS_PATH}?${query}`,
      undefined,
      undefined,
      { Accept: 'application/xml' },
      this.options,
    );
    return parseWatchpoints(resp.body);
  }

  async deleteWatchpoint(id: string): Promise<void> {
    await this.http.delete(`${WATCHPOINTS_PATH}/${encodeURIComponent(id)}`, { Accept: '*/*' }, this.options);
  }

  /**
   * Let the debuggee run on: drop its watchpoints and the session copies of the capture's breakpoints,
   * then `stepContinue` until SAP reports the debuggee ended. `method=detach` is unknown on 7.58, so
   * continue is the release; `terminateDebuggee` (aborts the caller's request) is the last resort only.
   */
  async release(
    breakpointIds: readonly string[],
    watchpointIds: readonly string[] = [],
    maxContinues = 3,
  ): Promise<DebugReleaseResult> {
    for (const id of watchpointIds) {
      try {
        await this.deleteWatchpoint(id);
      } catch {
        // best-effort: one already gone (its hits spent) answers an error; a live one costs a continue
      }
    }
    try {
      await syncBreakpoints(this.http, this.identity, [], 'debugger', this.options);
    } catch {
      for (const id of breakpointIds) {
        try {
          await deleteBreakpoint(this.http, this.identity, id, 'debugger', this.options);
        } catch {
          // best-effort: a stale session copy can only cost one extra continue below
        }
      }
    }
    let lastFailure = 'the debuggee kept stopping';
    for (let attempt = 0; attempt < maxContinues; attempt++) {
      try {
        const outcome = await this.step('stepContinue');
        if (outcome.status === 'ended') return { released: true, via: 'continue' };
      } catch (err) {
        lastFailure = `stepContinue failed: ${debuggerErrorText(err)}`;
        break;
      }
    }
    try {
      await this.step('terminateDebuggee');
      return { released: true, via: 'terminate', detail: lastFailure };
    } catch (err) {
      return {
        released: false,
        via: 'none',
        detail: `${lastFailure}; terminateDebuggee failed: ${debuggerErrorText(err)}`,
      };
    }
  }
}

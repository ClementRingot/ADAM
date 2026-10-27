/**
 * A fake SAP for the debugger tests: answers the mocked undici fetch like an ADT system with one
 * class (ZCL_ORDER), its unit tests and a program whose run the options shape. The SAP answers are
 * REFERENCE-DERIVED (abap-adt-api / vibing-steampunk shapes, see docs/adt-debugger-protocol.md),
 * not live captures.
 */
import type { Mock } from 'vitest';
import { AdtHttpClient, type AdtHttpConfig } from '../../src/adt/http.js';
import type { SapConnection } from '../../src/tools/connection.js';
import { mockResponse } from './mock-fetch.js';

/** Basic authentication as SAP_USER=admin, who is then the logon user (`null`: no logon user is known). */
export function createConnection(
  overrides: Partial<AdtHttpConfig> = {},
  logonUser: string | null = 'admin',
): SapConnection {
  return {
    http: new AdtHttpClient({ baseUrl: 'http://sap:8000', username: 'admin', password: 'secret', ...overrides }),
    ...(logonUser ? { logonUser } : {}),
  };
}

export const CLASS_SOURCE = [
  'CLASS zcl_order DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    METHODS get_total RETURNING VALUE(rv_total) TYPE i.',
  'ENDCLASS.',
  '',
  'CLASS zcl_order IMPLEMENTATION.',
  '  METHOD get_total.',
  '    DATA lv_total TYPE i.',
  '    lv_total = 42.',
  '    rv_total = lv_total.',
  '  ENDMETHOD.',
  '',
  '  METHOD describe.',
  '* full-line comment',
  '',
  '    " indented comment',
  '    rv_text = |{ get_total( ) }|.',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

export const DEBUGGEE_XML = `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><STPDA_DEBUGGEE><CLIENT>001</CLIENT><DEBUGGEE_ID>DBGEE_42</DEBUGGEE_ID><DEBUGGEE_USER>ADMIN</DEBUGGEE_USER><PRG_CURR>ZCL_ORDER=====================CP</PRG_CURR><INCL_CURR>ZCL_ORDER=====================CM001</INCL_CURR><LINE_CURR>3</LINE_CURR><DBGEE_KIND>DEBUGGEE</DBGEE_KIND><IS_ATTACH_IMPOSSIBLE>false</IS_ATTACH_IMPOSSIBLE></STPDA_DEBUGGEE></DATA></asx:values></asx:abap>`;

export const AUNIT_PASSED = `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"><program name="ZCL_ORDER"><testClasses><testClass name="LTCL_ORDER" riskLevel="harmless"><testMethods><testMethod name="TOTAL" executionTime="0.1"/></testMethods></testClass></testClasses></program></aunit:runResult>`;

export const ENDED = `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework"><type id="ExceptionResourceFailure"/><message lang="EN">Debuggee ended</message><properties><entry key="com.sap.adt.communicationFramework.subType">debuggeeEnded</entry></properties></exc:exception>`;

export const MAIN = '/sap/bc/adt/oo/classes/zcl_order/source/main';
/** The statement kinds the fake SAP offers for statement breakpoints. */
export const KNOWN_STATEMENTS = ['CALL FUNCTION', 'COMMIT WORK', 'MESSAGE'];
export const REPORT = '/sap/bc/adt/programs/programs/zreport/source/main';

/** A source position the fake program passes: the source path and its line. */
export interface Position {
  path: string;
  line: number;
  /** What the statement at this position does, for event breakpoints: `exception:CX_…`,
   *  `message:<class>:<number>:<type>`, `statement:<kind>`. */
  event?: string;
}

/** `withUri: false` — SAP leaves the frame's uri out, so only reachedBreakpoints can name the stop.
 *  `inHelper`: the line belongs to HELPER, a method GET_TOTAL calls — one frame deeper. The `line`
 *  attribute counts within the method include on purpose: the capture must number positions by the uri. */
export function stackXml(at: Position, withUri = true, inHelper = false): string {
  const uri = (column: number) => (withUri ? ` uri="${at.path}#start=${at.line},${column}"` : '');
  const helper = inHelper
    ? `<stackEntry stackPosition="3" programName="ZCL_ORDER=====================CP" includeName="ZCL_ORDER=====================CM002" line="${at.line - 6}" eventType="METHOD" eventName="HELPER" systemProgram="false"${uri(4)}/>`
    : '';
  const top =
    at.path === MAIN
      ? `<stackEntry stackPosition="2" programName="ZCL_ORDER=====================CP" includeName="ZCL_ORDER=====================CM001" line="${inHelper ? 3 : at.line - 6}" eventType="METHOD" eventName="GET_TOTAL" systemProgram="false"${inHelper ? '' : uri(4)}/>`
      : `<stackEntry stackPosition="2" programName="ZREPORT" includeName="ZREPORT" line="${at.line}" eventType="EVENT" eventName="START-OF-SELECTION" systemProgram="false"${uri(1)}/>`;
  return `<?xml version="1.0" encoding="utf-8"?><dbg:stack xmlns:dbg="http://www.sap.com/adt/debugger">${helper}${top}<stackEntry stackPosition="1" programName="SAPLSAUNIT_TEST_RUNNER" includeName="LSAUNIT_TEST_RUNNERU01" line="7" eventType="FUNCTION" eventName="SAUNIT_RUN" systemProgram="true"/></dbg:stack>`;
}

/** SAP's breakpoint id for a position: location-derived, so the external breakpoint and its session copy share it. */
export const breakpointId = (path: string, line: number) =>
  path === MAIN ? `BP-L${line}` : `BP-${path.split('/').at(-3)?.toUpperCase()}-L${line}`;
export const positionKey = (path: string, line: number) => `${path}#${line}`;

export function variable(id: string, metaType: string, value = '', extra = ''): string {
  return `<STPDA_ADT_VARIABLE><ID>${id}</ID><NAME>${id.replace(/^.*[-]/, '')}</NAME><DECLARED_TYPE_NAME>T_${metaType.toUpperCase()}</DECLARED_TYPE_NAME><META_TYPE>${metaType}</META_TYPE><VALUE>${value}</VALUE>${extra}</STPDA_ADT_VARIABLE>`;
}

export const asx = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${inner}</DATA></asx:values></asx:abap>`;
export const hierarchy = (parent: string, child: string, name = child) =>
  `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${parent}</PARENT_ID><CHILD_ID>${child}</CHILD_ID><CHILD_NAME>${name}</CHILD_NAME></STPDA_ADT_VARIABLE_HIERARCHY>`;

export const VARIABLES: Record<string, string> = {
  LV_TOTAL: variable('LV_TOTAL', 'simple', '42'),
  LV_HELPER: variable('LV_HELPER', 'simple', '7'),
  // CONV string( 124 ): the sign position is a trailing blank, and in a string it counts.
  LV_TEXT: variable('LV_TEXT', 'string', '124 '),
  LV_CHAR: variable('LV_CHAR', 'simple', 'ABC   '),
  LS_HEAD: variable('LS_HEAD', 'structure'),
  LT_ITEMS: variable('LT_ITEMS', 'table', '', '<TABLE_LINES>2</TABLE_LINES>'),
  'LT_ITEMS[1]': variable('LT_ITEMS[1]', 'structure'),
  'LT_ITEMS[2]': variable('LT_ITEMS[2]', 'structure'),
  'LT_ITEMS[3]': variable('LT_ITEMS[3]', 'structure'),
};
export const CHILDREN: Record<string, string[]> = {
  '@LOCALS': ['LV_TOTAL', 'LS_HEAD', 'LT_ITEMS'],
  LS_HEAD: ['LS_HEAD-VBELN', 'LS_HEAD-KUNNR'],
  'LT_ITEMS[1]': ['LT_ITEMS[1]-POSNR'],
  'LT_ITEMS[2]': ['LT_ITEMS[2]-POSNR'],
  'LT_ITEMS[3]': ['LT_ITEMS[3]-POSNR'],
};
export const LEAF_VALUES: Record<string, string> = {
  'LS_HEAD-VBELN': '0000004711',
  'LS_HEAD-KUNNR': 'CUST01',
  'LT_ITEMS[1]-POSNR': '000010',
  'LT_ITEMS[2]-POSNR': '000020',
  'LT_ITEMS[3]-POSNR': '000030',
};

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  stateful: boolean;
  /** `X-sap-adt-sessiontype` as sent (stateful / stateless / undefined). */
  sessionType?: string;
  /** Multi-server fake: the application server the request's session is pinned to. */
  server?: string;
}

export interface FakeSapOptions {
  /** The listener catches the debuggee (otherwise it waits until aborted, or times out at once). */
  hit?: boolean;
  /** With hit=false: answer the long poll with an empty body immediately (server timeout). */
  listenerTimesOut?: boolean;
  /** Breakpoint lines below this are refused ("no statement"). */
  acceptLinesFrom?: number;
  conflict?: boolean;
  /** SAP refuses breakpoints (the user lacks debug authorization). */
  breakpointsForbidden?: boolean;
  /** The attached run's own breakpoint sync answers with an empty document instead of echoing them. */
  runSyncSilent?: boolean;
  /** systeminformation names this session user; unset = the resource is absent (404, SAP_BASIS <= 7.50). */
  sessionUser?: string;
  /** Multi-server system: each new stateful session lands on the next of these (named in sap-contextid);
   *  while a debuggee waits, new sessions avoid its server — SAP's balancer prefers the least-loaded one. */
  servers?: string[];
  /** With servers: where a run the capture did not pin stops (INSTANCE_NAME) — a stateless trigger or the user's
   *  own run. An attach from any other server is refused and spoils the debuggee for every later one. */
  debuggeeServer?: string;
  /** trigger="none": the user's own run reaches the breakpoint. */
  runByUser?: boolean;
  /** SAP flags the stopped debuggee IS_ATTACH_IMPOSSIBLE. */
  attachImpossible?: boolean;
  /** The OData service refuses the trigger (BTP ABAP: UCON blocks an unexposed custom service). */
  odataBlocked?: boolean;
  /** The positions the run passes, in order (a loop repeats one). It stops at the first one with an armed
   *  breakpoint; `stepContinue` runs on to the next one with a session breakpoint, or to the end. Unset: the
   *  run stops once at line 9 of ZCL_ORDER and `stepContinue` ends it. */
  execution?: Position[];
  /** attach / step / stepContinue answers name the breakpoint reached (reachedBreakpoints). */
  namesBreakpoints?: boolean;
  /** Stack frames carry no uri. */
  stackWithoutUri?: boolean;
  /** The lines successive steps land on (a loop goes back); past its end a step moves one line on. */
  stepPath?: number[];
  /** Lines of HELPER, a method GET_TOTAL calls: the stack is one frame deeper there. */
  helperLines?: number[];
  /** Variables that exist only on these lines (declared in the frame the run is in there). */
  visibleOn?: Record<string, number[]>;
  /** Expressions SAP refuses: a getVariables batch carrying one fails as a whole. */
  failingVariables?: string[];
  /** From this line on, LT_ITEMS has a third row (an APPEND ran). */
  appendAtLine?: number;
  /** The attach lands in a post-mortem (short dump) session: no stepping. */
  postMortem?: boolean;
  /** stepRunToLine: the program ends before the target line. */
  runToLineEnds?: boolean;
  /** The program finishes at the step after this many (a step then answers "debuggee ended"). */
  endsAfterSteps?: number;
}

export const cannotAttach = (line: number) =>
  ENDED.replace('debuggeeEnded', 'invalidDebuggee')
    .replace('Debuggee ended', 'An exception was raised')
    .replace(
      '</properties>',
      `<entry key="previous2SourcePositionProgram">CL_ABDBG_ACT_FOR_ATTACH__USER=CP</entry><entry key="previous2SourcePositionSourceLine">${line} </entry><entry key="previous2ExceptionClassName">CX_ABDBG_ACTEXT_CANNOT_ATTACH</entry></properties>`,
    );

export function installFakeSap(mockFetch: Mock, options: FakeSapOptions = {}) {
  const calls: Call[] = [];
  /** Where the debuggee stands; steps move it a line on (or along `stepPath`). */
  let position: Position = { path: MAIN, line: 9 };
  let cursor = 0;
  let stepCursor = 0;
  /** Armed breakpoints by position → id: the user's external ones, and the attached run's own copies. */
  const external = new Map<string, string>();
  let sessionBreakpoints = new Map<string, string>();
  /** Their conditions by position, kept with the breakpoints as SAP keeps them. */
  let externalConditions = new Map<string, string>();
  let sessionConditions = new Map<string, string>();
  /** How many times the run has reached the position of execution step `index`, up to and including it. */
  const passOf = (index: number): number => {
    const at = options.execution?.[index];
    if (!at) return 1;
    return (options.execution ?? []).slice(0, index + 1).filter((p) => p.path === at.path && p.line === at.line).length;
  };
  /** The fake's condition language: `LV_PASS = n` or `LV_PASS > n`; SAP cannot evaluate anything else. */
  const evaluate = (condition: string, pass: number): boolean | 'unresolvable' => {
    const match = /^LV_PASS\s*(=|>)\s*(\d+)$/i.exec(condition.trim());
    if (!match) return 'unresolvable';
    return match[1] === '=' ? pass === Number(match[2]) : pass > Number(match[2]);
  };
  /** Does the run stop at execution step `index`: an armed position whose condition holds (or cannot be evaluated)? */
  const stopsAt = (index: number, armed: Map<string, string>, conditions: Map<string, string>): boolean => {
    const at = options.execution?.[index] as Position;
    const key = positionKey(at.path, at.line);
    const condition = conditions.get(key);
    const byLine = armed.has(key) && (condition === undefined || evaluate(condition, passOf(index)) !== false);
    return byLine || eventIds(at, armed).length > 0;
  };
  /** The ids of the armed event breakpoints the statement at `at` triggers (a message of any type included). */
  function eventIds(at: Position | undefined, armed: Map<string, string>): string[] {
    if (!at?.event) return [];
    const keys = [`event:${at.event}`];
    if (at.event.startsWith('message:')) keys.push(`event:${at.event.replace(/:[^:]*$/, ':')}`);
    return keys.flatMap((key) => (armed.has(key) ? [armed.get(key) as string] : []));
  }
  let released: () => void = () => {};
  const releasedPromise = new Promise<void>((resolve) => {
    released = resolve;
  });
  let triggered: () => void = () => {};
  const triggeredPromise = new Promise<void>((resolve) => {
    triggered = resolve;
  });
  let sessionsOpened = 0;
  /** terminateDebuggee aborted the program. */
  let terminated = false;
  let stepsTaken = 0;
  let spoiled = false;
  /** Multi-server: the server the debuggee waits on, from its stop to its release. */
  let stoppedOn: string | undefined;
  const debuggeeXml = () => {
    let xml = options.attachImpossible
      ? DEBUGGEE_XML.replace('<IS_ATTACH_IMPOSSIBLE>false', '<IS_ATTACH_IMPOSSIBLE>X')
      : DEBUGGEE_XML;
    // As on the BTP ABAP Environment: LINE_CURR counts within INCL_CURR, the URI like abap_source.
    if (!options.stackWithoutUri) {
      xml = xml.replace('</STPDA_DEBUGGEE>', `<URI>${position.path}#start=${position.line},0</URI></STPDA_DEBUGGEE>`);
    }
    return stoppedOn
      ? xml.replace('</STPDA_DEBUGGEE>', `<INSTANCE_NAME>${stoppedOn}</INSTANCE_NAME></STPDA_DEBUGGEE>`)
      : xml;
  };

  mockFetch.mockReset();
  mockFetch.mockImplementation(
    async (
      url: string | URL,
      init?: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
    ) => {
      const parsed = new URL(String(url));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      const headers = init?.headers ?? {};
      const sessionType = headers['X-sap-adt-sessiontype'];
      const context = /sap-contextid=SID%3aANON%3a([^%;]+)%3a/.exec(headers.Cookie ?? '')?.[1];
      // A stateful request without a context opens a session on the next server (load balancing).
      const unloaded = options.servers?.filter((server) => server !== stoppedOn);
      const balanced = unloaded?.length ? unloaded : options.servers;
      const opened =
        balanced && sessionType === 'stateful' && !context ? balanced[sessionsOpened++ % balanced.length] : undefined;
      const call: Call = {
        method,
        path: parsed.pathname,
        query: parsed.searchParams,
        body,
        stateful: sessionType === 'stateful',
        ...(sessionType ? { sessionType } : {}),
        ...((context ?? opened) ? { server: context ?? opened } : {}),
      };
      calls.push(call);
      const response = await answer(call, method, body, init);
      if (opened)
        response.headers.append(
          'set-cookie',
          `sap-contextid=SID%3aANON%3a${opened}%3aCTX${sessionsOpened}-NEW; path=/`,
        );
      return response;
    },
  );

  async function answer(call: Call, method: string, body: string, init?: { signal?: AbortSignal }): Promise<Response> {
    const parsed = new URL(`http://sap${call.path}?${call.query.toString()}`);
    const path = parsed.pathname.toLowerCase();
    const q = parsed.searchParams;

    if (method === 'HEAD' && path === '/sap/bc/adt/core/discovery')
      return mockResponse(200, '', { 'x-csrf-token': 'T' });
    // Eclipse's close-session request (AdtHttpClient.endStatefulSession), sent on the context it closes.
    if (method === 'GET' && path === '/sap/bc/adt/core/http/sessions') return mockResponse(200, '');
    if (method === 'GET' && path === '/sap/bc/adt/core/http/systeminformation' && options.sessionUser)
      return mockResponse(
        200,
        JSON.stringify({ systemID: 'A4H', client: '001', userName: options.sessionUser, language: 'EN' }),
      );
    if (method === 'GET' && path === '/sap/bc/adt/oo/classes/zcl_order/source/main')
      return mockResponse(200, CLASS_SOURCE);
    if (path === '/sap/bc/adt/debugger/listeners') {
      if (method === 'GET') {
        return options.conflict
          ? mockResponse(
              409,
              ENDED.replace('debuggeeEnded', 'conflictDetected').replace(
                '</properties>',
                '<entry key="conflictText">ADMIN is debugged in Eclipse</entry></properties>',
              ),
            )
          : mockResponse(200, '');
      }
      if (method === 'DELETE') return mockResponse(200, '');
      // POST: the long poll.
      if (options.hit) {
        if (options.runByUser) stoppedOn = options.servers ? options.debuggeeServer : undefined;
        else await triggeredPromise;
        if (options.execution) {
          cursor = options.execution.findIndex((_, index) => stopsAt(index, external, externalConditions));
          position = { ...(options.execution[cursor] as Position) };
        }
        return mockResponse(200, debuggeeXml());
      }
      if (options.listenerTimesOut) return mockResponse(200, '');
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
    }
    if (path === '/sap/bc/adt/debugger/breakpoints' && method === 'POST') {
      if (options.breakpointsForbidden) {
        return mockResponse(
          403,
          ENDED.replace('debuggeeEnded', 'notAuthorized').replace('Debuggee ended', 'No authorization to debug'),
        );
      }
      // A full sync replaces the scope's set: the user's external breakpoints, or the attached run's copies.
      const armed = new Map<string, string>();
      const conditions = new Map<string, string>();
      const items = [
        ...body.matchAll(
          /kind="line" clientId="([^"]+)" skipCount="0" adtcore:uri="([^"#]+)#start=(\d+)"(?: condition="([^"]*)")?/g,
        ),
      ].map((m) => {
        const [, clientId, path = '', text, rawCondition] = m;
        const line = Number(text);
        const condition = rawCondition
          ?.replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
        if (line < (options.acceptLinesFrom ?? 1))
          return `<breakpoint kind="line" clientId="${clientId}" errorMessage="Cannot create a breakpoint at this position"/>`;
        if (condition?.includes('INVALID'))
          return `<breakpoint kind="line" clientId="${clientId}" errorMessage="Condition is not valid"/>`;
        armed.set(positionKey(path, line), breakpointId(path, line));
        if (condition !== undefined) conditions.set(positionKey(path, line), condition);
        return `<breakpoint kind="line" clientId="${clientId}" id="${breakpointId(path, line)}" adtcore:uri="${path}#start=${line}"${rawCondition !== undefined ? ` condition="${rawCondition}"` : ''}/>`;
      });
      // Event breakpoints: armed under an `event:` key next to the line positions.
      for (const [, clientId, exceptionClass] of body.matchAll(
        /kind="exception" clientId="([^"]+)" skipCount="0" exceptionClass="([^"]+)"/g,
      )) {
        armed.set(`event:exception:${exceptionClass}`, `BP-EXC-${exceptionClass}`);
        items.push(
          `<breakpoint kind="exception" clientId="${clientId}" id="BP-EXC-${exceptionClass}" exceptionClass="${exceptionClass}"/>`,
        );
      }
      for (const [, clientId, msgId, msgNo, msgTy] of body.matchAll(
        /kind="message" clientId="([^"]+)" skipCount="0" msgId="([^"]*)" msgNo="([^"]*)" msgTy="([^"]*)"/g,
      )) {
        armed.set(`event:message:${msgId}:${msgNo}:${msgTy}`, `BP-MSG-${msgId}-${msgNo}`);
        items.push(
          `<breakpoint kind="message" clientId="${clientId}" id="BP-MSG-${msgId}-${msgNo}" msgId="${msgId}" msgNo="${msgNo}" msgTy="${msgTy}"/>`,
        );
      }
      for (const [, clientId, statement = ''] of body.matchAll(
        /kind="statement" clientId="([^"]+)" skipCount="0" statement="([^"]*)"/g,
      )) {
        if (!KNOWN_STATEMENTS.includes(statement)) {
          items.push(
            `<breakpoint kind="statement" clientId="${clientId}" errorMessage="Statement ${statement} is not supported"/>`,
          );
          continue;
        }
        const id = `BP-STMT-${statement.replace(/ /g, '_')}`;
        armed.set(`event:statement:${statement}`, id);
        items.push(`<breakpoint kind="statement" clientId="${clientId}" id="${id}" statement="${statement}"/>`);
      }
      if (body.includes('scope="debugger"')) {
        sessionBreakpoints = armed;
        sessionConditions = conditions;
        if (options.runSyncSilent || items.length === 0) {
          return mockResponse(200, '<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger"/>');
        }
        return mockResponse(
          200,
          `<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core">${items.join('')}</dbg:breakpoints>`,
        );
      }
      external.clear();
      for (const [key, id] of armed) external.set(key, id);
      externalConditions = conditions;
      return mockResponse(
        200,
        `<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core">${items.join('')}</dbg:breakpoints>`,
      );
    }
    if (path === '/sap/bc/adt/debugger/breakpoints/statements' && method === 'GET') {
      const rows = KNOWN_STATEMENTS.map((name) => `<statement name="${name}" description="${name}" group="ABAP"/>`);
      return mockResponse(
        200,
        `<dbg:statements xmlns:dbg="http://www.sap.com/adt/debugger">${rows.join('')}</dbg:statements>`,
      );
    }
    if (path.startsWith('/sap/bc/adt/debugger/breakpoints/') && method === 'DELETE') {
      const id = decodeURIComponent(call.path.split('/').at(-1) ?? '');
      const scope = q.get('scope') === 'debugger' ? sessionBreakpoints : external;
      for (const [key, value] of scope) if (value === id) scope.delete(key);
      return mockResponse(200, '');
    }
    if (path === '/sap/bc/adt/abapunit/testruns') {
      if (options.hit && options.servers) stoppedOn = call.server ?? options.debuggeeServer;
      triggered();
      if (options.hit) await releasedPromise;
      return mockResponse(200, AUNIT_PASSED);
    }
    if (path === '/sap/bc/adt/debugger/stack') {
      const inHelper = position.path === MAIN && (options.helperLines ?? []).includes(position.line);
      return mockResponse(200, stackXml(position, !options.stackWithoutUri, inHelper));
    }
    if (path === '/sap/bc/adt/debugger') {
      switch (q.get('method')) {
        case 'attach':
          if (stoppedOn && (spoiled || call.server !== stoppedOn)) {
            const line = spoiled ? 9 : 24;
            spoiled = true;
            released(); // SAP lets the unattached debuggee run on once its wait times out
            return mockResponse(500, cannotAttach(line));
          }
          // The attached run gets its own copies of the breakpoints armed when it stopped.
          sessionBreakpoints = new Map(external);
          sessionConditions = new Map(externalConditions);
          return mockResponse(
            200,
            options.postMortem
              ? '<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="false" isPostMortem="true"/>'
              : `<dbg:attach xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true">${reached()}</dbg:attach>`,
          );
        case 'stepOver':
        case 'stepInto':
        case 'stepReturn':
          if (options.endsAfterSteps !== undefined && stepsTaken++ >= options.endsAfterSteps) {
            released();
            stoppedOn = undefined;
            return mockResponse(400, ENDED);
          }
          position = { ...position, line: options.stepPath?.[stepCursor++] ?? position.line + 1 };
          // A step that lands on one of the run's breakpoints stops there as at a breakpoint.
          return mockResponse(
            200,
            `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true">${reached(true)}</dbg:step>`,
          );
        case 'stepRunToLine': {
          // The run goes on to the target line (`uri` = its source and line), unless the program ends first.
          const [path = '', fragment = ''] = (q.get('uri') ?? '').split('#');
          const line = Number(/start=(\d+)/.exec(fragment)?.[1]);
          if (options.runToLineEnds) {
            released();
            stoppedOn = undefined;
            return mockResponse(400, ENDED);
          }
          position = { path, line };
          return mockResponse(
            200,
            `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true">${reached(true)}</dbg:step>`,
          );
        }
        case 'terminateDebuggee':
          terminated = true;
          released();
          stoppedOn = undefined;
          return mockResponse(200, '<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger"/>');
        case 'stepContinue':
          for (cursor++; options.execution && cursor < options.execution.length; cursor++) {
            const next = options.execution[cursor] as Position;
            if (stopsAt(cursor, sessionBreakpoints, sessionConditions)) {
              position = { ...next };
              return mockResponse(
                200,
                `<dbg:step xmlns:dbg="http://www.sap.com/adt/debugger" isSteppingPossible="true">${reached()}</dbg:step>`,
              );
            }
          }
          released();
          stoppedOn = undefined;
          return mockResponse(400, ENDED);
        case 'getChildVariables': {
          const parents = [...body.matchAll(/<PARENT_ID>([^<]+)<\/PARENT_ID>/g)].map((m) => m[1] as string);
          if (parents.includes('@ROOT'))
            return mockResponse(
              200,
              asx(`<HIERARCHIES>${hierarchy('@ROOT', '@LOCALS', 'Locals')}</HIERARCHIES><VARIABLES/>`),
            );
          const rows = parents.flatMap((parent) => (CHILDREN[parent] ?? []).map((child) => hierarchy(parent, child)));
          const vars = parents.flatMap((parent) =>
            (CHILDREN[parent] ?? []).map(
              (child) => VARIABLES[child] ?? variable(child, 'simple', LEAF_VALUES[child] ?? ''),
            ),
          );
          return mockResponse(
            200,
            asx(`<HIERARCHIES>${rows.join('')}</HIERARCHIES><VARIABLES>${vars.join('')}</VARIABLES>`),
          );
        }
        case 'getVariables': {
          const ids = [...body.matchAll(/<ID>([^<]+)<\/ID>/g)].map((m) => (m[1] as string).replace('ME-&gt;', 'ME->'));
          if (ids.some((id) => options.failingVariables?.includes(id))) {
            return mockResponse(
              500,
              ENDED.replace('debuggeeEnded', 'variableError').replace('Debuggee ended', 'Expression is not valid here'),
            );
          }
          const visible = (id: string) => options.visibleOn?.[id]?.includes(position.line) ?? true;
          const appended = options.appendAtLine !== undefined && position.line >= options.appendAtLine;
          const values = ids.flatMap((id) =>
            !visible(id)
              ? []
              : id === 'LV_PASS'
                ? [variable('LV_PASS', 'simple', String(passOf(cursor)))]
                : id === 'LV_TOTAL'
                  ? [variable('LV_TOTAL', 'simple', String(30 + position.line))]
                  : id === 'LT_ITEMS' && appended
                    ? [variable('LT_ITEMS', 'table', '', '<TABLE_LINES>3</TABLE_LINES>')]
                    : VARIABLES[id]
                      ? [VARIABLES[id]]
                      : [],
          );
          return mockResponse(200, asx(values.join('')));
        }
      }
    }
    if (path.startsWith('/sap/opu/odata4/') && options.odataBlocked) {
      return mockResponse(403, 'Application Server Error: The request has been blocked by UCON.');
    }
    if (path.startsWith('/sap/opu/odata4/')) {
      if (options.hit && options.servers) stoppedOn = call.server ?? options.debuggeeServer;
      triggered();
      return mockResponse(200, '{"value":[]}');
    }
    if (path === '/sap/bc/adt/repository/informationsystem/search') {
      return mockResponse(
        200,
        '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/ztc_order" adtcore:type="CLAS/OC" adtcore:name="ZTC_ORDER" adtcore:packageName="$TMP"/></adtcore:objectReferences>',
      );
    }
    return mockResponse(404, `unexpected ${method} ${parsed.pathname}${parsed.search}`);
  }

  /** `<reachedBreakpoints>` naming the session breakpoint at the current position, when SAP names it —
   *  always when SAP could not evaluate its condition. */
  function reached(afterStep = false): string {
    const key = positionKey(position.path, position.line);
    const id = sessionBreakpoints.get(key);
    const condition = sessionConditions.get(key);
    const unresolvable = condition !== undefined && evaluate(condition, passOf(cursor)) === 'unresolvable';
    // SAP always names an event breakpoint it stopped at (a step raises no event here).
    const events = afterStep ? [] : eventIds(options.execution?.[cursor], sessionBreakpoints);
    const entries = events.map((eventId) => `<breakpoint id="${eventId}" kind="event"/>`);
    if (id && (options.namesBreakpoints || unresolvable)) {
      const failure = unresolvable
        ? ` unresolvableCondition="${condition.replace(/"/g, '&quot;')}" unresolvableConditionErrorOffset="0"`
        : '';
      entries.push(`<breakpoint id="${id}" kind="line"${failure}/>`);
    }
    return entries.length > 0 ? `<reachedBreakpoints>${entries.join('')}</reachedBreakpoints>` : '';
  }
  return { calls, terminated: () => terminated };
}

export const named = (calls: Call[], method: string, path: string) =>
  calls.filter((call) => call.method === method && call.path.toLowerCase() === path.toLowerCase());

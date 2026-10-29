/**
 * abap_debug — one-shot capture orchestration, end to end through the MCP tool call over a real
 * AdtHttpClient and a fake SAP (mocked undici fetch).
 *
 * The SAP answers are REFERENCE-DERIVED (abap-adt-api / vibing-steampunk shapes, see
 * docs/adt-debugger-protocol.md), not live captures.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { callTool } from '../../../src/server.js';
import { setDebugTimingsForTests, setResultBudgetForTests } from '../../../src/tools/debug-capture.js';
import { DEFAULT_LIMITS } from '../../../src/tools/debug-limits.js';
import { resetDebuggingForTests } from '../../../src/tools/debug-registry.js';
import {
  type Call,
  createConnection,
  type FakeSapOptions,
  installFakeSap as installFakeSapOn,
  MAIN,
  named,
  REPORT,
} from '../../helpers/fake-sap.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

const installFakeSap = (options: FakeSapOptions = {}) => installFakeSapOn(mockFetch, options);

async function debug(args: Record<string, unknown>, conn = createConnection()) {
  const result = await callTool({ connection: conn, problems: [] }, 'abap_debug', args);
  const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result, text, json };
}

beforeAll(() => {
  setDebugTimingsForTests({ armDelayMs: 0, triggerSettleMs: 200 });
});

afterEach(async () => {
  await resetDebuggingForTests();
  mockFetch.mockReset();
});

describe('abap_debug — a hit', () => {
  it('stops in a method, returns stack + frame variables, then releases and cleans up', async () => {
    const { calls } = installFakeSap({ hit: true, acceptLinesFrom: 9 });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ method: 'get_total' }] });

    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({
      hit: true,
      user: 'ADMIN',
      attached: true,
      breakpoints: [
        { kind: 'line', status: 'set', line: 9, uri: '/sap/bc/adt/oo/classes/zcl_order/source/main#start=9', hits: 1 },
      ],
      stops: [
        {
          stop: 1,
          at: 'CLAS ZCL_ORDER method get_total',
          // Numbered like abap_source and the breakpoint — not within the method include.
          stoppedAt: { procedure: 'METHOD GET_TOTAL', line: 9, uri: `${MAIN}#start=9,4` },
          hiddenSystemFrames: 1,
        },
      ],
      release: { released: true, via: 'continue' },
      trigger: { kind: 'unittest', target: 'ABAP Unit CLAS ZCL_ORDER', status: 'completed' },
    });
    // The debuggee's position in the same numbering: its URI's line, not LINE_CURR (3, within the include).
    expect(json?.debuggee).toMatchObject({ program: 'ZCL_ORDER=====================CP', line: 9 });
    expect(json?.debuggee).not.toHaveProperty('includeLine');
    expect(json?.stops[0].stoppedAt).not.toHaveProperty('include');
    expect(json?.stops).toHaveLength(1);
    expect(json?.stops[0].stack).toHaveLength(1);
    expect(json?.stops[0].variables).toEqual([
      { name: 'LV_TOTAL', scope: 'Locals', type: 'T_SIMPLE', kind: 'simple', value: '42' },
      {
        name: 'LS_HEAD',
        scope: 'Locals',
        type: 'T_STRUCTURE',
        kind: 'structure',
        components: { VBELN: '0000004711', KUNNR: 'CUST01' },
      },
      { name: 'LT_ITEMS', scope: 'Locals', type: 'T_TABLE', kind: 'table', lines: 2 },
    ]);

    // Probe: METHOD (7) .. ENDMETHOD (11) in one POST; SAP refused 7-8; a second sync keeps only 9.
    const syncs = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints').filter((c) =>
      c.body.includes('scope="external"'),
    );
    expect(syncs).toHaveLength(2);
    expect([...syncs[0]!.body.matchAll(/dbg-0-line-(\d+)/g)].map((m) => m[1])).toEqual(['7', '8', '9', '10', '11']);
    expect([...syncs[1]!.body.matchAll(/dbg-0-line-(\d+)/g)].map((m) => m[1])).toEqual(['9']);
    expect(syncs[0]!.body).toContain('requestUser="ADMIN"');

    // Listener + breakpoints stateless; attach/stack/variables/release on one stateful session.
    const listen = named(calls, 'POST', '/sap/bc/adt/debugger/listeners')[0]!;
    expect(listen.stateful).toBe(false);
    expect(listen.query.get('requestUser')).toBe('ADMIN');
    expect(listen.query.get('timeout')).toBe('60');
    const sessionCalls = calls.filter(
      (c) => c.path.toLowerCase().startsWith('/sap/bc/adt/debugger') && c.query.get('method'),
    );
    expect(sessionCalls.length).toBeGreaterThan(0);
    expect(sessionCalls.every((c) => c.stateful)).toBe(true);
    expect(named(calls, 'GET', '/sap/bc/adt/debugger/stack')[0]?.stateful).toBe(true);
    // The read used the ACTIVE source.
    expect(named(calls, 'GET', '/sap/bc/adt/oo/classes/ZCL_ORDER/source/main')[0]?.query.get('version')).toBe('active');

    // Cleanup: the external breakpoint by id, then the listener by user only.
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/breakpoints/BP-L9')).toHaveLength(1);
    const stop = named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners');
    expect(stop).toHaveLength(1);
    expect(stop[0]!.query.get('requestUser')).toBe('ADMIN');
    expect(stop[0]!.query.has('ideId')).toBe(false);
  });

  it('reads named variables (table rows, unknown names) and records steps', async () => {
    installFakeSap({ hit: true });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      variables: ['lv_total', 'LT_ITEMS', 'LV_NOPE'],
      steps: 2,
    });
    expect(json?.hit).toBe(true);
    expect(json?.stops[0].variables).toEqual([
      { name: 'LV_TOTAL', type: 'T_SIMPLE', kind: 'simple', value: '39' },
      {
        name: 'LT_ITEMS',
        type: 'T_TABLE',
        kind: 'table',
        lines: 2,
        rows: [{ POSNR: '000010' }, { POSNR: '000020' }],
      },
      { name: 'LV_NOPE', kind: 'unknown', error: 'not visible in the stopped frame' },
    ]);
    // After a step too, a table shows its rows — `unchanged` when equal to the previous step's.
    expect(json?.stops[0].steps).toEqual([
      expect.objectContaining({
        step: 1,
        line: 10,
        values: { LV_TOTAL: '40', LT_ITEMS: { lines: 2, rows: [{ POSNR: '000010' }, { POSNR: '000020' }] } },
        notVisible: ['LV_NOPE'],
      }),
      expect.objectContaining({
        step: 2,
        line: 11,
        values: { LV_TOTAL: '41', LT_ITEMS: 'unchanged' },
        notVisible: ['LV_NOPE'],
      }),
    ]);
  });

  it('shows a table growing across steps', async () => {
    installFakeSap({ hit: true, appendAtLine: 11 });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, variables: ['LT_ITEMS'], steps: 3 });
    expect(json?.stops[0].steps.map((step: Record<string, any>) => step.values.LT_ITEMS)).toEqual([
      { lines: 2, rows: [{ POSNR: '000010' }, { POSNR: '000020' }] },
      { lines: 3, rows: [{ POSNR: '000010' }, { POSNR: '000020' }, { POSNR: '000030' }] },
      'unchanged',
    ]);
  });

  it('reads a variable once a step enters the method that declares it, and marks the frame moves', async () => {
    installFakeSap({ hit: true, helperLines: [10, 11], visibleOn: { LV_HELPER: [10, 11] } });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      variables: ['LV_TOTAL', 'LV_HELPER'],
      steps: 3,
      stepMode: 'into',
    });
    expect(json?.stops[0].variables[1]).toEqual({
      name: 'LV_HELPER',
      kind: 'unknown',
      error: 'not visible in the stopped frame',
    });
    expect(json?.stops[0].steps).toEqual([
      expect.objectContaining({
        step: 1,
        procedure: 'METHOD HELPER',
        frame: 'entered',
        values: { LV_TOTAL: '40', LV_HELPER: '7' },
      }),
      expect.objectContaining({ step: 2, procedure: 'METHOD HELPER', values: { LV_TOTAL: '41', LV_HELPER: '7' } }),
      expect.objectContaining({
        step: 3,
        procedure: 'METHOD GET_TOTAL',
        frame: 'returned',
        values: { LV_TOTAL: '42' },
        notVisible: ['LV_HELPER'],
      }),
    ]);
    expect(json?.stops[0].steps[1]).not.toHaveProperty('frame');
    // A same-named variable in the new frame is another variable: the result says so.
    expect(json?.warnings).toContainEqual(expect.stringContaining('a variable of the same name is a different'));
  });

  it('leaves an expression SAP refuses out of the later reads of the same frame', async () => {
    const { calls } = installFakeSap({ hit: true, failingVariables: ['LV_BAD'] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      variables: ['LV_TOTAL', 'LV_BAD'],
      steps: 3,
    });
    expect(json?.stops[0].variables).toEqual([
      expect.objectContaining({ name: 'LV_TOTAL', value: '39' }),
      { name: 'LV_BAD', kind: 'unknown', error: 'Expression is not valid here' },
    ]);
    expect(json?.stops[0].steps).toEqual(
      [40, 41, 42].map((total) =>
        expect.objectContaining({
          values: { LV_TOTAL: String(total) },
          errors: { LV_BAD: 'Expression is not valid here' },
        }),
      ),
    );
    // The stop: the failed batch, then one read per name; each step: one batch without the refused name.
    const reads = calls.filter((c) => c.query.get('method') === 'getVariables');
    expect(reads).toHaveLength(6);
    expect(reads.slice(3).every((c) => !c.body.includes('LV_BAD'))).toBe(true);
  });

  it('runs the unit tests and attaches on one server, both pinned before the stop (multi-server system)', async () => {
    const { calls } = installFakeSap({
      hit: true,
      sessionUser: 'ADMIN',
      servers: ['appserver-t4w2x', 'appserver-rpsxx'],
    });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, variables: ['LV_TOTAL'] });

    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({
      hit: true,
      attached: true,
      debuggee: { server: 'appserver-t4w2x' },
      stops: [{ variables: [{ name: 'LV_TOTAL', value: '39' }] }],
      release: { released: true, via: 'continue' },
      trigger: { status: 'completed', server: 'appserver-t4w2x' },
    });
    // Before the run, while the balancer still alternates: sessions until two share a server.
    const probes = calls.filter((c) => c.path === '/sap/bc/adt/core/http/systeminformation' && c.stateful);
    expect(probes.map((c) => c.server)).toEqual(['appserver-t4w2x', 'appserver-rpsxx', 'appserver-t4w2x']);
    // The unit tests run on the pair's second session, so the debuggee stops on its server ...
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns').map((c) => c.server)).toEqual(['appserver-t4w2x']);
    // ... where the first one waits: a single attach and the whole debugger session there, no probing after the stop.
    const session = calls.filter((c) => c.path.startsWith('/sap/bc/adt/debugger') && c.query.get('method'));
    expect(session.filter((c) => c.query.get('method') === 'attach')).toHaveLength(1);
    expect(session.every((c) => c.server === 'appserver-t4w2x')).toBe(true);
    // Every session the capture opened ends with Eclipse's close-session request on its own context: the unused
    // one, the debugger's after the release, the trigger's after its run.
    const closes = calls.filter((c) => c.sessionType === 'stateless');
    expect(closes.every((c) => c.method === 'GET' && c.path === '/sap/bc/adt/core/http/sessions')).toBe(true);
    expect(
      calls
        .filter((c) => c.sessionType === 'stateless')
        .map((c) => c.server)
        .sort(),
    ).toEqual(['appserver-rpsxx', 'appserver-t4w2x', 'appserver-t4w2x']);
  });

  it('opens its sessions before arming anything: armed breakpoints catch every request of the user', async () => {
    const { calls } = installFakeSap({
      hit: true,
      servers: ['appserver-t4w2x', 'appserver-rpsxx'],
      debuggeeServer: 'appserver-t4w2x',
    });
    await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    const firstArm = calls.findIndex((c) => c.method === 'POST' && c.path === '/sap/bc/adt/debugger/breakpoints');
    const trigger = calls.findIndex((c) => c.path === '/sap/bc/adt/abapunit/testruns');
    // Every session opened ahead of the run (before its trigger) was opened before the first breakpoint.
    const ahead = calls
      .map((c, index) => ({ c, index }))
      .filter(({ c, index }) => index < trigger && c.path === '/sap/bc/adt/core/http/systeminformation' && c.stateful);
    expect(ahead.length).toBeGreaterThan(0);
    expect(ahead.every(({ index }) => index < firstArm)).toBe(true);
  });

  it("attaches to the user's own run from the session already waiting on its server", async () => {
    const { calls } = installFakeSap({
      hit: true,
      runByUser: true,
      sessionUser: 'ADMIN',
      servers: ['appserver-t4w2x', 'appserver-rpsxx'],
      debuggeeServer: 'appserver-rpsxx',
    });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none' });

    expect(json).toMatchObject({
      hit: true,
      attached: true,
      debuggee: { server: 'appserver-rpsxx' },
      release: { released: true },
    });
    expect(calls.filter((c) => c.query.get('method') === 'attach').map((c) => c.server)).toEqual(['appserver-rpsxx']);
    // The sessions opened ahead covered both servers: nothing probed after the stop.
    expect(calls.filter((c) => c.path === '/sap/bc/adt/core/http/systeminformation' && c.stateful)).toHaveLength(3);
    // No data preview here (BTP-like), so no SAP GUI server either: the run stopped, so no warning about it.
    expect(json).not.toHaveProperty('warnings');
  });

  describe('a SAP GUI run on a system with several application servers (S/4HANA)', () => {
    // As seen live on S/4HANA: a SAP GUI run stops only on the server whose session armed the breakpoints last.
    const gui = {
      hit: true,
      runByUser: true,
      sessionUser: 'ADMIN',
      servers: ['appserver-t4w2x', 'appserver-rpsxx'],
      debuggeeServer: 'appserver-rpsxx',
      guiStopsOnlyWhereArmed: true,
    } satisfies FakeSapOptions;
    const externalSyncs = (calls: Call[]) => {
      const listening = calls.findIndex((c) => c.method === 'POST' && c.path === '/sap/bc/adt/debugger/listeners');
      return named(calls.slice(0, listening), 'POST', '/sap/bc/adt/debugger/breakpoints');
    };

    it("arms from the user's SAP GUI server last, so that run stops, and disarms from there", async () => {
      const fake = installFakeSap({
        ...gui,
        usr41: [
          { server: 'appserver-t4w2x', time: '080000' },
          { server: 'appserver-rpsxx', time: '093000' },
        ],
      });
      const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none' });

      expect(json).toMatchObject({
        hit: true,
        attached: true,
        debuggee: { server: 'appserver-rpsxx' },
        trigger: { kind: 'none', guiServer: 'appserver-rpsxx' },
        release: { released: true },
      });
      expect(json).not.toHaveProperty('warnings');
      // The user's SAP GUI server: their latest SAP GUI logon in USR41, read through the data preview.
      expect(named(fake.calls, 'POST', '/sap/bc/adt/datapreview/freestyle').map((c) => c.body)).toEqual([
        "SELECT server, logon_date, logon_time FROM usr41 WHERE bname = 'ADMIN'",
      ]);
      // The probe from the stateless client, then the final set from a session on each server — the SAP GUI's last.
      expect(externalSyncs(fake.calls).map((c) => c.server)).toEqual([
        undefined,
        'appserver-t4w2x',
        'appserver-rpsxx',
      ]);
      // Removed from there too: removing the last breakpoint switches debugging off on the server that removes it.
      const removals = fake.calls.filter((c) => c.method === 'DELETE' && c.query.get('scope') === 'external');
      expect(removals.length).toBeGreaterThan(0);
      expect(removals.every((c) => c.server === 'appserver-rpsxx')).toBe(true);
      expect(fake.armedOn()).toBeUndefined();
      // Every session ends: the two attach sessions and the two arming ones.
      expect(
        fake.calls
          .filter((c) => c.sessionType === 'stateless')
          .map((c) => c.server)
          .sort(),
      ).toEqual(['appserver-rpsxx', 'appserver-rpsxx', 'appserver-t4w2x', 'appserver-t4w2x']);
    });

    it('says why such a run may not stop when USR41 cannot be read', async () => {
      const fake = installFakeSap({ ...gui, usr41: 403 });
      const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none', timeoutSeconds: 1 });

      expect(json).toMatchObject({ hit: false, reason: 'timeout', trigger: { kind: 'none' } });
      expect(json?.trigger).not.toHaveProperty('guiServer');
      expect(json?.warnings).toEqual([
        expect.stringContaining(
          "Could not look up which application server runs SAP user ADMIN's SAP GUI (table USR41 through the ADT data preview: ",
        ),
      ]);
      expect(json?.warnings[0]).toContain('No authorization for table USR41');
      expect(json?.hint).toContain(
        'With several application servers, a SAP GUI run stops reliably only on the one that armed the breakpoints last',
      );
      // As before: armed from the stateless client alone, and every session ended.
      expect(externalSyncs(fake.calls).every((c) => c.server === undefined)).toBe(true);
      expect(fake.calls.filter((c) => c.sessionType === 'stateless')).toHaveLength(3);
    });

    it("names the server a SAP GUI run stops on when the user's run was elsewhere", async () => {
      installFakeSap({
        ...gui,
        usr41: [
          { server: 'appserver-rpsxx', date: '20261027' },
          { server: 'appserver-t4w2x', date: '20261028' },
        ],
      });
      const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none', timeoutSeconds: 1 });

      expect(json).toMatchObject({ hit: false, reason: 'timeout', trigger: { guiServer: 'appserver-t4w2x' } });
      expect(json).not.toHaveProperty('warnings');
      expect(json?.hint).toContain(
        "Run from SAP GUI, it stops reliably on application server appserver-t4w2x only (ADMIN's latest SAP GUI logon, which armed the breakpoints last), not on appserver-rpsxx where ADMIN is logged on too; System → Status in SAP GUI names the server.",
      );
    });
  });

  it('shows a structure watched across steps by its components', async () => {
    installFakeSap({ hit: true });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, variables: ['LS_HEAD'], steps: 1 });
    expect(json?.stops[0].steps).toEqual([
      expect.objectContaining({ step: 1, values: { LS_HEAD: { VBELN: '0000004711', KUNNR: 'CUST01' } } }),
    ]);
  });

  it("keeps a string's blanks (they count) and drops a fixed-length field's padding", async () => {
    installFakeSap({ hit: true });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      variables: ['LV_TEXT', 'LV_CHAR'],
      steps: 1,
    });
    expect(json?.stops[0].variables).toEqual([
      expect.objectContaining({ name: 'LV_TEXT', kind: 'string', value: '124 ' }),
      expect.objectContaining({ name: 'LV_CHAR', kind: 'simple', value: 'ABC' }),
    ]);
    expect(json?.stops[0].steps[0].values).toEqual({ LV_TEXT: '124 ', LV_CHAR: 'ABC' });
  });

  it("runs the unit tests of the breakpoint's object when the call names no top-level object", async () => {
    installFakeSap({ hit: true });
    const { result, json } = await debug({ breakpoints: [{ type: 'CLAS', name: 'zcl_order', line: 9 }] });
    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({
      hit: true,
      trigger: { kind: 'unittest', target: 'ABAP Unit CLAS ZCL_ORDER', status: 'completed' },
    });
  });

  it("gives the debuggee's line within its include, labelled so, when SAP sends no URI", async () => {
    installFakeSap({ hit: true, stackWithoutUri: true });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(json?.debuggee).toMatchObject({ include: 'ZCL_ORDER=====================CM001', includeLine: 3 });
    expect(json?.debuggee).not.toHaveProperty('line');
  });

  it('refuses a second capture for the same SAP user while one is running', async () => {
    installFakeSap({ hit: true });
    const conn = createConnection();
    const first = debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, conn);
    const second = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, conn);
    expect(second.result.isError).toBe(true);
    expect(second.text).toContain('Your debug capture S1 is still running');
    expect((await first).json?.hit).toBe(true);
  });
});

describe('abap_debug — several stops in one run', () => {
  const at9 = { path: MAIN, line: 9 };
  const at11 = { path: MAIN, line: 11 };
  const line9 = 'CLAS ZCL_ORDER the main source line 9';
  const line11 = 'CLAS ZCL_ORDER the main source line 11';
  const method = (calls: Call[], name: string) => calls.filter((c) => c.query.get('method') === name);

  it('follows the run from one breakpoint to the next, retiring each after its stop', async () => {
    const { calls } = installFakeSap({ hit: true, execution: [at9, at11] });
    const { result, json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9 }, { line: 11 }],
      variables: ['LV_TOTAL'],
    });

    expect(result.isError).toBeFalsy();
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({ location: line9, status: 'set', line: 9, hits: 1 }),
      expect.objectContaining({ location: line11, status: 'set', line: 11, hits: 1 }),
    ]);
    expect(json?.stops).toEqual([
      expect.objectContaining({
        stop: 1,
        at: line9,
        stoppedAt: expect.objectContaining({ uri: `${MAIN}#start=9,4` }),
        variables: [expect.objectContaining({ name: 'LV_TOTAL', value: '39' })],
      }),
      expect.objectContaining({
        stop: 2,
        at: line11,
        stoppedAt: expect.objectContaining({ uri: `${MAIN}#start=11,4` }),
        variables: [expect.objectContaining({ name: 'LV_TOTAL', value: '41' })],
      }),
    ]);
    // Each breakpoint shows the call stack on its first stop.
    expect(json?.stops[1].stack).toHaveLength(1);
    expect(json?.release).toEqual({ released: true, via: 'continue' });
    // Line 9 left the run (its session copy, on the attached session) before the run went on to 11.
    const retired = calls.filter((c) => c.method === 'DELETE' && c.query.get('scope') === 'debugger');
    expect(retired.map((c) => c.path)).toEqual(['/sap/bc/adt/debugger/breakpoints/BP-L9']);
    expect(retired.every((c) => c.stateful)).toBe(true);
    // One continue to the second stop, one to release the run after it.
    expect(method(calls, 'stepContinue')).toHaveLength(2);
    // Both locations were probed in one POST, under their own client ids.
    const probe = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')[0]!;
    expect(probe.body).toContain('clientId="dbg-0-line-9"');
    expect(probe.body).toContain('clientId="dbg-1-line-11"');
  });

  it('stops at a loop breakpoint as often as its hits allow, then runs on to the next one', async () => {
    const loop = Array.from({ length: 5 }, () => at9);
    installFakeSap({ hit: true, execution: [...loop, at11] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, hits: 3 }, { line: 11 }],
      variables: ['LV_TOTAL'],
    });

    expect(json?.stops.map((stop: Record<string, unknown>) => [stop.at, stop.hit ?? null])).toEqual([
      [line9, 1],
      [line9, 2],
      [line9, 3],
      [line11, null],
    ]);
    // A loop's later stops would only repeat the call stack.
    expect(json?.stops.map((stop: Record<string, unknown>) => 'stack' in stop)).toEqual([true, false, false, true]);
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([3, 1]);
  });

  it('records at most 50 stops, then lets the run go on', async () => {
    const loop = Array.from({ length: 60 }, () => at9);
    installFakeSap({ hit: true, execution: [...loop, at11] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, hits: 50 }, { line: 11 }],
      variables: ['LV_TOTAL'],
    });

    expect(json?.stops).toHaveLength(50);
    expect(json?.warnings).toContainEqual(expect.stringContaining('at most 50 stops'));
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([50, 0]);
    expect(json?.release).toMatchObject({ released: true, via: 'continue' });
  });

  it('reports a breakpoint the run never reached and needs no release once the run ended', async () => {
    const { calls } = installFakeSap({ hit: true, execution: [at9] });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9 }, { line: 11 }] });

    expect(json?.stops).toHaveLength(1);
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([1, 0]);
    expect(json?.release).toEqual({ released: true, via: 'continue' });
    // The continue toward line 11 ran the program to its end: nothing left to release.
    expect(method(calls, 'stepContinue')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST' && c.body.includes('scope="debugger"'))).toBe(false);
  });

  it('stops in another object of the same run', async () => {
    installFakeSap({ hit: true, execution: [at9, { path: REPORT, line: 30 }] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9 }, { type: 'PROG', name: 'zreport', line: 30 }],
    });

    expect(json?.breakpoints[1]).toMatchObject({
      location: 'PROG ZREPORT line 30',
      status: 'set',
      uri: `${REPORT}#start=30`,
      hits: 1,
    });
    expect(json?.stops.map((stop: Record<string, unknown>) => stop.at)).toEqual([line9, 'PROG ZREPORT line 30']);
    expect(json?.stops[1].stoppedAt).toMatchObject({ program: 'ZREPORT', line: 30 });
    // The unit tests of the top-level object still run the code.
    expect(json?.trigger).toMatchObject({ target: 'ABAP Unit CLAS ZCL_ORDER' });
  });

  it('names a stop by the breakpoint SAP reports when the stack carries no position', async () => {
    installFakeSap({ hit: true, namesBreakpoints: true, stackWithoutUri: true, execution: [at9, at11] });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9 }, { line: 11 }] });
    expect(json?.stops.map((stop: Record<string, unknown>) => stop.at)).toEqual([line9, line11]);
  });

  it('leaves a stop it cannot place unnamed and keeps following the run', async () => {
    installFakeSap({ hit: true, stackWithoutUri: true, execution: [at9, at11] });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9 }, { line: 11 }] });
    expect(json?.stops).toHaveLength(2);
    expect(json?.stops.some((stop: Record<string, unknown>) => 'at' in stop)).toBe(false);
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([0, 0]);
  });

  it('reports two locations on the same line once', async () => {
    installFakeSap({ hit: true, acceptLinesFrom: 9 });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9 }, { method: 'get_total' }],
    });
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({ location: line9, status: 'set', line: 9, hits: 1 }),
      { kind: 'line', location: 'CLAS ZCL_ORDER method get_total', status: 'duplicate', of: line9 },
    ]);
    expect(json?.stops).toHaveLength(1);
  });

  it('steps into calls or out to the caller as stepMode says', async () => {
    const into = installFakeSap({ hit: true });
    const stepped = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 2, stepMode: 'into' });
    expect(stepped.json?.stops[0].steps).toHaveLength(2);
    expect(method(into.calls, 'stepInto')).toHaveLength(2);
    expect(method(into.calls, 'stepOver')).toHaveLength(0);

    const out = installFakeSap({ hit: true });
    await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 1, stepMode: 'out' });
    expect(method(out.calls, 'stepReturn')).toHaveLength(1);
  });

  it('makes a step that runs into a breakpoint the next stop, and counts its hit', async () => {
    const line10 = 'CLAS ZCL_ORDER the main source line 10';
    // SAP names the breakpoint in the step answer, or only the stack's position shows it.
    for (const namesBreakpoints of [true, false]) {
      const { calls } = installFakeSap({ hit: true, namesBreakpoints, execution: [at9] });
      const { json } = await debug({
        type: 'CLAS',
        name: 'ZCL_ORDER',
        breakpoints: [{ line: 9 }, { line: 10 }],
        variables: ['LV_TOTAL'],
        steps: 2,
      });
      expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([1, 1]);
      expect(json?.stops).toEqual([
        expect.objectContaining({
          stop: 1,
          at: line9,
          steps: [expect.objectContaining({ step: 1, breakpoint: line10 })],
        }),
        expect.objectContaining({
          stop: 2,
          at: line10,
          variables: [expect.objectContaining({ name: 'LV_TOTAL', value: '40' })],
          steps: [expect.objectContaining({ step: 1 }), expect.objectContaining({ step: 2 })],
        }),
      ]);
      // The stop right after the interrupted step reads its values.
      expect(json?.stops[0].steps[0]).not.toHaveProperty('values');
      // The run already stood at the second stop: no continue to reach it, one to release the run.
      expect(method(calls, 'stepContinue')).toHaveLength(1);
    }
  });

  it('takes a step back onto a loop breakpoint as its next hit, and none after its last', async () => {
    const { calls } = installFakeSap({ hit: true, execution: [at9], stepPath: [10, 9, 10, 9, 10] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, hits: 2 }],
      variables: ['LV_TOTAL'],
      steps: 3,
    });
    expect(json?.stops.map((stop: Record<string, unknown>) => [stop.at, stop.hit])).toEqual([
      [line9, 1],
      [line9, 2],
    ]);
    expect(json?.stops[0].steps).toEqual([
      expect.objectContaining({ step: 1, values: { LV_TOTAL: '40' } }),
      expect.objectContaining({ step: 2, breakpoint: line9 }),
    ]);
    // Its hits made, the breakpoint left the run before the steps: back on line 9 is just a step.
    expect(json?.stops[1].steps).toHaveLength(3);
    expect(json?.stops[1].steps.some((step: Record<string, unknown>) => 'breakpoint' in step)).toBe(false);
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([2]);
    const retired = calls.filter((c) => c.method === 'DELETE' && c.query.get('scope') === 'debugger');
    expect(retired.map((c) => c.path)).toEqual(['/sap/bc/adt/debugger/breakpoints/BP-L9']);
  });

  it("back in the caller, takes a breakpoint on the line it returned to only on SAP's word", async () => {
    const at10 = { path: MAIN, line: 10 };
    const returned: FakeSapOptions = { hit: true, helperLines: [10, 11], execution: [at10], stepPath: [11, 12] };
    const args = { type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 10 }, { line: 12 }], steps: 2 };

    installFakeSap({ ...returned });
    const byPosition = await debug(args);
    expect(byPosition.json?.stops).toHaveLength(1);
    expect(byPosition.json?.stops[0].steps[1]).toMatchObject({ step: 2, frame: 'returned' });
    expect(byPosition.json?.stops[0].steps[1]).not.toHaveProperty('breakpoint');
    expect(byPosition.json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([1, 0]);

    installFakeSap({ ...returned, namesBreakpoints: true });
    const named = await debug(args);
    expect(named.json?.stops).toHaveLength(2);
    expect(named.json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([1, 1]);
  });

  it('inspects a post-mortem session once, retiring and following nothing', async () => {
    const { calls } = installFakeSap({ hit: true, postMortem: true, execution: [at9, at11] });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9 }, { line: 11 }] });
    expect(json?.stops).toHaveLength(1);
    expect(json?.warnings).toContainEqual(expect.stringContaining('post-mortem'));
    expect(calls.some((c) => c.method === 'DELETE' && c.query.get('scope') === 'debugger')).toBe(false);
  });

  it('stops stepping when the inspection budget runs low, and still releases the run', async () => {
    setDebugTimingsForTests({ continueMarginMs: 10 * 60_000 });
    try {
      installFakeSap({ hit: true });
      const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 3 });
      expect(json?.stops[0]).not.toHaveProperty('steps');
      expect(json?.warnings).toContainEqual(expect.stringContaining('inspection budget ran low after 0 step(s)'));
      expect(json?.release).toMatchObject({ released: true });
    } finally {
      setDebugTimingsForTests({ continueMarginMs: 15_000 });
    }
  });

  it('records more than 100 steps across stops: only time and size bound them now', async () => {
    installFakeSap({ hit: true, execution: Array.from({ length: 6 }, () => at9) });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, hits: 6 }],
      steps: 20,
      variables: ['LV_TOTAL'],
    });
    expect(
      json?.stops.map((stop: Record<string, unknown>) => (stop.steps as unknown[] | undefined)?.length ?? 0),
    ).toEqual([20, 20, 20, 20, 20, 20]);
    expect(json?.warnings ?? []).not.toContainEqual(expect.stringContaining('at most'));
  });

  it('arms up to 20 breakpoints in one run', async () => {
    installFakeSap({ hit: false });
    const { result, json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: Array.from({ length: 20 }, (_, index) => ({ line: index + 1 })),
    });
    expect(result.isError).toBeFalsy();
    expect(json?.breakpoints).toHaveLength(20);
    expect(json?.breakpoints.every((bp: Record<string, unknown>) => bp.status === 'set')).toBe(true);
  });

  it('reads each source once, and probes a method on its statement lines only', async () => {
    const { calls } = installFakeSap({ hit: false });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ method: 'get_total' }, { method: 'describe' }, { line: 10 }],
    });
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.line)).toEqual([7, 13, 10]);
    expect(named(calls, 'GET', MAIN)).toHaveLength(1);
    // Blank and comment lines never carry a statement: the probe skips them.
    const probe = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')[0]!;
    expect([...probe.body.matchAll(/dbg-1-line-(\d+)/g)].map((m) => m[1])).toEqual(['13', '17', '18']);
  });

  it('stops only where a condition holds: one pass of a long loop', async () => {
    const loop = Array.from({ length: 50 }, () => at9);
    const { calls } = installFakeSap({ hit: true, execution: [...loop, at11] });
    const { result, json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, condition: 'lv_pass = 37' }],
      variables: ['LV_PASS'],
    });
    expect(result.isError).toBeFalsy();
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({ location: line9, status: 'set', line: 9, condition: 'lv_pass = 37', hits: 1 }),
    ]);
    expect(json?.stops).toEqual([
      expect.objectContaining({ at: line9, variables: [expect.objectContaining({ name: 'LV_PASS', value: '37' })] }),
    ]);
    expect(json?.stops[0]).not.toHaveProperty('conditionNotEvaluated');
    // The probe finds the line without the condition; the final sync puts the condition on it.
    const syncs = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints').filter((c) =>
      c.body.includes('scope="external"'),
    );
    expect(syncs.map((c) => c.body.includes('condition='))).toEqual([false, true]);
    expect(syncs[1]?.body).toContain(
      'adtcore:uri="/sap/bc/adt/oo/classes/zcl_order/source/main#start=9" condition="lv_pass = 37"',
    );
  });

  it('stops as often as a condition holds, within the hits', async () => {
    const loop = Array.from({ length: 8 }, () => at9);
    installFakeSap({ hit: true, execution: loop });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, condition: 'LV_PASS > 5', hits: 5 }],
      variables: ['LV_PASS'],
    });
    expect(json?.stops.map((stop: Record<string, any>) => stop.variables?.[0].value ?? stop.values.LV_PASS)).toEqual([
      '6',
      '7',
      '8',
    ]);
    expect(json?.breakpoints[0]).toMatchObject({ hits: 3 });
  });

  it('reports a condition SAP refuses, and arms nothing for it', async () => {
    installFakeSap({ hit: true, execution: [at9] });
    const refused = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, condition: 'INVALID ~~' }],
    });
    expect(refused.result.isError).toBe(true);
    expect(refused.json?.breakpoints).toEqual([
      {
        kind: 'line',
        location: line9,
        status: 'refused',
        error: 'Condition is not valid',
        line: 9,
        condition: 'INVALID ~~',
      },
    ]);
  });

  it('says so when SAP could not evaluate a condition and stopped anyway', async () => {
    installFakeSap({ hit: true, execution: [at9] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, condition: "lv_nope = 'A'" }],
    });
    expect(json?.stops[0]).toMatchObject({
      at: line9,
      conditionNotEvaluated: `SAP could not evaluate "lv_nope = 'A'" (error at character 0) and stopped anyway.`,
    });
    expect(json?.warnings).toContainEqual(expect.stringContaining('could not evaluate the condition of'));
  });

  it('arms one breakpoint per line, telling how to combine two conditions', async () => {
    installFakeSap({ hit: false });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [
        { line: 9, condition: 'LV_PASS = 1' },
        { line: 9, condition: 'LV_PASS = 2' },
      ],
    });
    expect(json?.breakpoints[1]).toMatchObject({
      status: 'duplicate',
      of: line9,
      condition: 'LV_PASS = 2',
      note: expect.stringContaining('join both with OR'),
    });
  });

  it("takes a step onto a conditional breakpoint for a stop of it only on SAP's word", async () => {
    const at10 = { path: MAIN, line: 10 };
    const { calls } = installFakeSap({ hit: true, execution: [at9, at10, at10] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9 }, { line: 10, condition: 'LV_PASS = 2' }],
      variables: ['LV_PASS'],
      steps: 1,
    });
    // The step lands on line 10, where the condition does not hold: no stop of that breakpoint.
    expect(json?.stops[0].steps).toEqual([expect.objectContaining({ step: 1, line: 10 })]);
    expect(json?.stops[0].steps[0]).not.toHaveProperty('breakpoint');
    // The continue then runs to its second pass, where it holds.
    expect(json?.stops[1]).toMatchObject({ at: 'CLAS ZCL_ORDER the main source line 10' });
    expect(json?.breakpoints.map((bp: Record<string, unknown>) => bp.hits)).toEqual([1, 1]);
    expect(calls.filter((c) => c.query.get('method') === 'stepContinue')).toHaveLength(2);
  });

  it("keeps a breakpoint's later stops to its values, marking unchanged structures and tables", async () => {
    installFakeSap({ hit: true, execution: [at9, at9, at9] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9, hits: 3 }],
      variables: ['LV_TOTAL', 'LS_HEAD', 'LT_ITEMS', 'LV_NOPE'],
    });
    expect(json?.stops[0]).toMatchObject({
      stop: 1,
      hit: 1,
      stoppedAt: expect.objectContaining({ line: 9 }),
      stack: expect.any(Array),
      variables: expect.arrayContaining([expect.objectContaining({ name: 'LS_HEAD', kind: 'structure' })]),
    });
    const later = {
      at: line9,
      values: { LV_TOTAL: '39', LS_HEAD: 'unchanged', LT_ITEMS: 'unchanged' },
      notVisible: ['LV_NOPE'],
    };
    expect(json?.stops.slice(1)).toEqual([
      { stop: 2, hit: 2, ...later },
      { stop: 3, hit: 3, ...later },
    ]);
  });

  it("keeps a breakpoint's later stops compact for frame variables too", async () => {
    installFakeSap({ hit: true, execution: [at9, at9] });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9, hits: 2 }] });
    expect(json?.stops[1]).toEqual({
      stop: 2,
      at: line9,
      hit: 2,
      values: { LV_TOTAL: '42', LS_HEAD: 'unchanged', LT_ITEMS: 'table[2]' },
    });
  });

  it('ends a capture on its result-size budget rather than a fixed number of stops', async () => {
    setResultBudgetForTests(2000);
    try {
      installFakeSap({ hit: true, execution: Array.from({ length: 30 }, () => at9) });
      const stops = await debug({
        type: 'CLAS',
        name: 'ZCL_ORDER',
        breakpoints: [{ line: 9, hits: 30 }],
        variables: ['LV_TOTAL'],
      });
      expect(stops.json?.stops.length).toBeGreaterThan(5);
      expect(stops.json?.stops.length).toBeLessThan(30);
      expect(stops.json?.warnings).toContainEqual(expect.stringContaining('size budget (about 2 KB)'));
      expect(stops.json?.release).toMatchObject({ released: true, via: 'continue' });

      installFakeSap({ hit: true });
      const steps = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, variables: ['LV_TOTAL'], steps: 20 });
      expect(steps.json?.stops[0].steps.length).toBeLessThan(20);
      expect(steps.json?.warnings).toContainEqual(expect.stringContaining('size budget'));
    } finally {
      setResultBudgetForTests();
    }
  });

  it('validates each breakpoint before anything reaches SAP', async () => {
    installFakeSap();
    const both = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9, method: 'get_total' }] });
    expect(both.text).toContain(
      'breakpoints[0] needs exactly one of line, method, message, statement or exceptionClass',
    );
    const noObject = await debug({ breakpoints: [{ line: 9 }] });
    expect(noObject.text).toContain('needs type (CLAS, PROG or FUNC) and name');
    const tooMany = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: Array.from({ length: 21 }, (_, index) => ({ line: index + 1 })),
    });
    expect(tooMany.result.isError).toBe(true);
    const tooManyHits = await debug({ type: 'CLAS', name: 'ZCL_ORDER', breakpoints: [{ line: 9, hits: 51 }] });
    expect(tooManyHits.result.isError).toBe(true);
    // The method is a breakpoints item now, not a top-level argument.
    const topLevelMethod = await debug({ type: 'CLAS', name: 'ZCL_ORDER', method: 'get_total' });
    expect(topLevelMethod.result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('abap_debug — long step runs', () => {
  const stepCalls = (calls: Call[]) =>
    named(calls, 'POST', '/sap/bc/adt/debugger').filter((call) => call.query.get('method') === 'stepOver');

  it('follows thousands of steps from one stop as a compact trace, loops folded', { timeout: 30_000 }, async () => {
    const loop = Array.from({ length: 500 }, () => [10, 11, 12, 9]).flat();
    const { calls } = installFakeSap({ hit: true, stepPath: loop });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      steps: 2000,
      variables: ['LV_HELPER'],
      maxSeconds: 600,
    });
    const [stop] = json?.stops ?? [];
    expect(stop).not.toHaveProperty('steps');
    expect(stop.trace).toEqual({
      steps: 2000,
      path: [{ procedure: 'METHOD GET_TOTAL', program: 'ZCL_ORDER=====================CP', lines: '(10-12 9)×500' }],
      // Watched values only where they changed: LV_HELPER never does after the first step.
      changes: [{ step: 1, line: 10, values: { LV_HELPER: '7' } }],
    });
    expect(stepCalls(calls)).toHaveLength(2000);
    expect(json?.release).toMatchObject({ released: true });
  });

  it('marks the frames a long run enters and leaves in its trace', async () => {
    const path = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
    installFakeSap({ hit: true, stepPath: path, helperLines: [13, 14, 15] });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 22, stepMode: 'into' });
    expect(json?.stops[0].trace).toEqual({
      steps: 22,
      path: [
        { procedure: 'METHOD GET_TOTAL', program: 'ZCL_ORDER=====================CP', lines: '10-12' },
        { frame: 'entered', procedure: 'METHOD HELPER', program: 'ZCL_ORDER=====================CP', lines: '13-15' },
        {
          frame: 'returned',
          procedure: 'METHOD GET_TOTAL',
          program: 'ZCL_ORDER=====================CP',
          lines: '16-31',
        },
      ],
    });
  });

  it('keeps a long run that ends early one entry per step', async () => {
    installFakeSap({ hit: true, stepPath: [10, 11, 10, 11, 12, 13] });
    // until without steps: step until it holds.
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, until: { line: 12 } });
    const steps = json?.stops[0].steps as Array<Record<string, unknown>>;
    expect(steps.map((step) => step.line)).toEqual([10, 11, 10, 11, 12]);
    expect(steps.at(-1)).toMatchObject({ line: 12, until: 'line 12' });
    expect(json?.stops[0]).not.toHaveProperty('trace');
  });

  it('steps until a variable changed', async () => {
    installFakeSap({ hit: true, stepPath: [9, 9, 10, 11] });
    // The fake's LV_TOTAL is 30 + the line the run stands on.
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      steps: 50,
      until: { changed: 'lv_total' },
    });
    const steps = json?.stops[0].steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(3);
    expect(steps.at(-1)).toMatchObject({ line: 10, values: { LV_TOTAL: '40' }, until: 'LV_TOTAL changed' });
  });

  it('ends a long run on its size budget, keeping the trace of what it followed', async () => {
    installFakeSap({ hit: true });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      steps: 3000,
      variables: ['LV_TOTAL'],
      maxResultKB: 5,
    });
    const trace = json?.stops[0].trace as { steps: number; changes: unknown[] };
    expect(trace.steps).toBeGreaterThan(20);
    expect(trace.steps).toBeLessThan(3000);
    expect(trace.changes).toHaveLength(trace.steps);
    expect(json?.warnings).toContainEqual(expect.stringContaining('size budget (about 5 KB)'));
    expect(json?.release).toMatchObject({ released: true });
  });

  it('ends a long run on its time budget', async () => {
    setDebugTimingsForTests({ continueMarginMs: 9_900 });
    try {
      installFakeSap({ hit: true });
      const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 5000, maxSeconds: 10 });
      expect(json?.warnings).toContainEqual(expect.stringContaining('10s inspection budget ran low'));
      const stop = json?.stops[0] as { trace?: { steps: number }; steps?: unknown[] };
      expect(stop.trace?.steps ?? stop.steps?.length ?? 0).toBeLessThan(5000);
      expect(json?.release).toMatchObject({ released: true });
    } finally {
      setDebugTimingsForTests({ continueMarginMs: 15_000 });
    }
  });

  it("caps the budgets a call asks for at the server's ceilings", async () => {
    installFakeSap({ hit: true });
    const conn = {
      ...createConnection(),
      limits: { ...DEFAULT_LIMITS, maxSeconds: 30, maxResultKB: 10, idleSeconds: 60, sessionSeconds: 300 },
    };
    const { json } = await debug(
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9, maxSeconds: 3600, maxResultKB: 1000 },
      conn,
    );
    expect(json?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('30 s apply (ABAP_DEBUGGER_MAX_SECONDS)'),
        expect.stringContaining('10 KB apply (ABAP_DEBUGGER_MAX_RESULT_KB)'),
      ]),
    );
  });

  it('reports progress and stops stepping once the client cancels the call', async () => {
    setDebugTimingsForTests({ progressIntervalMs: 0 });
    try {
      const { calls } = installFakeSap({ hit: true });
      const messages: string[] = [];
      const abort = new AbortController();
      const progress = (message: string) => {
        messages.push(message);
        if (message.startsWith('step 5 ')) abort.abort();
      };
      const result = await callTool(
        { connection: createConnection(), problems: [] },
        'abap_debug',
        { type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 100 },
        { signal: abort.signal, progress },
      );
      const json = JSON.parse(result.content[0]?.text ?? '{}');
      expect(messages[0]).toBe('waiting for the run to stop at a breakpoint (0 of 60 s)');
      expect(messages).toContain('stop 1 at CLAS ZCL_ORDER the main source line 9');
      expect(messages).toContain('step 1 of 100, line 10');
      expect(json.stops[0].steps).toHaveLength(5);
      expect(json.warnings).toContainEqual(expect.stringContaining('cancelled after 5 step(s)'));
      expect(stepCalls(calls)).toHaveLength(5);
      expect(json.release).toMatchObject({ released: true });
    } finally {
      setDebugTimingsForTests({ progressIntervalMs: 2000 });
    }
  });

  it('stops waiting for the first stop when the client cancels, and cleans up', async () => {
    const { calls } = installFakeSap({ hit: false });
    const abort = new AbortController();
    abort.abort();
    const result = await callTool(
      { connection: createConnection(), problems: [] },
      'abap_debug',
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none' },
      { signal: abort.signal },
    );
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ hit: false, reason: 'cancelled' });
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
  });

  it('validates until before anything reaches SAP', async () => {
    const { calls } = installFakeSap();
    const empty = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, until: {} });
    expect(empty.text).toContain('until needs line and/or changed');
    const zero = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, steps: 0, until: { line: 12 } });
    expect(zero.text).toContain('leave steps out to step until it holds');
    expect(calls).toHaveLength(0);
  });
});

describe('abap_debug — event breakpoints', () => {
  const at9 = { path: MAIN, line: 9 };
  const order = { type: 'CLAS', name: 'ZCL_ORDER' };

  it('stops where a message is issued, wherever that is', async () => {
    const { calls } = installFakeSap({
      hit: true,
      execution: [at9, { path: MAIN, line: 10, event: 'message:ZSD:042:E' }],
    });
    const { result, json } = await debug({
      ...order,
      breakpoints: [{ message: { id: 'zsd', number: 42, type: 'e' } }],
      variables: ['LV_TOTAL'],
    });
    expect(result.isError).toBeFalsy();
    expect(json?.breakpoints).toEqual([{ kind: 'message', message: 'E042(ZSD)', status: 'set', hits: 1 }]);
    expect(json?.stops).toEqual([
      expect.objectContaining({
        at: 'message E042(ZSD)',
        stoppedAt: expect.objectContaining({ line: 10 }),
        stack: expect.any(Array),
        variables: [expect.objectContaining({ name: 'LV_TOTAL', value: '40' })],
      }),
    ]);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')[0]?.body).toContain(
      'kind="message" clientId="dbg-0-message" skipCount="0" msgId="ZSD" msgNo="042" msgTy="E"',
    );
  });

  it('catches a message of any type when the type is left out', async () => {
    const { calls } = installFakeSap({
      hit: true,
      execution: [{ path: MAIN, line: 10, event: 'message:ZSD:042:W' }],
    });
    const { json } = await debug({ ...order, breakpoints: [{ message: { id: 'ZSD', number: '042' } }] });
    expect(json?.stops).toEqual([expect.objectContaining({ at: 'message 042(ZSD)' })]);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')[0]?.body).toContain('msgTy=""');
  });

  it('stops at each statement of a kind, set in the run once its line breakpoint stopped it', async () => {
    const { calls } = installFakeSap({
      hit: true,
      execution: [
        at9,
        { path: MAIN, line: 10, event: 'statement:COMMIT WORK' },
        { path: REPORT, line: 30, event: 'statement:COMMIT WORK' },
      ],
    });
    const { json } = await debug({ ...order, line: 9, breakpoints: [{ statement: 'commit   work', hits: 2 }] });
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({ kind: 'line', status: 'set', line: 9, hits: 1 }),
      { kind: 'statement', statement: 'COMMIT WORK', status: 'set', scope: 'run', hits: 2 },
    ]);
    // Not compact like a loop's line breakpoint: each stop is somewhere else.
    expect(json?.stops.map((stop: Record<string, any>) => [stop.at, stop.hit, stop.stoppedAt?.line])).toEqual([
      ['CLAS ZCL_ORDER the main source line 9', undefined, 9],
      ['statement COMMIT WORK', 1, 10],
      ['statement COMMIT WORK', 2, 30],
    ]);
    expect(json?.stops[2]).toHaveProperty('variables');
    // Never armed for the whole user: only the run's own set, on the attached session, names it.
    const syncs = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints');
    const external = syncs.filter((call) => call.body.includes('scope="external"'));
    const run = syncs.find((call) => call.body.includes('scope="debugger"') && call.body.includes('<breakpoint'));
    expect(external.some((call) => call.body.includes('kind="statement"'))).toBe(false);
    expect(run?.body).toContain('kind="statement" clientId="dbg-0-statement" skipCount="0" statement="COMMIT WORK"');
    expect(run?.body).toContain('kind="line"');
  });

  it('refuses a statement breakpoint without a line or method breakpoint to enter the run', async () => {
    const { calls } = installFakeSap({ hit: true, execution: [at9] });
    const { result, text } = await debug({ ...order, breakpoints: [{ statement: 'CLEAR' }] });
    expect(result.isError).toBe(true);
    expect(text).toContain('set in the debugged run only');
    expect(text).toContain("this server's own included");
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')).toHaveLength(0);
  });

  it('refuses a statement kind SAP does not know before arming anything, listing the ones it does', async () => {
    const { calls } = installFakeSap({ hit: true, execution: [at9] });
    const { result, text } = await debug({ ...order, line: 9, breakpoints: [{ statement: 'COMMIT' }] });
    expect(result.isError).toBe(true);
    expect(text).toBe('SAP knows no statement kind COMMIT. Its statement kinds: CALL FUNCTION, COMMIT WORK, MESSAGE.');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')).toHaveLength(0);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });

  it('sets exception breakpoints beside a line breakpoint in the run only, from its first stop', async () => {
    const { calls } = installFakeSap({
      hit: true,
      execution: [at9, { path: MAIN, line: 10, event: 'exception:CX_SY_ITAB_LINE_NOT_FOUND' }],
    });
    const { json } = await debug({
      ...order,
      line: 9,
      breakpoints: [{ exceptionClass: 'cx_sy_itab_line_not_found' }],
      exceptionClass: 'CX_SY_ZERODIVIDE',
    });
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({ kind: 'line', status: 'set', line: 9, hits: 1 }),
      { kind: 'exception', exceptionClass: 'CX_SY_ITAB_LINE_NOT_FOUND', status: 'set', scope: 'run', hits: 1 },
      { kind: 'exception', exceptionClass: 'CX_SY_ZERODIVIDE', status: 'set', scope: 'run', hits: 0 },
    ]);
    expect(json?.stops.map((stop: Record<string, any>) => stop.at)).toEqual([
      'CLAS ZCL_ORDER the main source line 9',
      'exception CX_SY_ITAB_LINE_NOT_FOUND',
    ]);
    const syncs = named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints');
    const run = syncs.find((call) => call.body.includes('scope="debugger"') && call.body.includes('<breakpoint'));
    expect(syncs.some((call) => call.body.includes('scope="external"') && call.body.includes('kind="exception"'))).toBe(
      false,
    );
    expect(run?.body).toContain('clientId="dbg-0-exception" skipCount="0" exceptionClass="CX_SY_ITAB_LINE_NOT_FOUND"');
    expect(run?.body).toContain('clientId="dbg-1-exception" skipCount="0" exceptionClass="CX_SY_ZERODIVIDE"');
  });

  it('learns the id of a run breakpoint SAP did not confirm from the stop that names it', async () => {
    installFakeSap({
      hit: true,
      runSyncSilent: true,
      execution: [at9, { path: MAIN, line: 10, event: 'exception:CX_SY_ZERODIVIDE' }],
    });
    const { json } = await debug({ ...order, line: 9, exceptionClass: 'CX_SY_ZERODIVIDE' });
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({ kind: 'line', status: 'set', hits: 1 }),
      { kind: 'exception', exceptionClass: 'CX_SY_ZERODIVIDE', status: 'set', scope: 'run', hits: 1 },
    ]);
    expect(json?.stops[1]).toMatchObject({ at: 'exception CX_SY_ZERODIVIDE' });
  });

  it('reports run breakpoints as never set when the run never stopped', async () => {
    installFakeSap({ hit: false });
    const { json } = await debug({ ...order, line: 9, exceptionClass: 'CX_SY_ZERODIVIDE', timeoutSeconds: 1 });
    expect(json?.hit).toBe(false);
    expect(json?.breakpoints[1]).toMatchObject({ kind: 'exception', status: 'not set', scope: 'run' });
  });

  it('validates event breakpoints before anything reaches SAP', async () => {
    installFakeSap();
    const lineAndMessage = await debug({
      ...order,
      breakpoints: [{ line: 9, message: { id: 'ZSD', number: '042' } }],
    });
    expect(lineAndMessage.text).toContain('needs exactly one of line, method, message, statement or exceptionClass');
    const withObject = await debug({ breakpoints: [{ type: 'CLAS', name: 'X', statement: 'COMMIT WORK' }] });
    expect(withObject.text).toContain('breakpoints[0].type only applies to a line or method breakpoint');
    const badNumber = await debug({ ...order, breakpoints: [{ message: { id: 'ZSD', number: '1234' } }] });
    expect(badNumber.text).toContain('message.number must be 1-3 digits');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('abap_debug — an attach SAP refuses', () => {
  it('names the server it could not reach and releases nothing it never attached', async () => {
    // The balancer only ever offers t4w2x; the user's run stops on rpsxx.
    const { calls } = installFakeSap({
      hit: true,
      runByUser: true,
      sessionUser: 'ADMIN',
      servers: ['appserver-t4w2x'],
      debuggeeServer: 'appserver-rpsxx',
    });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none' });

    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({ hit: true, attached: false, debuggee: { server: 'appserver-rpsxx' } });
    expect(json?.error).toContain('(invalidDebuggee)');
    expect(json?.error).toContain(
      "SAP attaches only from the debuggee's application server (appserver-rpsxx), and none of 8 new sessions landed there (the last on appserver-t4w2x)",
    );
    // Not attached = nothing to release: no stepContinue, no "released" claim.
    expect(json?.release).toBeUndefined();
    expect(calls.filter((c) => c.query.get('method') === 'attach')).toHaveLength(1);
    expect(calls.some((c) => c.query.get('method') === 'stepContinue')).toBe(false);
    // Every session the capture opened is ended again: two ahead of the run, eight after the stop.
    expect(calls.filter((c) => c.sessionType === 'stateless')).toHaveLength(10);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
  });
});

describe('abap_debug — a debuggee SAP cannot attach', () => {
  it('ends the session that waited for it', async () => {
    const { calls } = installFakeSap({
      hit: true,
      attachImpossible: true,
      sessionUser: 'ADMIN',
      servers: ['appserver-t4w2x', 'appserver-rpsxx'],
    });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });

    expect(json).toMatchObject({ hit: true, attached: false, debuggee: { server: 'appserver-t4w2x' } });
    expect(json?.error).toContain('IS_ATTACH_IMPOSSIBLE');
    expect(calls.some((c) => c.query.get('method') === 'attach')).toBe(false);
    // Both sessions opened ahead of the run end — the one waiting on the debuggee's server included.
    expect(
      calls
        .filter((c) => c.sessionType === 'stateless')
        .map((c) => c.server)
        .sort(),
    ).toEqual(['appserver-rpsxx', 'appserver-t4w2x']);
  });
});

describe('abap_debug — no hit', () => {
  it('ends the long poll when the unit tests finish first and still cleans up', async () => {
    const { calls } = installFakeSap({ hit: false });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(result.isError).toBeFalsy();
    expect(json).toMatchObject({
      hit: false,
      reason: 'trigger finished without reaching the breakpoint',
      trigger: { kind: 'unittest', status: 'completed' },
    });
    expect(json?.hint).toContain('coverage');
    expect(json?.hint).toContain('Right after an activation, wait about a minute');
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/breakpoints/BP-L9')).toHaveLength(1);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
    expect(calls.some((c) => c.query.get('method') === 'attach')).toBe(false);
  });

  it('reports a server-side timeout with trigger="none"', async () => {
    const { calls } = installFakeSap({ hit: false, listenerTimesOut: true });
    const { json } = await debug({ type: 'PROG', name: 'ZREPORT', line: 30, trigger: 'none', timeoutSeconds: 5 });
    expect(json).toMatchObject({ hit: false, reason: 'timeout', trigger: { kind: 'none' } });
    expect(json?.hint).toContain('same user');
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns')).toHaveLength(0);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')[0]?.query.get('timeout')).toBe('5');
  });

  it('refuses to take over another IDE listening for the same user', async () => {
    const { calls } = installFakeSap({ conflict: true });
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(result.isError).toBe(true);
    expect(text).toContain('ADMIN is debugged in Eclipse');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')).toHaveLength(0);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });

  it('reports a line SAP refuses everywhere without starting a listener', async () => {
    const { calls } = installFakeSap({ acceptLinesFrom: 100 });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 5 });
    expect(result.isError).toBe(true);
    expect(json?.breakpoints).toEqual([
      expect.objectContaining({
        status: 'refused',
        error: 'Cannot create a breakpoint at this position',
        triedLines: [5, 6, 7, 8, 9],
      }),
    ]);
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });
});

describe('abap_debug — whose run is caught', () => {
  /** BTP ABAP Environment: an OAuth token authenticates, and no configured name is the logon user. */
  const tokenConnection = () => createConnection({ username: undefined, bearerTokenProvider: async () => 'jwt' }, null);

  it('debugs the SAP user SAP names for this session behind a token', async () => {
    const { calls } = installFakeSap({ hit: false, sessionUser: 'cb9900000001' });
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, tokenConnection());
    expect(result.isError).toBeFalsy();
    expect(json?.user).toBe('CB9900000001');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/sap/bc/adt/core/http/systeminformation' });
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')[0]?.body).toContain('requestUser="CB9900000001"');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')[0]?.query.get('requestUser')).toBe('CB9900000001');
  });

  it('refuses behind a token when SAP cannot name the user, instead of guessing', async () => {
    const { calls } = installFakeSap();
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, tokenConnection());
    expect(result.isError).toBe(true);
    expect(text).toContain('Cannot tell which SAP user this session runs as');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /sap/bc/adt/core/http/systeminformation']);
  });

  it("prefers SAP's answer over the configured SAP_USER", async () => {
    const { calls } = installFakeSap({ hit: false, sessionUser: 'DEVELOPER' });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(json?.user).toBe('DEVELOPER');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')[0]?.query.get('requestUser')).toBe('DEVELOPER');
  });

  it('falls back to SAP_USER behind Basic auth where the release lacks systeminformation', async () => {
    const { calls } = installFakeSap({ hit: false });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(json?.user).toBe('ADMIN');
    // The stateless "who am I" finds no resource; so does the one probe ahead of the run, which then stops.
    expect(named(calls, 'GET', '/sap/bc/adt/core/http/systeminformation').map((c) => c.stateful)).toEqual([
      false,
      true,
    ]);
  });
});

describe('abap_debug — gates and input', () => {
  it('refuses when the SAP logon user is unknown (no requestUser can be sent)', async () => {
    const { calls } = installFakeSap();
    const conn = createConnection({ username: undefined, password: undefined }, null);
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, conn);
    expect(result.isError).toBe(true);
    expect(text).toContain('Cannot tell which SAP user this session runs as');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /sap/bc/adt/core/http/systeminformation']);
  });

  it('validates the breakpoint and refuses unknown parameters', async () => {
    installFakeSap();
    const missing = await debug({ type: 'CLAS', name: 'ZCL_ORDER' });
    expect(missing.result.isError).toBe(true);
    expect(missing.text).toContain('needs a breakpoint');
    const tooLong = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, timeoutSeconds: 1200 });
    expect(tooLong.text).toContain('1-900');
    const http = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'http' });
    expect(http.text).toContain('needs url');
    const methodOnProg = await debug({ type: 'PROG', name: 'ZREPORT', breakpoints: [{ method: 'x' }] });
    expect(methodOnProg.text).toContain('only supported for type="CLAS"');
    const stray = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, action: 'debug' });
    expect(stray.result.isError).toBe(true);
    expect(stray.text).toContain('Unrecognized key: "action"');
    const otherType = await debug({ type: 'INTF', name: 'ZIF_ORDER', line: 9 });
    expect(otherType.text).toContain('type must be CLAS, PROG or FUNC');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('only accepts host-relative OData paths for trigger="http"', async () => {
    const { calls } = installFakeSap();
    const { result, text } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      trigger: 'http',
      url: 'https://evil.example/sap/opu/odata4/x',
    });
    expect(result.isError).toBe(true);
    expect(text).toContain('host-relative OData path');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')).toHaveLength(0);
  });

  it('resolves triggerName to its object type before arming', async () => {
    const { calls } = installFakeSap({ hit: false });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, triggerName: 'ztc_order' });
    expect(json?.trigger).toMatchObject({ target: 'ABAP Unit CLAS ZTC_ORDER' });
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns')[0]?.body).toContain(
      '/sap/bc/adt/oo/classes/ZTC_ORDER',
    );
  });

  it('surfaces SAP authorization refusals as tool errors without starting a listener', async () => {
    const { calls } = installFakeSap({ breakpointsForbidden: true });
    const { result, text } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(result.isError).toBe(true);
    expect(text).toContain('No authorization to debug');
    expect(named(calls, 'POST', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(0);
  });

  it('runs an OData GET as the trigger', async () => {
    const { calls } = installFakeSap({ hit: false });
    const url = '/sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel?$top=1';
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'http', url });
    expect(json).toMatchObject({
      hit: false,
      reason: 'trigger finished without reaching the breakpoint',
      trigger: { kind: 'http', target: `GET ${url}`, status: 'completed', result: { statusCode: 200 } },
    });
    const get = calls.find((c) => c.path.startsWith('/sap/opu/odata4/'));
    expect(get?.method).toBe('GET');
    expect(get?.query.get('$top')).toBe('1');
    expect(named(calls, 'POST', '/sap/bc/adt/abapunit/testruns')).toHaveLength(0);
  });

  it('says the trigger itself failed when the OData service refuses the call', async () => {
    const { calls } = installFakeSap({ hit: false, odataBlocked: true });
    const url = '/sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel';
    const { result, json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'http', url });
    expect(result.isError).toBeFalsy();
    expect(json?.reason).toMatch(/^trigger failed: .*403.*blocked by UCON/);
    expect(json?.trigger).toMatchObject({ kind: 'http', status: 'failed' });
    expect(json?.hint).toContain('The trigger request itself failed');
    expect(json?.hint).toContain('browser or REST client');
    expect(json?.hint).not.toContain('finished without reaching the breakpoint');
    // Cleanup as always.
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/breakpoints/BP-L9')).toHaveLength(1);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
  });
});

describe('abap_debug — captures that outlast their call', () => {
  const quick = (limits: Partial<typeof DEFAULT_LIMITS> = {}, logonUser = 'admin') => ({
    ...createConnection({}, logonUser),
    limits: { ...DEFAULT_LIMITS, callSeconds: 0.5, ...limits },
  });
  async function session(args: Record<string, unknown>, owner?: string) {
    const result = await callTool(
      { connection: createConnection(), problems: [] },
      'abap_debug_session',
      args,
      owner ? { owner } : {},
    );
    const text = result.content[0]?.text ?? '';
    let json: Record<string, any> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { result, text, json };
  }
  const capture = (conn: ReturnType<typeof quick>, owner: string, args: Record<string, unknown> = {}) =>
    callTool(
      { connection: conn, problems: [] },
      'abap_debug',
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9, ...args },
      { owner },
    );
  const textOf = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? '';

  it('answers with its session id while the stop is still to come; wait gives the capture', async () => {
    installFakeSap({ hit: true, stopAfterMs: 900 });
    const first = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, quick());
    expect(first.result.isError).toBeFalsy();
    expect(first.json).toMatchObject({
      session: 'S1',
      running: true,
      doing: 'waiting for the run to stop at a breakpoint (0 of 60 s)',
    });
    expect((await session({ action: 'step' })).text).toContain('S1 is a one-shot capture');
    const done = await session({ action: 'wait', session: 's1' });
    expect(done.json).toMatchObject({
      hit: true,
      stops: [{ stop: 1, at: 'CLAS ZCL_ORDER the main source line 9' }],
      release: { released: true },
    });
    expect((await session({ action: 'wait' })).text).toBe(
      'Nothing of yours runs: no debug capture, no session. Start one with abap_debug.',
    );
  });

  it('stops a capture still waiting for its stop on end, and cleans up', async () => {
    const { calls } = installFakeSap({ hit: false });
    const first = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, trigger: 'none' }, quick());
    expect(first.json).toMatchObject({ session: 'S1', running: true });
    expect((await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9 })).text).toBe(
      'Your debug capture S1 is still running: abap_debug_session action="wait" returns its result, action="end" stops it.',
    );
    const end = await session({ action: 'end' });
    expect(end.json).toMatchObject({ hit: false, reason: 'cancelled' });
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
  });

  it('caps the captures running at once, and keeps one capture per SAP user across MCP users', async () => {
    installFakeSap({ hit: false });
    const alice = await capture(quick({ maxCaptures: 1 }), 'alice', { trigger: 'none' });
    expect(JSON.parse(textOf(alice))).toMatchObject({ session: 'S1', running: true });
    // Another MCP user debugging the same SAP user waits for the first capture.
    expect(textOf(await capture(quick({ maxCaptures: 1 }), 'carol'))).toBe(
      'A debug capture (S1) for SAP user ADMIN is already running on this server — wait for it to finish.',
    );
    // Another SAP user meets the server's cap.
    const bob = await capture(quick({ maxCaptures: 1 }, 'bob'), 'bob');
    expect(bob.isError).toBe(true);
    expect(textOf(bob)).toBe(
      'Debug captures running on this server: 1 of 1 (ABAP_DEBUGGER_MAX_CAPTURES). Each can hold an SAP work process while its program is stopped — try again when one has ended.',
    );
    // Nobody but Alice reaches her capture.
    expect((await session({ action: 'end' }, 'bob')).text).toBe(
      'No interactive debug session is open. Start one with abap_debug and interactive: true.',
    );
    expect((await session({ action: 'end' }, 'alice')).json).toMatchObject({ hit: false, reason: 'cancelled' });
  });
});

describe('abap_debug — non-exclusive debugging', () => {
  it('releases a program SAP attached non-exclusively at once, reading and stepping nothing', async () => {
    const { calls } = installFakeSap({ hit: true, nonExclusive: true });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      breakpoints: [{ line: 9 }, { exceptionClass: 'CX_SY_ZERODIVIDE' }],
      variables: ['LV_TOTAL'],
      steps: 3,
    });
    expect(json).toMatchObject({ hit: true, attached: true, release: { released: true, via: 'continue' } });
    expect(json?.error).toContain('non-exclusive mode');
    expect(json).not.toHaveProperty('stops');
    expect(json?.breakpoints[1]).toMatchObject({
      status: 'not set',
      note: 'the run was released at its first stop without inspection (non-exclusive debugging)',
    });
    const methods = named(calls, 'POST', '/sap/bc/adt/debugger').map((c) => c.query.get('method'));
    expect(methods).toContain('attach');
    expect(methods).toContain('stepContinue');
    expect(
      methods.filter((method) => ['getVariables', 'getChildVariables', 'stepOver'].includes(method ?? '')),
    ).toEqual([]);
    expect(named(calls, 'GET', '/sap/bc/adt/debugger/stack')).toHaveLength(0);
  });
});

describe('abap_debug — watchpoints', () => {
  const at = (line: number) => ({ path: MAIN, line });

  it('sets watchpoints at the first stop and stops where the variable changes, each change from and to', async () => {
    const { calls } = installFakeSap({
      hit: true,
      execution: [at(9), at(12), at(15)],
      watchChanges: [
        { index: 1, variable: 'LV_TOTAL' },
        { index: 2, variable: 'LV_TOTAL' },
      ],
    });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      watch: [{ variable: 'lv_total', hits: 2 }],
      variables: ['LV_TOTAL'],
    });
    expect(json?.watchpoints).toEqual([{ variable: 'LV_TOTAL', status: 'set', hits: 2 }]);
    expect(json?.stops).toMatchObject([
      { stop: 1, at: 'CLAS ZCL_ORDER the main source line 9' },
      { stop: 2, at: 'watchpoint LV_TOTAL', hit: 1, changed: { from: '39', to: '42' }, stoppedAt: { line: 12 } },
      { stop: 3, at: 'watchpoint LV_TOTAL', hit: 2, changed: { from: '42', to: '45' }, stoppedAt: { line: 15 } },
    ]);
    // Created on the attached session, and gone before the release lets the run go on.
    const created = named(calls, 'POST', '/sap/bc/adt/debugger/watchpoints')[0];
    expect(created?.stateful).toBe(true);
    expect(Object.fromEntries(created?.query ?? [])).toEqual({
      variableName: 'LV_TOTAL',
      condition: '',
      active: 'true',
    });
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/watchpoints/WP-LV_TOTAL')).toHaveLength(1);
    expect(json?.release).toEqual({ released: true, via: 'continue' });
  });

  it("tells a watchpoint's stop by the variable that changed when SAP does not name it", async () => {
    installFakeSap({
      hit: true,
      execution: [at(9), at(13)],
      watchChanges: [{ index: 1, variable: 'LV_TOTAL' }],
      silentWatchpoints: true,
    });
    const { json } = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, watch: [{ variable: 'LV_TOTAL' }] });
    expect(json?.stops[1]).toMatchObject({ at: 'watchpoint LV_TOTAL', changed: { from: '39', to: '43' } });
    expect(json?.stops[1]).not.toHaveProperty('hit');
  });

  it('reports a watchpoint SAP refuses, and follows the run without it', async () => {
    installFakeSap({ hit: true, watchRefused: ['LV_NOPE'] });
    const { json } = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      watch: [{ variable: 'LV_NOPE', condition: "lv_nope = 'X'" }],
    });
    expect(json?.watchpoints).toEqual([
      {
        variable: 'LV_NOPE',
        condition: "lv_nope = 'X'",
        status: 'refused',
        reason: expect.stringContaining('LV_NOPE is unknown here'),
      },
    ]);
    expect(json?.stops).toHaveLength(1);
    expect(json?.release).toMatchObject({ released: true });
  });

  it('validates watchpoints before anything reaches SAP', async () => {
    const { calls } = installFakeSap();
    const empty = await debug({ type: 'CLAS', name: 'ZCL_ORDER', line: 9, watch: [{ variable: '' }] });
    expect(empty.result.isError).toBe(true);
    const many = await debug({
      type: 'CLAS',
      name: 'ZCL_ORDER',
      line: 9,
      watch: Array.from({ length: 6 }, (_, index) => ({ variable: `LV_${index}` })),
    });
    expect(many.text).toContain('watch');
    expect(calls).toHaveLength(0);
  });
});

/**
 * Interactive debugging (src/tools/debug-session.ts): abap_debug with interactive: true holds the
 * program at its first stop, abap_debug_session drives it one move per call — over a real
 * AdtHttpClient and the fake SAP of tests/helpers/fake-sap.ts.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { callTool } from '../../../src/server.js';
import type { SapConnection } from '../../../src/tools/connection.js';
import { setDebugTimingsForTests } from '../../../src/tools/debug-capture.js';
import { DEFAULT_LIMITS } from '../../../src/tools/debug-limits.js';
import { resetDebuggingForTests, stopAllDebugging } from '../../../src/tools/debug-registry.js';
import { openDebugSessionId } from '../../../src/tools/debug-session.js';
import {
  type Call,
  createConnection,
  type FakeSapOptions,
  installFakeSap as installFakeSapOn,
  MAIN,
  named,
} from '../../helpers/fake-sap.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

const installFakeSap = (options: FakeSapOptions = {}) => installFakeSapOn(mockFetch, options);

async function call(
  tool: string,
  args: Record<string, unknown>,
  conn: SapConnection = createConnection(),
  owner?: string,
) {
  const result = await callTool({ connection: conn, problems: [] }, tool, args, owner ? { owner } : {});
  const text = result.content[0]?.text ?? '';
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result, text, json };
}

const start = (args: Record<string, unknown>, conn?: SapConnection) =>
  call('abap_debug', { type: 'CLAS', name: 'ZCL_ORDER', interactive: true, ...args }, conn);
const move = (args: Record<string, unknown>, owner?: string) =>
  call('abap_debug_session', args, createConnection(), owner);
const stepCalls = (calls: Call[], method = 'stepOver') =>
  named(calls, 'POST', '/sap/bc/adt/debugger').filter((c) => c.query.get('method') === method);

const withLimits = (limits: Partial<NonNullable<SapConnection['limits']>>): SapConnection => ({
  ...createConnection(),
  limits: { ...DEFAULT_LIMITS, ...limits },
});

const at = (line: number) => ({ path: MAIN, line });
const line = (n: number) => `CLAS ZCL_ORDER the main source line ${n}`;

beforeAll(() => {
  setDebugTimingsForTests({ armDelayMs: 0, triggerSettleMs: 200 });
});

afterEach(async () => {
  await resetDebuggingForTests();
  mockFetch.mockReset();
});

describe('abap_debug — interactive sessions', () => {
  it('stops at the first stop and keeps the program waiting there until the session ends', async () => {
    const { calls } = installFakeSap({ hit: true, acceptLinesFrom: 9 });
    const { json } = await start({ breakpoints: [{ method: 'get_total' }] });
    expect(json).toMatchObject({
      hit: true,
      session: 'S1',
      stop: { stop: 1, at: 'CLAS ZCL_ORDER method get_total', stoppedAt: { procedure: 'METHOD GET_TOTAL', line: 9 } },
      position: { procedure: 'METHOD GET_TOTAL', line: 9 },
      code: [
        '  7:   METHOD get_total.',
        '  8:     DATA lv_total TYPE i.',
        '> 9:     lv_total = 42.',
        ' 10:     rv_total = lv_total.',
        ' 11:   ENDMETHOD.',
      ],
      trigger: { kind: 'unittest', status: 'waiting' },
      idleTimeoutSeconds: 120,
      endsInSeconds: 900,
    });
    expect(json?.next).toContain('abap_debug_session');
    // Held, not released: no continue yet; the listener and the external breakpoints are gone.
    expect(stepCalls(calls, 'stepContinue')).toHaveLength(0);
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
    expect(openDebugSessionId()).toBe('S1');

    const end = await move({ action: 'end' });
    expect(end.json).toMatchObject({
      session: 'S1',
      action: 'end',
      ended: true,
      reason: 'the session was ended on request',
      release: { released: true, via: 'continue' },
      breakpoints: [{ status: 'set', hits: 1 }],
      stops: 1,
      steps: 0,
      trigger: { kind: 'unittest', status: 'completed' },
    });
    expect(end.json).not.toHaveProperty('idleTimeoutSeconds');
    expect(openDebugSessionId()).toBeUndefined();
  });

  it('makes one move per call and shows where the program stands after it', async () => {
    const { calls } = installFakeSap({ hit: true });
    await start({ line: 9 });

    const one = await move({ action: 'step' });
    expect(one.json).toMatchObject({ session: 'S1', action: 'step', position: { line: 10 } });
    expect(one.json?.code).toContain(' 10:     rv_total = lv_total.'.replace(' 10', '>10'));
    expect(one.json).not.toHaveProperty('steps');

    // Watched from now on; the fake's LV_TOTAL is 30 + the line.
    const watched = await move({ action: 'step', variables: ['lv_total'] });
    expect(watched.json).toMatchObject({ position: { line: 11 }, values: { LV_TOTAL: '41' } });

    const three = await move({ action: 'step', count: 3 });
    expect(three.json?.steps.map((step: { line: number }) => step.line)).toEqual([12, 13, 14]);
    expect(three.json).toMatchObject({ position: { line: 14 }, values: { LV_TOTAL: '44' } });

    const long = await move({ action: 'step', count: 30 });
    expect(long.json?.trace).toMatchObject({ steps: 30, path: [{ lines: '15-44' }] });
    expect(stepCalls(calls)).toHaveLength(35);

    expect((await move({ action: 'end' })).json).toMatchObject({ steps: 35 });
  });

  it('reads any variable and the call stack where the program stands', async () => {
    installFakeSap({ hit: true });
    await start({ line: 9 });
    const { json } = await move({ action: 'inspect', variables: ['ls_head', 'lv_nothing'], stack: true });
    expect(json).toMatchObject({
      variables: [{ name: 'LS_HEAD', kind: 'structure', components: { VBELN: '0000004711', KUNNR: 'CUST01' } }],
      notVisible: ['LV_NOTHING'],
      stack: [{ procedure: 'METHOD GET_TOTAL', line: 9 }],
      hiddenSystemFrames: 1,
      position: { line: 9 },
    });
    const frame = await move({ action: 'inspect' });
    expect(frame.json?.variables.map((variable: { name: string }) => variable.name)).toEqual([
      'LV_TOTAL',
      'LS_HEAD',
      'LT_ITEMS',
    ]);
    await move({ action: 'end' });
  });

  it('continues from stop to stop, and ends with the program', async () => {
    installFakeSap({ hit: true, execution: [at(9), at(11)] });
    const started = await start({ breakpoints: [{ line: 9 }, { line: 11 }], variables: ['LV_TOTAL'] });
    expect(started.json?.stop).toMatchObject({ stop: 1, at: line(9) });

    const next = await move({ action: 'continue' });
    expect(next.json).toMatchObject({ stop: { stop: 2, at: line(11) }, position: { line: 11 } });

    const last = await move({ action: 'continue' });
    expect(last.json).toMatchObject({
      ended: true,
      reason: 'the program ran to its end without another stop',
      release: { released: true, via: 'continue' },
      stops: 2,
      breakpoints: [{ hits: 1 }, { hits: 1 }],
      trigger: { status: 'completed' },
    });
    expect(openDebugSessionId()).toBeUndefined();

    const after = await move({ action: 'step' });
    expect(after.result.isError).toBe(true);
    expect(after.text).toContain('Debug session S1 has ended');
  });

  it('runs to a line of the source the program stands in', async () => {
    const { calls } = installFakeSap({ hit: true });
    await start({ line: 9 });
    const { json } = await move({ action: 'continue', toLine: 17, variables: ['LV_TOTAL'] });
    expect(json).toMatchObject({ position: { line: 17 }, values: { LV_TOTAL: '47' } });
    expect(json).not.toHaveProperty('stop');
    expect(stepCalls(calls, 'stepRunToLine')[0]?.query.get('uri')).toBe(`${MAIN}#start=17`);
    await move({ action: 'end' });
  });

  it('takes a step that runs into a breakpoint as a stop of it', async () => {
    installFakeSap({ hit: true, execution: [at(9), at(11)] });
    await start({ breakpoints: [{ line: 9 }, { line: 11 }] });
    const { json } = await move({ action: 'step', count: 5 });
    expect(json?.steps.map((step: { line: number }) => step.line)).toEqual([10, 11]);
    expect(json?.steps.at(-1)).toMatchObject({ breakpoint: line(11) });
    expect(json?.stop).toMatchObject({ stop: 2, at: line(11) });
    await move({ action: 'end' });
  });

  it('aborts the program on request', async () => {
    const fake = installFakeSap({ hit: true });
    await start({ line: 9 });
    const { json } = await move({ action: 'end', terminate: true });
    expect(json).toMatchObject({
      ended: true,
      reason: 'the program was terminated on request',
      release: { released: true, via: 'terminate' },
    });
    expect(fake.terminated()).toBe(true);
  });

  it('ends the session when a step ends the program', async () => {
    installFakeSap({ hit: true, endsAfterSteps: 1 });
    await start({ line: 9 });
    expect((await move({ action: 'step' })).json).toMatchObject({ position: { line: 10 } });
    const { json } = await move({ action: 'step' });
    expect(json).toMatchObject({ ended: true, reason: 'the program ran to its end', release: { via: 'continue' } });
    expect(openDebugSessionId()).toBeUndefined();
  });

  it('answers like a one-shot capture when the program ends before the session could start', async () => {
    installFakeSap({ hit: true, endsAfterSteps: 2 });
    const { json } = await start({ line: 9, steps: 5 });
    expect(json).not.toHaveProperty('session');
    expect(json).toMatchObject({
      hit: true,
      stops: [{ stop: 1, steps: [{ step: 1 }, { step: 2 }, { step: 3, ended: true }] }],
      release: { released: true, via: 'continue' },
    });
    expect(openDebugSessionId()).toBeUndefined();
  });

  it('releases a session nobody drives any more', async () => {
    const { calls } = installFakeSap({ hit: true });
    await start({ line: 9 }, withLimits({ idleSeconds: 0.05 }));
    // Wait without a call: every call starts the idle time over.
    await vi.waitFor(() => expect(openDebugSessionId()).toBeUndefined());
    await vi.waitFor(async () => {
      const late = await move({ action: 'step' });
      expect(late.text).toContain('Debug session S1 has ended');
      expect(late.text).toContain('no call came for 0.05 s');
    });
    expect(stepCalls(calls, 'stepContinue').length).toBeGreaterThan(0);
  });

  it('releases a session at its time limit', async () => {
    installFakeSap({ hit: true });
    await start({ line: 9 }, withLimits({ sessionSeconds: 0.05 }));
    await vi.waitFor(() => expect(openDebugSessionId()).toBeUndefined());
    await vi.waitFor(async () => {
      expect((await move({ action: 'inspect' })).text).toContain('it reached its limit of 0.05 s');
    });
  });

  it('releases the open session when the server stops', async () => {
    const { calls } = installFakeSap({ hit: true });
    await start({ line: 9 });
    await stopAllDebugging('the server was stopped');
    expect(openDebugSessionId()).toBeUndefined();
    expect(stepCalls(calls, 'stepContinue').length).toBeGreaterThan(0);
    expect((await move({ action: 'inspect' })).text).toContain('the server was stopped');
  });

  it('keeps the SAP user to itself while it is open', async () => {
    installFakeSap({ hit: true });
    await start({ line: 9 });
    const capture = await call('abap_debug', { type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(capture.result.isError).toBe(true);
    expect(capture.text).toContain('Your interactive debug session S1 is still open');
    expect((await start({ line: 9 })).text).toContain('Your interactive debug session S1 is still open');
    expect((await move({ action: 'inspect', session: 's9' })).text).toBe('There is no debug session S9: yours is S1.');
    await move({ action: 'end', session: 's1' });

    installFakeSap({ hit: true });
    expect((await call('abap_debug', { type: 'CLAS', name: 'ZCL_ORDER', line: 9 })).json).toMatchObject({ hit: true });
  });

  it("keeps each user's session to that user on a shared server", async () => {
    installFakeSap({ hit: true });
    const alice = await call(
      'abap_debug',
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9, interactive: true },
      createConnection(),
      'alice',
    );
    expect(alice.json).toMatchObject({ session: 'S1' });
    expect(openDebugSessionId('alice')).toBe('S1');
    // Bob neither sees nor drives it, even by its id.
    expect((await move({ action: 'step', session: 'S1' }, 'bob')).text).toBe(
      'No interactive debug session is open. Start one with abap_debug and interactive: true.',
    );
    expect((await move({ action: 'end' }, 'bob')).result.isError).toBe(true);
    expect(openDebugSessionId('alice')).toBe('S1');
    // The SAP user is shared here (one technical user): Bob's capture waits for Alice's session.
    const bobCapture = await call(
      'abap_debug',
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9 },
      createConnection(),
      'bob',
    );
    expect(bobCapture.text).toContain('An interactive debug session (S1) for SAP user ADMIN is open');
    expect((await move({ action: 'end' }, 'alice')).json).toMatchObject({ ended: true });
  });

  it("says when no session is open, and checks each action's fields before anything reaches SAP", async () => {
    const { calls } = installFakeSap();
    expect((await move({ action: 'step' })).text).toBe(
      'No interactive debug session is open. Start one with abap_debug and interactive: true.',
    );
    expect((await move({ action: 'inspect', count: 3 })).text).toContain(
      'count does not apply to action "inspect" (it takes variables, stack, maxResultKB)',
    );
    expect((await move({ action: 'end', toLine: 3 })).text).toContain('toLine does not apply to action "end"');
    expect(calls).toHaveLength(0);
  });
});

describe('abap_debug_session — work that outlasts its call', () => {
  it('answers a start still waiting for its stop with the session id; wait gives the first stop', async () => {
    installFakeSap({ hit: true, stopAfterMs: 900 });
    const started = await start({ line: 9 }, withLimits({ callSeconds: 0.5 }));
    expect(started.result.isError).toBeFalsy();
    expect(started.json).toMatchObject({
      session: 'S1',
      running: true,
      doing: 'waiting for the run to stop at a breakpoint (0 of 60 s)',
    });
    expect(started.json?.next).toContain('action "wait"');
    expect((await move({ action: 'step' })).text).toContain('Session S1 is still starting');

    const first = await move({ action: 'wait' });
    expect(first.json).toMatchObject({ hit: true, session: 'S1', stop: { stop: 1 }, position: { line: 9 } });
    expect(openDebugSessionId()).toBe('S1');
    // Its answer was given: wait now says where the program stands.
    expect((await move({ action: 'wait' })).json).toMatchObject({
      session: 'S1',
      action: 'wait',
      running: false,
      position: { line: 9 },
    });
    expect((await move({ action: 'end' })).json).toMatchObject({ ended: true, release: { released: true } });
  });

  it('lets a continue outlast its call: wait gives the next stop', async () => {
    installFakeSap({ hit: true, execution: [at(9), at(11)], continueAfterMs: 900 });
    await start({ breakpoints: [{ line: 9 }, { line: 11 }] }, withLimits({ callSeconds: 0.5 }));
    const going = await move({ action: 'continue' });
    expect(going.json).toMatchObject({ session: 'S1', running: true, doing: 'running to the next stop' });
    // The program runs meanwhile: no other move.
    expect((await move({ action: 'inspect' })).text).toBe(
      'Session S1 is still busy (running to the next stop): action "wait" waits for the answer, action "end" ends the session.',
    );
    const next = await move({ action: 'wait' });
    expect(next.json).toMatchObject({ session: 'S1', action: 'continue', stop: { stop: 2, at: line(11) } });
    expect((await move({ action: 'end' })).json).toMatchObject({ ended: true, stops: 2 });
  });

  it('ends a session while its continue still waits, stopping the continue first', async () => {
    installFakeSap({ hit: true, execution: [at(9), at(11)], continueAfterMs: 60_000 });
    await start({ breakpoints: [{ line: 9 }, { line: 11 }] }, withLimits({ callSeconds: 0.5 }));
    expect((await move({ action: 'continue' })).json).toMatchObject({ running: true });
    const end = await move({ action: 'end' });
    expect(end.json).toMatchObject({
      session: 'S1',
      action: 'end',
      ended: true,
      reason: 'the session was ended on request',
      release: { released: true, via: 'continue' },
    });
    expect(openDebugSessionId()).toBeUndefined();
  });

  it('releases a session whose last answer nobody picked up once the idle time is over', async () => {
    installFakeSap({ hit: true, execution: [at(9), at(11)], continueAfterMs: 600 });
    await start({ breakpoints: [{ line: 9 }, { line: 11 }] }, withLimits({ callSeconds: 0.5, idleSeconds: 0.3 }));
    expect((await move({ action: 'continue' })).json).toMatchObject({ running: true });
    // The idle time runs from the end of the move, not from the call that started it.
    await vi.waitFor(() => expect(openDebugSessionId()).toBeUndefined(), { timeout: 3000 });
    const late = await move({ action: 'wait' });
    expect(late.json).toMatchObject({ session: 'S1', ended: true, release: { released: true } });
    expect(late.json?.reason).toContain('no call came for 0.3 s');
  });

  it('caps the interactive sessions open at once on the server', async () => {
    installFakeSap({ hit: true });
    const limited = withLimits({ maxSessions: 1 });
    const alice = await call(
      'abap_debug',
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9, interactive: true },
      limited,
      'alice',
    );
    expect(alice.json).toMatchObject({ session: 'S1' });
    const bob = await call(
      'abap_debug',
      { type: 'CLAS', name: 'ZCL_ORDER', line: 9, interactive: true },
      { ...createConnection({}, 'bob'), limits: limited.limits },
      'bob',
    );
    expect(bob.result.isError).toBe(true);
    expect(bob.text).toBe(
      'Interactive debug sessions open on this server: 1 of 1 (ABAP_DEBUGGER_MAX_SESSIONS). Each can hold an SAP work process while its program is stopped — try again when one has ended.',
    );
    expect((await move({ action: 'end' }, 'alice')).json).toMatchObject({ ended: true });
  });
});

describe('abap_debug — interactive, non-exclusive debugging', () => {
  it('holds nothing when SAP attaches non-exclusively', async () => {
    installFakeSap({ hit: true, nonExclusive: true });
    const { json } = await start({ line: 9 });
    expect(json).not.toHaveProperty('session');
    expect(json).toMatchObject({ hit: true, attached: true, release: { released: true } });
    expect(json?.error).toContain('non-exclusive mode');
    expect(openDebugSessionId()).toBeUndefined();
  });
});

describe('abap_debug_session — watchpoints', () => {
  it('sets a watchpoint where the program stands; continue then stops where the variable changes', async () => {
    const { calls } = installFakeSap({
      hit: true,
      execution: [at(9), at(12)],
      watchChanges: [{ index: 1, variable: 'LV_TOTAL' }],
    });
    await start({ line: 9 });
    const watch = await move({ action: 'watch', variable: 'lv_total' });
    expect(watch.json).toMatchObject({
      session: 'S1',
      action: 'watch',
      watchpoint: { variable: 'LV_TOTAL', status: 'set', hits: 0 },
      position: { line: 9 },
    });
    const next = await move({ action: 'continue' });
    expect(next.json).toMatchObject({
      stop: { stop: 2, at: 'watchpoint LV_TOTAL', changed: { from: '39', to: '42' } },
      position: { line: 12 },
    });
    const end = await move({ action: 'end' });
    expect(end.json).toMatchObject({
      ended: true,
      watchpoints: [{ variable: 'LV_TOTAL', status: 'set', hits: 1 }],
      release: { released: true, via: 'continue' },
    });
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/watchpoints/WP-LV_TOTAL')).toHaveLength(1);
    expect((await move({ action: 'watch' })).text).toContain('watch needs variable.');
  });
});

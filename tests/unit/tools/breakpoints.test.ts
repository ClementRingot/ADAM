/**
 * abap_breakpoints (src/tools/breakpoints.ts) and the records of armed breakpoints behind it
 * (src/tools/debug-leftovers.ts) — over a real AdtHttpClient and the fake SAP of tests/helpers/fake-sap.ts.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callTool } from '../../../src/server.js';
import type { SapConnection } from '../../../src/tools/connection.js';
import { setDebugTimingsForTests } from '../../../src/tools/debug-capture.js';
import { setStateDirForTests } from '../../../src/tools/debug-leftovers.js';
import { DEFAULT_LIMITS } from '../../../src/tools/debug-limits.js';
import { resetDebuggingForTests } from '../../../src/tools/debug-registry.js';
import { openDebugSessionId } from '../../../src/tools/debug-session.js';
import { createConnection, installFakeSap, named } from '../../helpers/fake-sap.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

async function call(
  tool: string,
  args: Record<string, unknown>,
  owner?: string,
  conn: SapConnection = createConnection(),
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

let dir: string;

/** The record a capture leaves when its server process dies before it removed its breakpoints. */
function leftover(terminalId = 'DEADBEEF', user = 'ADMIN'): void {
  const record = {
    system: createConnection().http.systemKey,
    user,
    terminalId,
    ideId: 'IDE1',
    armedAt: '2026-10-27T08:00:00.000Z',
    host: hostname(),
    // Above Linux's largest pid: no process has it.
    pid: 4_195_304,
  };
  writeFileSync(join(dir, `armed-${terminalId}.json`), JSON.stringify(record));
}

/** The external breakpoint syncs, with the terminal each was for. */
const externalSyncs = (calls: ReturnType<typeof installFakeSap>['calls']) =>
  named(calls, 'POST', '/sap/bc/adt/debugger/breakpoints')
    .filter((c) => c.body.includes('scope="external"'))
    .map((c) => ({ terminal: /terminalId="([^"]+)"/.exec(c.body)?.[1], items: c.body.includes('<breakpoint ') }));

beforeAll(() => {
  setDebugTimingsForTests({ armDelayMs: 0, triggerSettleMs: 200 });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adam-breakpoints-'));
  setStateDirForTests(dir);
});

afterEach(async () => {
  await resetDebuggingForTests();
  mockFetch.mockReset();
  rmSync(dir, { recursive: true, force: true });
});

describe('abap_breakpoints', () => {
  it("records a capture's identity while its breakpoints may be armed, and drops it once they are gone", async () => {
    installFakeSap(mockFetch, { hit: true, stopAfterMs: 900 });
    const slow = { ...createConnection(), limits: { ...DEFAULT_LIMITS, callSeconds: 0.5 } };
    const started = await call('abap_debug', { type: 'CLAS', name: 'ZCL_ORDER', line: 9 }, undefined, slow);
    expect(started.json).toMatchObject({ session: 'S1', running: true });
    expect(readdirSync(dir)).toHaveLength(1);

    // A capture in progress is no leftover: it listens itself.
    const listed = await call('abap_breakpoints', { action: 'list' });
    expect(listed.json).toMatchObject({
      user: 'ADMIN',
      yours: { session: 'S1', kind: 'capture (one-shot)' },
      leftovers: [],
      listener: 'your capture S1, on this server',
    });
    expect(listed.json).not.toHaveProperty('next');

    expect((await call('abap_debug_session', { action: 'wait' })).json).toMatchObject({ hit: true });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('lists what a capture whose server process died left behind, and removes it', async () => {
    leftover();
    const { calls } = installFakeSap(mockFetch);
    const listed = await call('abap_breakpoints', { action: 'list' });
    expect(listed.json).toEqual({
      user: 'ADMIN',
      leftovers: [{ armedAt: '2026-10-27T08:00:00.000Z', by: 'a capture whose server process ended' }],
      listener: 'none',
      note: expect.stringContaining('SAP has no request that lists every breakpoint of a user'),
      next: 'abap_breakpoints with action "delete" removes the leftovers; listener: true also removes the listener.',
    });

    const removed = await call('abap_breakpoints', { action: 'delete' });
    expect(removed.json).toEqual({ user: 'ADMIN', leftoversRemoved: 1 });
    // One empty full sync for the dead capture's identity replaces its breakpoints with none.
    expect(externalSyncs(calls)).toEqual([{ terminal: 'DEADBEEF', items: false }]);
    expect(readdirSync(dir)).toEqual([]);
    expect((await call('abap_breakpoints', { action: 'list' })).json?.leftovers).toEqual([]);
  });

  it('has the next capture of the same user remove the leftovers before it arms its own', async () => {
    leftover();
    leftover('OTHERUSER', 'SOMEONE');
    const { calls } = installFakeSap(mockFetch, { hit: true });
    const { json } = await call('abap_debug', { type: 'CLAS', name: 'ZCL_ORDER', line: 9 });
    expect(json).toMatchObject({ hit: true });
    expect(json?.warnings).toContain('Removed the breakpoints 1 earlier capture(s) of this user left behind.');
    const syncs = externalSyncs(calls);
    expect(syncs[0]).toEqual({ terminal: 'DEADBEEF', items: false });
    expect(syncs.slice(1).every((sync) => sync.terminal !== 'DEADBEEF' && sync.terminal !== 'OTHERUSER')).toBe(true);
    // Another SAP user's record is not this capture's to remove.
    expect(readdirSync(dir)).toEqual(['armed-OTHERUSER.json']);
  });

  it("reports another debugger's listener, and removes it on request", async () => {
    const { calls } = installFakeSap(mockFetch, { conflict: true });
    const listed = await call('abap_breakpoints', { action: 'list' });
    expect(listed.json).toMatchObject({ listener: 'another debugger: ADMIN is debugged in Eclipse' });
    expect(listed.json?.next).toContain('listener: true');

    const removed = await call('abap_breakpoints', { action: 'delete', listener: true });
    expect(removed.json).toEqual({
      user: 'ADMIN',
      leftoversRemoved: 0,
      listener: 'removed (it was: ADMIN is debugged in Eclipse)',
    });
    const deletes = named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.query.get('requestUser')).toBe('ADMIN');
  });

  it("ends the caller's own session, and keeps the listener another user's session needs", async () => {
    const { calls } = installFakeSap(mockFetch, { hit: true });
    const alice = await call('abap_debug', { type: 'CLAS', name: 'ZCL_ORDER', line: 9, interactive: true }, 'alice');
    expect(alice.json).toMatchObject({ session: 'S1' });

    // Bob debugs as the same SAP user (a shared technical user): Alice's listener stays.
    const bob = await call('abap_breakpoints', { action: 'delete', listener: true }, 'bob');
    expect(bob.json).toEqual({
      user: 'ADMIN',
      leftoversRemoved: 0,
      listener:
        'kept: a capture or session of another user of this server debugs the same SAP user — removing its listener would break it',
    });
    expect(openDebugSessionId('alice')).toBe('S1');

    const listed = await call('abap_breakpoints', { action: 'list' }, 'alice');
    expect(listed.json).toMatchObject({
      yours: {
        session: 'S1',
        kind: 'interactive session',
        state: 'waiting',
        breakpoints: [{ status: 'set', hits: 1 }],
      },
      listener: 'your interactive session S1, on this server',
    });

    const ended = await call('abap_breakpoints', { action: 'delete' }, 'alice');
    expect(ended.json).toMatchObject({ ended: { session: 'S1', ended: true, release: { released: true } } });
    expect(openDebugSessionId('alice')).toBeUndefined();
    expect(named(calls, 'DELETE', '/sap/bc/adt/debugger/listeners')).toHaveLength(1);
  });

  it('checks its input before anything reaches SAP', async () => {
    const { calls } = installFakeSap(mockFetch);
    expect((await call('abap_breakpoints', { action: 'list', listener: true })).text).toContain(
      'listener applies to action "delete" only.',
    );
    expect(calls).toHaveLength(0);
  });
});

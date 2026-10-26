/** abap_source and abap_search through the MCP tool call, over a fake SAP (mocked undici fetch). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdtHttpClient } from '../../../src/adt/http.js';
import { callTool } from '../../../src/server.js';
import { mockResponse } from '../../helpers/mock-fetch.js';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: mockFetch,
}));

const CLASS_SOURCE = [
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
  'ENDCLASS.',
  '',
].join('\r\n');

const SEARCH_XML = `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt/functions/groups/zfg_order/fmodules/z_order_total" adtcore:type="FUGR/FF" adtcore:name="Z_ORDER_TOTAL (Function Module)" adtcore:packageName="ZORDER" adtcore:description="Order total"/><adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_order" adtcore:type="CLAS/OC" adtcore:name="ZCL_ORDER" adtcore:packageName="ZORDER" adtcore:description="Orders &amp; totals"/></adtcore:objectReferences>`;

function installFakeSap(): Array<{ path: string; query: URLSearchParams }> {
  const calls: Array<{ path: string; query: URLSearchParams }> = [];
  mockFetch.mockImplementation(async (url: string) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: parsed.searchParams });
    if (parsed.pathname === '/sap/bc/adt/oo/classes/zcl_order/source/main') return mockResponse(200, CLASS_SOURCE);
    if (parsed.pathname === '/sap/bc/adt/functions/groups/zfg_order/fmodules/z_order_total/source/main') {
      return mockResponse(200, 'FUNCTION z_order_total.\n  ev_total = 42.\nENDFUNCTION.');
    }
    if (parsed.pathname === '/sap/bc/adt/repository/informationsystem/search') return mockResponse(200, SEARCH_XML);
    if (parsed.pathname === '/sap/bc/adt/programs/programs/zbig/source/main') {
      return mockResponse(200, Array.from({ length: 2000 }, (_, index) => `WRITE ${index + 1}.`).join('\n'));
    }
    return mockResponse(404, 'not found');
  });
  return calls;
}

const connection = () => ({ http: new AdtHttpClient({ baseUrl: 'http://sap:8000', username: 'u', password: 'p' }) });

async function call(name: string, args: Record<string, unknown>) {
  const result = await callTool({ connection: connection(), problems: [] }, name, args);
  return { result, text: result.content[0]?.text ?? '' };
}

afterEach(() => mockFetch.mockReset());

describe('abap_source', () => {
  it('numbers the active source exactly as breakpoints address it', async () => {
    const calls = installFakeSap();
    const { result, text } = await call('abap_source', { type: 'clas', name: 'zcl_order' });
    expect(result.isError).toBeFalsy();
    expect(text.split('\n')).toEqual([
      'CLAS ZCL_ORDER — main source (active), lines 1-12 of 12.',
      'abap_debug breakpoints item for line N: {"type":"CLAS","name":"ZCL_ORDER","line":N}',
      ' 1: CLASS zcl_order DEFINITION PUBLIC FINAL CREATE PUBLIC.',
      ' 2:   PUBLIC SECTION.',
      ' 3:     METHODS get_total RETURNING VALUE(rv_total) TYPE i.',
      ' 4: ENDCLASS.',
      ' 5: ',
      ' 6: CLASS zcl_order IMPLEMENTATION.',
      ' 7:   METHOD get_total.',
      ' 8:     DATA lv_total TYPE i.',
      ' 9:     lv_total = 42.',
      '10:     rv_total = lv_total.',
      '11:   ENDMETHOD.',
      '12: ENDCLASS.',
    ]);
    expect(calls[0]?.query.get('version')).toBe('active');
  });

  it('shows one method, numbered as in the whole source', async () => {
    installFakeSap();
    const { text } = await call('abap_source', { type: 'CLAS', name: 'ZCL_ORDER', method: 'get_total' });
    expect(text).toContain('method get_total, lines 7-11 of 12.');
    expect(text).toContain(' 7:   METHOD get_total.');
    expect(text).toContain('11:   ENDMETHOD.');
    expect(text).not.toContain('12: ENDCLASS.');
  });

  it('greps with one line of context, marking the matches', async () => {
    installFakeSap();
    const { text } = await call('abap_source', { type: 'CLAS', name: 'ZCL_ORDER', grep: 'lv_total =|^class' });
    expect(text).toContain('lines 1-12 of 12, 3 matching.');
    expect(text.split('\n').slice(2)).toEqual([
      ' 1: CLASS zcl_order DEFINITION PUBLIC FINAL CREATE PUBLIC.',
      ' 2-   PUBLIC SECTION.',
      '--',
      ' 5- ',
      ' 6: CLASS zcl_order IMPLEMENTATION.',
      ' 7-   METHOD get_total.',
      ' 8-     DATA lv_total TYPE i.',
      ' 9:     lv_total = 42.',
      '10-     rv_total = lv_total.',
    ]);
  });

  it("reads a function module from its group, found by the module's URI", async () => {
    const calls = installFakeSap();
    const { text } = await call('abap_source', { type: 'FUNC', name: 'Z_ORDER_TOTAL', lineStart: 2, lineEnd: 2 });
    expect(text).toContain('FUNC Z_ORDER_TOTAL — main source (active), lines 2-2 of 3.');
    expect(text).toContain('2:   ev_total = 42.');
    expect(calls.map((c) => c.path)).toEqual([
      '/sap/bc/adt/repository/informationsystem/search',
      '/sap/bc/adt/functions/groups/zfg_order/fmodules/z_order_total/source/main',
    ]);
  });

  it('caps a long source and says how to narrow it', async () => {
    installFakeSap();
    const { text } = await call('abap_source', { type: 'PROG', name: 'ZBIG' });
    expect(text).toContain('lines 1-2000 of 2000.');
    expect(text).toContain('1500: WRITE 1500.');
    expect(text).not.toContain('1501: WRITE 1501.');
    expect(text).toContain('1500 lines shown; narrow with lineStart/lineEnd, method or grep');
  });

  it('refuses what it cannot read before calling SAP', async () => {
    installFakeSap();
    expect((await call('abap_source', { type: 'INTF', name: 'ZIF_X' })).text).toContain(
      'type must be CLAS, PROG or FUNC',
    );
    expect((await call('abap_source', { type: 'PROG', name: 'ZX', method: 'm' })).text).toContain(
      'only supported for type="CLAS"',
    );
    expect((await call('abap_source', { type: 'PROG', name: 'ZX', grep: '(' })).text).toContain(
      'grep must be a valid regular expression',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('abap_search', () => {
  it('returns exact names and types, undecorated', async () => {
    const calls = installFakeSap();
    const { text } = await call('abap_search', { query: 'z*order*', objectType: 'clas', maxResults: 5 });
    expect(JSON.parse(text)).toEqual([
      { type: 'FUGR/FF', name: 'Z_ORDER_TOTAL', package: 'ZORDER', description: 'Order total' },
      { type: 'CLAS/OC', name: 'ZCL_ORDER', package: 'ZORDER', description: 'Orders & totals' },
    ]);
    expect(Object.fromEntries(calls[0]?.query ?? [])).toMatchObject({
      operation: 'quickSearch',
      query: 'Z*ORDER*',
      maxResults: '5',
      objectType: 'CLAS',
    });
  });
});

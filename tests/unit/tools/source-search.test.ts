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

const BINDING_XML = `<?xml version="1.0" encoding="utf-8"?><srvb:serviceBinding xmlns:srvb="http://www.sap.com/adt/ddic/ServiceBindings" xmlns:adtcore="http://www.sap.com/adt/core" srvb:published="true" srvb:bindingCreated="true" adtcore:name="ZUI_TRAVEL_O4" adtcore:type="SRVB/SVB" adtcore:description="Travel UI"><adtcore:packageRef adtcore:name="ZTRAVEL"/><srvb:services srvb:name="ZUI_TRAVEL_O4"><srvb:content srvb:version="0001" srvb:releaseState="NOT_RELEASED"><srvb:serviceDefinition adtcore:uri="/sap/bc/adt/ddic/srvd/sources/zui_travel" adtcore:type="SRVD/SRV" adtcore:name="ZUI_TRAVEL"/></srvb:content></srvb:services><srvb:binding srvb:type="ODATA" srvb:version="V4" srvb:category="0"><srvb:implementation adtcore:name="ZUI_TRAVEL_O4"/></srvb:binding></srvb:serviceBinding>`;

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
    if (parsed.pathname === '/sap/bc/adt/businessservices/bindings/zui_travel_o4')
      return mockResponse(200, BINDING_XML);
    if (parsed.pathname === '/sap/bc/adt/ddic/srvd/sources/zui_travel/source/main') {
      return mockResponse(
        200,
        "@EndUserText.label: 'Travel'\ndefine service ZUI_TRAVEL {\n  expose ZC_TRAVEL as Travel;\n  expose ZC_BOOKING as Booking;\n}",
      );
    }
    if (parsed.pathname === '/sap/bc/adt/bo/behaviordefinitions/zr_travel/source/main') {
      return mockResponse(
        200,
        'managed implementation in class zbp_r_travel unique;\nstrict ( 2 );\n\ndefine behavior for ZR_TRAVEL alias Travel\n{\n  create;\n}',
      );
    }
    // As on the BTP trial: the projection view, its projection BDEF, the base view's BDEF with a pool per entity.
    if (parsed.pathname === '/sap/bc/adt/ddic/ddl/sources/zc_travel/source/main') {
      return mockResponse(
        200,
        "@EndUserText.label: 'Travel'\ndefine root view entity ZC_Travel\n  provider contract transactional_query\n  as projection on ZR_Travel\n{\n  key TravelUUID\n}",
      );
    }
    if (parsed.pathname === '/sap/bc/adt/bo/behaviordefinitions/zc_travel/source/main') {
      return mockResponse(
        200,
        'projection;\nstrict(2);\nuse draft;\n\ndefine behavior for ZC_Travel alias Travel\n{\n  use create;\n}',
      );
    }
    if (parsed.pathname === '/sap/bc/adt/programs/includes/zorder_top/source/main') {
      return mockResponse(200, 'DATA gv_total TYPE i.');
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

  it("follows a Fiori app's service binding to its service definition, entities and behavior pool", async () => {
    const calls = installFakeSap();
    const binding = await call('abap_source', { type: 'SRVB/SVB', name: 'zui_travel_o4' });
    expect(binding.text.split('\n')).toEqual([
      'SRVB ZUI_TRAVEL_O4 — service binding (OData V4 UI), published, package ZTRAVEL.',
      'Description: Travel UI',
      'Service ZUI_TRAVEL_O4, version 0001: service definition ZUI_TRAVEL (NOT_RELEASED)',
      'Next: abap_source {"type":"SRVD","name":"ZUI_TRAVEL"} — the entities it exposes.',
    ]);
    expect(calls[0]?.path).toBe('/sap/bc/adt/businessservices/bindings/zui_travel_o4');

    const definition = await call('abap_source', { type: 'SRVD', name: 'ZUI_TRAVEL' });
    expect(definition.text).toContain('SRVD ZUI_TRAVEL — source (active), lines 1-5 of 5.');
    expect(definition.text).toContain('Exposes ZC_TRAVEL as Travel, ZC_BOOKING as Booking.');
    expect(definition.text).not.toContain('abap_debug breakpoints item');
    expect(calls[1]?.query.get('version')).toBe('active');

    const behavior = await call('abap_source', { type: 'BDEF', name: 'ZR_TRAVEL' });
    expect(behavior.text).toContain(
      'Behavior pool ZBP_R_TRAVEL: abap_source {"type":"CLAS","name":"ZBP_R_TRAVEL","include":"implementations"} shows its handler classes (lhc_*).',
    );
    expect(behavior.text).toContain('1: managed implementation in class zbp_r_travel unique;');
  });

  it('leads from a projection view and its projection BDEF to the base behavior definition', async () => {
    installFakeSap();
    const view = await call('abap_source', { type: 'DDLS', name: 'ZC_TRAVEL' });
    expect(view.text).toContain(
      'A projection on ZR_TRAVEL: abap_source {"type":"BDEF","name":"ZR_TRAVEL"} names the behavior pool, if the entity has behavior.',
    );
    const projection = await call('abap_source', { type: 'BDEF', name: 'ZC_TRAVEL' });
    expect(projection.text).toContain('A projection: its behavior pool is named in the behavior definition');
  });

  it('reads an include, saying breakpoints go elsewhere', async () => {
    installFakeSap();
    const { text } = await call('abap_source', { type: 'PROG/I', name: 'ZORDER_TOP' });
    expect(text.split('\n')).toEqual([
      'INCL ZORDER_TOP — source (active), lines 1-1 of 1.',
      'No breakpoints in includes yet: set them in the class, program or function module that runs this code.',
      '1: DATA gv_total TYPE i.',
    ]);
  });

  it('refuses what it cannot read before calling SAP', async () => {
    installFakeSap();
    expect((await call('abap_source', { type: 'TABL', name: 'ZTAB' })).text).toContain(
      'type must be CLAS, PROG, FUNC, INTF, INCL, DDLS, DCLS, DDLX, BDEF, SRVD or SRVB (got "TABL")',
    );
    expect((await call('abap_source', { type: 'SRVB', name: 'ZUI_X', grep: 'x' })).text).toContain(
      'A service binding has no source lines',
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

/** What the quick search finds for a service's name: the binding and the definition among the objects SAP generates. */
const SERVICE_OBJECTS: Array<[type: string, name: string, pkg: string]> = [
  ['IWSG', 'ZUI_TRAVEL_O4_0001_G4BA', 'ZTRAVEL'],
  ['SRVB/SVB', 'ZUI_TRAVEL_O4', 'ZTRAVEL'],
  ['IWMO', 'ZUI_TRAVEL_O4_0001_BE', 'ZTRAVEL'],
  ['OA2S', 'ZUI_TRAVEL_O4_0001', 'ZTRAVEL'],
  ['SIA6', 'ZUI_TRAVEL_O4_0001_IBS', 'ZTRAVEL'],
  ['SRVD/SRV', 'ZUI_TRAVEL', 'ZTRAVEL'],
  ['CLAS/OC', 'ZUI_TRAVEL_HELPER', 'ZTOOLS'],
  ['PROG/P', 'ZUI_TRAVEL_REPORT', 'ZTOOLS'],
];

function installSearch(): Array<URLSearchParams> {
  const queries: URLSearchParams[] = [];
  mockFetch.mockImplementation(async (url: string) => {
    const parsed = new URL(url);
    queries.push(parsed.searchParams);
    const type = parsed.searchParams.get('objectType');
    const pattern = new RegExp(`^${(parsed.searchParams.get('query') ?? '').replace(/\*/g, '.*')}$`);
    const refs = SERVICE_OBJECTS.filter(([refType, name]) => (!type || refType.startsWith(type)) && pattern.test(name))
      .slice(0, Number(parsed.searchParams.get('maxResults')))
      .map(
        ([refType, name, pkg]) =>
          `<adtcore:objectReference adtcore:uri="/sap/bc/adt/x/${name.toLowerCase()}" adtcore:type="${refType}" adtcore:name="${name}" adtcore:packageName="${pkg}" adtcore:description="${name} text"/>`,
      );
    return mockResponse(
      200,
      `<?xml version="1.0" encoding="utf-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs.join('')}</adtcore:objectReferences>`,
    );
  });
  return queries;
}

describe('abap_search', () => {
  it('returns exact names and types, undecorated, each with what it is', async () => {
    const calls = installFakeSap();
    const { text } = await call('abap_search', { query: 'z*order*', types: ['clas'], maxResults: 5 });
    expect(JSON.parse(text)).toEqual({
      results: [
        {
          type: 'FUGR/FF',
          kind: 'function module',
          name: 'Z_ORDER_TOTAL',
          package: 'ZORDER',
          description: 'Order total',
        },
        { type: 'CLAS/OC', kind: 'class', name: 'ZCL_ORDER', package: 'ZORDER', description: 'Orders & totals' },
      ],
    });
    expect(Object.fromEntries(calls[0]?.query ?? [])).toMatchObject({
      operation: 'quickSearch',
      query: 'Z*ORDER*',
      maxResults: '50',
      objectType: 'CLAS',
    });
  });

  it("finds a service's binding and definition by the start of its name, leaving SAP's generated objects out", async () => {
    const queries = installSearch();
    const { text } = await call('abap_search', { query: 'zui_travel' });
    const json = JSON.parse(text);
    expect(json.results.map((ref: { name: string; kind?: string }) => [ref.name, ref.kind])).toEqual([
      ['ZUI_TRAVEL', 'service definition'],
      ['ZUI_TRAVEL_O4', 'service binding'],
      ['ZUI_TRAVEL_HELPER', 'class'],
      ['ZUI_TRAVEL_REPORT', 'program'],
    ]);
    expect(json.technicalLeftOut).toBe('4 generated service objects (includeTechnical: true lists them)');
    expect(json).not.toHaveProperty('more');
    expect(queries[0]?.get('query')).toBe('ZUI_TRAVEL*');

    const all = JSON.parse((await call('abap_search', { query: 'ZUI_TRAVEL', includeTechnical: true })).text);
    expect(all.results).toHaveLength(8);
    expect(all).not.toHaveProperty('technicalLeftOut');
  });

  it('searches several types and one package, and says when more objects match', async () => {
    const queries = installSearch();
    const both = JSON.parse((await call('abap_search', { query: 'ZUI_*', types: ['SRVB', 'srvd'] })).text);
    expect(both.results.map((ref: { name: string }) => ref.name)).toEqual(['ZUI_TRAVEL_O4', 'ZUI_TRAVEL']);
    expect(queries.map((query) => query.get('objectType'))).toEqual(['SRVB', 'SRVD']);

    const tools = JSON.parse((await call('abap_search', { query: 'ZUI_TRAVEL', package: 'ztool*' })).text);
    expect(tools.results.map((ref: { name: string }) => ref.name)).toEqual(['ZUI_TRAVEL_HELPER', 'ZUI_TRAVEL_REPORT']);

    const one = JSON.parse((await call('abap_search', { query: 'ZUI_TRAVEL', maxResults: 1 })).text);
    expect(one.results.map((ref: { name: string }) => ref.name)).toEqual(['ZUI_TRAVEL']);
    expect(one.more).toContain('narrow with types or package');

    const none = JSON.parse((await call('abap_search', { query: 'ZNOTHING', types: ['CLAS'] })).text);
    expect(none).toEqual({
      results: [],
      hint: 'Nothing matches ZNOTHING* of type CLAS. Try *ZNOTHING* to find the name anywhere, or fewer filters.',
    });
  });
});

/** Locating a method's lines for a `method` breakpoint (src/abap/method-locator.ts). */
import { Version } from '@abaplint/core';
import { describe, expect, it } from 'vitest';
import { abaplintVersionFor, implementationsByLineScan, locateMethod } from '../../../src/abap/method-locator.js';

const GLOBAL_CLASS = [
  'CLASS zcl_order DEFINITION PUBLIC FINAL CREATE PUBLIC.',
  '  PUBLIC SECTION.',
  '    INTERFACES zif_order.',
  '    METHODS get_total RETURNING VALUE(rv_total) TYPE i.',
  'ENDCLASS.',
  '',
  'CLASS zcl_order IMPLEMENTATION.',
  '  METHOD get_total.',
  '    rv_total = 42.',
  '  ENDMETHOD.',
  '',
  '  METHOD zif_order~process.',
  '    DATA(lv_total) = get_total( ).',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

const BEHAVIOR_POOL = [
  'CLASS lhc_travel DEFINITION INHERITING FROM cl_abap_behavior_handler.',
  '  PRIVATE SECTION.',
  '    METHODS validate FOR VALIDATE ON SAVE IMPORTING keys FOR travel~validateDates.',
  'ENDCLASS.',
  '',
  'CLASS lhc_travel IMPLEMENTATION.',
  '  METHOD validate.',
  '    READ ENTITIES OF zi_travel IN LOCAL MODE ENTITY travel ALL FIELDS WITH CORRESPONDING #( keys ) RESULT DATA(travels).',
  '  ENDMETHOD.',
  'ENDCLASS.',
  '',
  'CLASS lhc_booking DEFINITION INHERITING FROM cl_abap_behavior_handler.',
  '  PRIVATE SECTION.',
  '    METHODS validate FOR VALIDATE ON SAVE IMPORTING keys FOR booking~validateStatus.',
  'ENDCLASS.',
  '',
  'CLASS lhc_booking IMPLEMENTATION.',
  '  METHOD validate.',
  '    RETURN.',
  '  ENDMETHOD.',
  'ENDCLASS.',
].join('\n');

describe('locateMethod', () => {
  it('finds a method of the global class, by its METHOD and ENDMETHOD lines', () => {
    expect(locateMethod(GLOBAL_CLASS, 'ZCL_ORDER', 'GET_TOTAL')).toEqual({
      found: true,
      name: 'get_total',
      startLine: 8,
      endLine: 10,
    });
  });

  it('finds an interface method by its full name, or by its bare name when only one matches', () => {
    expect(locateMethod(GLOBAL_CLASS, 'ZCL_ORDER', 'zif_order~process')).toMatchObject({ found: true, startLine: 12 });
    expect(locateMethod(GLOBAL_CLASS, 'ZCL_ORDER', 'process')).toMatchObject({
      found: true,
      name: 'zif_order~process',
      endLine: 14,
    });
  });

  it('asks to qualify a name several local classes implement, and finds the qualified one', () => {
    const ambiguous = locateMethod(BEHAVIOR_POOL, 'ZBP_I_TRAVEL', 'validate');
    expect(ambiguous).toMatchObject({ found: false });
    expect(ambiguous.found === false && ambiguous.error).toContain('lhc_travel~validate');
    expect(locateMethod(BEHAVIOR_POOL, 'ZBP_I_TRAVEL', 'lhc_booking~validate')).toEqual({
      found: true,
      name: 'validate',
      startLine: 18,
      endLine: 20,
    });
  });

  it('names the implemented methods when the one asked for is missing', () => {
    const missing = locateMethod(BEHAVIOR_POOL, 'ZBP_I_TRAVEL', 'lhc_travel~nope');
    expect(missing.found === false && missing.error).toBe(
      'Method "lhc_travel~nope" not found in ZBP_I_TRAVEL. Implemented methods: lhc_travel~validate, lhc_booking~validate.',
    );
  });

  it('reads Windows line ends and a classic-ABAP grammar', () => {
    expect(locateMethod(GLOBAL_CLASS.replace(/\n/g, '\r\n'), 'ZCL_ORDER', 'get_total', Version.v750)).toMatchObject({
      found: true,
      startLine: 8,
    });
  });
});

describe('implementationsByLineScan (the fallback)', () => {
  it('lists METHOD … ENDMETHOD blocks per implementation, AMDP headers included', () => {
    const source = [
      'CLASS lcl_a IMPLEMENTATION.',
      '  METHOD run BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.',
      '    select 1 from dummy;',
      '  ENDMETHOD.',
      'ENDCLASS.',
      '* METHOD outside. is a comment',
      'CLASS lcl_b IMPLEMENTATION.',
      '  method go.',
      '  endmethod.',
      'ENDCLASS.',
    ].join('\n');
    expect(implementationsByLineScan(source)).toEqual([
      { name: 'run', containingClass: 'lcl_a', startLine: 2, endLine: 4 },
      { name: 'go', containingClass: 'lcl_b', startLine: 8, endLine: 9 },
    ]);
  });
});

describe('abaplintVersionFor', () => {
  it('maps SAP_BASIS releases to abaplint grammars, 8xx to 7.58', () => {
    expect(abaplintVersionFor('816')).toBe(Version.v758);
    expect(abaplintVersionFor('7.58')).toBe(Version.v758);
    expect(abaplintVersionFor('757')).toBe(Version.v757);
    expect(abaplintVersionFor('750')).toBe(Version.v750);
    expect(abaplintVersionFor('702')).toBe(Version.v702);
    expect(abaplintVersionFor(undefined)).toBeUndefined();
    expect(abaplintVersionFor('cloud')).toBeUndefined();
  });
});

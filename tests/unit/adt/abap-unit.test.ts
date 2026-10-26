/** ABAP Unit as a trigger (src/adt/abap-unit.ts): harmless-only runs and an honest outcome. */
import { describe, expect, it, vi } from 'vitest';
import { buildRunConfiguration, parseAunitRunResult, runUnitTests } from '../../../src/adt/abap-unit.js';
import type { AdtHttpClient } from '../../../src/adt/http.js';

const run = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit">${inner}</aunit:runResult>`;
const program = (classes: string) => `<program name="ZCL_ORDER"><testClasses>${classes}</testClasses></program>`;
const testClass = (methods: string, risk = 'harmless') =>
  `<testClass name="LTCL_ORDER" riskLevel="${risk}"><testMethods>${methods}</testMethods></testClass>`;

describe('parseAunitRunResult', () => {
  it('passes a run whose methods all passed', () => {
    const result = parseAunitRunResult(
      run(program(testClass('<testMethod name="TOTAL"/><testMethod name="EMPTY_ORDER"/>'))),
    );
    expect(result).toEqual({
      outcome: 'passed',
      summary: { tests: 2, passed: 2, failures: 0, errors: 0, skipped: 0, warnings: 0 },
    });
  });

  it('fails on a failed assertion or an exception', () => {
    const failed = parseAunitRunResult(
      run(
        program(
          testClass(
            '<testMethod name="TOTAL"><alerts><alert kind="failedAssertion" severity="critical"><title>Expected 42</title></alert></alerts></testMethod><testMethod name="OTHER"><alerts><alert kind="exception" severity="critical"><title>CX_SY_ZERODIVIDE</title></alert></alerts></testMethod>',
          ),
        ),
      ),
    );
    expect(failed.outcome).toBe('failed');
    expect(failed.summary).toMatchObject({ tests: 2, failures: 1, errors: 1, passed: 0 });
  });

  it('never calls a run passed that SAP did not prove complete', () => {
    expect(parseAunitRunResult(run('')).outcome).toBe('no_tests');
    expect(parseAunitRunResult(run(program(testClass('')))).outcome).toBe('incomplete');
    expect(parseAunitRunResult(run(program(testClass('<testMethod name="X"/>', 'dangerous')))).outcome).toBe(
      'incomplete',
    );
    const refused = parseAunitRunResult(
      run(
        program(
          testClass(
            '<testMethod name="X"><alerts><alert kind="warning" severity="tolerable"><title>Risk level DANGEROUS exceeds the upper limit</title></alert></alerts></testMethod>',
          ),
        ),
      ),
    );
    expect(refused.outcome).toBe('incomplete');
    expect(refused.summary).toMatchObject({ skipped: 1, warnings: 1 });
  });
});

describe('runUnitTests', () => {
  it('runs harmless tests only, for one object, with the ADT media types', async () => {
    const post = vi.fn().mockResolvedValue({ statusCode: 200, headers: {}, body: run('') });
    const result = await runUnitTests({ post } as unknown as AdtHttpClient, '/sap/bc/adt/oo/classes/ZCL_A&B', {
      fetchTimeoutMs: 1000,
    });
    expect(result.outcome).toBe('no_tests');
    const [path, body, contentType, headers, options] = post.mock.calls[0] as unknown[];
    expect(path).toBe('/sap/bc/adt/abapunit/testruns');
    expect(body).toBe(buildRunConfiguration('/sap/bc/adt/oo/classes/ZCL_A&B'));
    expect(body).toContain('<testRiskLevels harmless="true" dangerous="false" critical="false"/>');
    expect(body).toContain('adtcore:uri="/sap/bc/adt/oo/classes/ZCL_A&amp;B"');
    expect(contentType).toBe('application/vnd.sap.adt.abapunit.testruns.config.v4+xml');
    expect(headers).toEqual({ Accept: 'application/vnd.sap.adt.abapunit.testruns.result.v2+xml' });
    expect(options).toEqual({ fetchTimeoutMs: 1000 });
  });
});

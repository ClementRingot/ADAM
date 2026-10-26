/** The compact trace of a long step run (src/tools/debug-trace.ts). */
import { describe, expect, it } from 'vitest';
import type { DebugStackFrame } from '../../../src/adt/debugger.js';
import { compressLines, StepTrace } from '../../../src/tools/debug-trace.js';

describe('compressLines', () => {
  it('writes ascending runs of lines as ranges', () => {
    expect(compressLines([])).toBe('');
    expect(compressLines([9])).toBe('9');
    expect(compressLines([9, 10, 11, 12, 14, 13])).toBe('9-12 14 13');
  });

  it('folds a repeated block, the one covering the most steps first', () => {
    expect(compressLines([10, 11, 12, 9, 10, 11, 12, 9, 10, 11, 12, 13])).toBe('(10-12 9)×2 10-13');
    expect(compressLines([5, 5, 5, 6])).toBe('5×3 6');
    // A loop with a branch every other pass: the two-pass block is the repetition.
    const twoPasses = [3, 4, 6, 3, 5, 6];
    expect(compressLines([1, ...twoPasses, ...twoPasses, ...twoPasses, 7])).toBe('1 (3-4 6 3 5-6)×3 7');
  });

  it('keeps a long loop to a few characters', () => {
    const lines = [8, ...Array.from({ length: 1000 }, () => [9, 10, 11]).flat(), 12];
    expect(compressLines(lines)).toBe('8 (9-11)×1000 12');
  });
});

const frame = (eventName: string, line: number, depth = 1): DebugStackFrame[] => [
  {
    stackType: 'ABAP',
    program: 'ZCL_ORDER=====CP',
    include: 'ZCL_ORDER=====CM001',
    line,
    eventType: 'METHOD',
    eventName,
    systemProgram: false,
  },
  ...Array.from({ length: depth - 1 }, () => ({
    stackType: 'ABAP',
    program: 'ZREPORT',
    include: 'ZREPORT',
    eventType: 'EVENT',
    eventName: 'START-OF-SELECTION',
    systemProgram: false,
  })),
];

describe('StepTrace', () => {
  it('records the lines frame by frame, and the values only where they changed', () => {
    const trace = new StepTrace(frame('GET_TOTAL', 9));
    trace.add(1, frame('GET_TOTAL', 10)[0], 10, undefined, { LV_TOTAL: '1' });
    trace.add(2, frame('GET_TOTAL', 11)[0], 11, undefined, { LV_TOTAL: '1' });
    trace.add(3, frame('HELPER', 3, 2)[0], 3, 'entered', { LV_TOTAL: '1' });
    trace.add(4, frame('GET_TOTAL', 12)[0], 12, 'returned', { LV_TOTAL: '2' });
    trace.refuse('LV_BAD', 'Expression is not valid here');
    expect(trace.result()).toEqual({
      steps: 4,
      path: [
        { procedure: 'METHOD GET_TOTAL', program: 'ZCL_ORDER=====CP', lines: '10-11' },
        { frame: 'entered', procedure: 'METHOD HELPER', program: 'ZCL_ORDER=====CP', lines: '3' },
        { frame: 'returned', procedure: 'METHOD GET_TOTAL', program: 'ZCL_ORDER=====CP', lines: '12' },
      ],
      // A frame move starts over: the same name is another variable there.
      changes: [
        { step: 1, line: 10, values: { LV_TOTAL: '1' } },
        { step: 3, line: 3, values: { LV_TOTAL: '1' } },
        { step: 4, line: 12, values: { LV_TOTAL: '2' } },
      ],
      errors: { LV_BAD: 'Expression is not valid here' },
    });
    expect(trace.size).toBeGreaterThanOrEqual(JSON.stringify(trace.result()).length);
  });
});

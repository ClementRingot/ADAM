/**
 * A long step run as a compact trace: the lines it executed, frame by frame, with loops folded
 * (`10-12 (9-12)×300 13`), and the watched values only where they changed. A few characters per
 * step instead of a full entry, so thousands of steps fit in one result.
 */

import type { DebugStackFrame } from '../adt/debugger.js';
import type { FrameMove } from './debug-view.js';

/** Longest loop body (in steps) folded into `(…)×n`. */
const MAX_PERIOD = 40;

/** `9 10 11 12 14` → `9-12 14`: ascending runs of consecutive lines become ranges. */
function ranges(lines: readonly number[]): string {
  const parts: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let end = index;
    while (end + 1 < lines.length && (lines[end + 1] as number) === (lines[end] as number) + 1) end++;
    parts.push(end > index ? `${lines[index]}-${lines[end]}` : String(lines[index]));
    index = end + 1;
  }
  return parts.join(' ');
}

function sameBlock(lines: readonly number[], a: number, b: number, length: number): boolean {
  for (let offset = 0; offset < length; offset++) if (lines[a + offset] !== lines[b + offset]) return false;
  return true;
}

/**
 * The executed lines in order, a repeated block folded into `(block)×n` (a single line: `line×n`).
 * At each position the repetition covering the most steps wins, the shortest block on a tie.
 */
export function compressLines(lines: readonly number[]): string {
  const parts: string[] = [];
  let singles: number[] = [];
  const flush = () => {
    if (singles.length > 0) parts.push(ranges(singles));
    singles = [];
  };
  let index = 0;
  while (index < lines.length) {
    let best = { period: 0, repeats: 1 };
    for (let period = 1; period <= MAX_PERIOD && index + 2 * period <= lines.length; period++) {
      let repeats = 1;
      while (
        index + (repeats + 1) * period <= lines.length &&
        sameBlock(lines, index, index + repeats * period, period)
      ) {
        repeats++;
      }
      if (repeats > 1 && period * repeats > best.period * best.repeats) best = { period, repeats };
    }
    if (best.repeats > 1) {
      flush();
      const block = ranges(lines.slice(index, index + best.period));
      parts.push(best.period === 1 ? `${block}×${best.repeats}` : `(${block})×${best.repeats}`);
      index += best.period * best.repeats;
    } else {
      singles.push(lines[index] as number);
      index++;
    }
  }
  flush();
  return parts.join(' ');
}

interface Segment {
  frame?: FrameMove;
  procedure?: string;
  program: string;
  lines: number[];
}

/** One step's watched values, as compact as a stop's later values. */
export type StepValues = Record<string, unknown>;

/** Collects the steps of one run; `size` estimates the characters its result will take. */
export class StepTrace {
  private readonly segments: Segment[] = [];
  private readonly changes: Array<Record<string, unknown>> = [];
  private readonly last = new Map<string, string>();
  private readonly errors = new Map<string, string>();
  private chars = 40;
  steps = 0;

  constructor(start: readonly DebugStackFrame[]) {
    this.open(start[0], undefined);
  }

  private open(top: DebugStackFrame | undefined, frame: FrameMove | undefined): Segment {
    const procedure = top ? [top.eventType, top.eventName].filter(Boolean).join(' ') : '';
    const segment: Segment = {
      ...(frame ? { frame } : {}),
      ...(procedure ? { procedure } : {}),
      program: top?.program ?? '',
      lines: [],
    };
    this.segments.push(segment);
    this.chars += 60 + segment.program.length + procedure.length;
    return segment;
  }

  /**
   * One step: where it stands (`line` numbered like abap_source) and, after a frame move, the new
   * frame. `values` are the watched variables read there; only the ones that changed are kept — a
   * frame move starts over, as the same name is another variable there.
   */
  add(
    step: number,
    top: DebugStackFrame | undefined,
    line: number | undefined,
    move: FrameMove | undefined,
    values?: StepValues,
  ): void {
    this.steps = step;
    const segment = move ? this.open(top, move) : (this.segments.at(-1) as Segment);
    if (move) this.last.clear();
    if (line !== undefined) {
      segment.lines.push(line);
      this.chars += String(line).length + 1;
    }
    if (!values) return;
    const changed: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values)) {
      const rendered = JSON.stringify(value);
      if (this.last.get(name) === rendered) continue;
      this.last.set(name, rendered);
      changed[name] = value;
    }
    if (Object.keys(changed).length === 0) return;
    const entry = { step, ...(line !== undefined ? { line } : {}), values: changed };
    this.changes.push(entry);
    this.chars += JSON.stringify(entry).length + 1;
  }

  /** A variable SAP refused: reported once, then left out of the reads. */
  refuse(name: string, error: string): void {
    if (this.errors.has(name)) return;
    this.errors.set(name, error);
    this.chars += name.length + error.length + 8;
  }

  get size(): number {
    return this.chars;
  }

  result(): Record<string, unknown> {
    return {
      steps: this.steps,
      path: this.segments
        .filter((segment) => segment.lines.length > 0 || segment.frame)
        .map((segment) => ({
          ...(segment.frame ? { frame: segment.frame } : {}),
          ...(segment.procedure ? { procedure: segment.procedure } : {}),
          program: segment.program,
          lines: compressLines(segment.lines),
        })),
      ...(this.changes.length > 0 ? { changes: this.changes } : {}),
      ...(this.errors.size > 0 ? { errors: Object.fromEntries(this.errors) } : {}),
    };
  }
}

/**
 * Each test file records the breakpoints its captures arm (src/tools/debug-leftovers.ts) in a
 * directory of its own: files running side by side must not take each other's captures for leftovers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { setStateDirForTests } from '../../src/tools/debug-leftovers.js';

const dir = mkdtempSync(join(tmpdir(), 'adam-test-state-'));
setStateDirForTests(dir);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

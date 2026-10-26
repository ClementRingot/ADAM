import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    isolate: true,
    // The server logs to stderr; keep test output to failures.
    env: { ABAP_DEBUGGER_LOG_LEVEL: 'error' },
  },
});

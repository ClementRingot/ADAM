import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('propagates the package.json version to version.ts, mta.yaml and the .mtar references', () => {
  const root = mkdtempSync(join(tmpdir(), 'adam-version-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'docs'));
    copyFileSync(new URL('./sync-version.mjs', import.meta.url), join(root, 'scripts/sync-version.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'abap-debugger-mcp', version: '9.8.7' }));
    writeFileSync(join(root, 'src/version.ts'), "/** doc */\nexport const VERSION = '0.1.0';\n");
    writeFileSync(
      join(root, 'mta.yaml'),
      'ID: abap-debugger-mcp\nversion: 0.1.0\n#   cf deploy mta_archives/abap-debugger-mcp_0.1.0.mtar\n',
    );
    writeFileSync(join(root, 'docs/btp-deployment.md'), 'cf deploy mta_archives/abap-debugger-mcp_0.1.0.mtar\n');
    const run = () => execFileSync(process.execPath, [join(root, 'scripts/sync-version.mjs')]);
    run();
    const read = (path) => readFileSync(join(root, path), 'utf8');
    expect(read('src/version.ts')).toBe("/** doc */\nexport const VERSION = '9.8.7';\n");
    expect(read('mta.yaml')).toBe(
      'ID: abap-debugger-mcp\nversion: 9.8.7\n#   cf deploy mta_archives/abap-debugger-mcp_9.8.7.mtar\n',
    );
    expect(read('docs/btp-deployment.md')).toBe('cf deploy mta_archives/abap-debugger-mcp_9.8.7.mtar\n');
    const first = ['src/version.ts', 'mta.yaml', 'docs/btp-deployment.md'].map(read);
    run();
    expect(['src/version.ts', 'mta.yaml', 'docs/btp-deployment.md'].map(read)).toEqual(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

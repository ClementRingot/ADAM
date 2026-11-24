#!/usr/bin/env node
// Propagate the package.json version to every file that hard-codes it, so one
// release-train bump (`npm run changeset:version`) keeps the repository
// consistent. Idempotent: safe to run any time (`npm run sync-version`).
//
//   - src/version.ts             : `export const VERSION = 'X.Y.Z'` (the MCP handshake,
//                                  `--version`, /health; a literal because the Windows
//                                  executable carries no package.json)
//   - mta.yaml                   : the `version:` descriptor field
//   - mta.yaml, README.md,
//     docs/btp-deployment.md     : `..._X.Y.Z.mtar` archive references
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-version] invalid version in package.json: ${version}`);
  process.exit(1);
}

/** Apply regex replacements to a file; a missing file is skipped, not an error. */
function patch(relPath, ...rules) {
  const abs = join(root, relPath);
  let before;
  try {
    before = readFileSync(abs, 'utf8');
  } catch {
    console.log(`[sync-version] skip (not found): ${relPath}`);
    return;
  }
  const after = rules.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), before);
  if (after !== before) {
    writeFileSync(abs, after);
    console.log(`[sync-version] updated ${relPath} -> ${version}`);
  } else {
    console.log(`[sync-version] ${relPath} already at ${version}`);
  }
}

const mtar = [/_\d+\.\d+\.\d+\.mtar/g, `_${version}.mtar`];

patch('src/version.ts', [/(export const VERSION = ')[^']*(')/, `$1${version}$2`]);
patch('mta.yaml', [/^(version:\s*)\d+\.\d+\.\d+\S*/m, `$1${version}`], mtar);
patch('README.md', mtar);
patch('docs/btp-deployment.md', mtar);

console.log(`[sync-version] done (version ${version})`);

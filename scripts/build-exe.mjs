// One executable that needs no Node.js on the user's machine: dist/ and its dependencies bundled
// into one CommonJS script (a Node single executable application takes nothing else), injected
// into a copy of the Node binary running this script — so the executable is for this platform.
// `npm run build:exe` → build/abap-debugger-mcp(.exe).
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}build`;
const bundle = `${out}/abap-debugger-mcp.cjs`;
const blob = `${out}/sea-prep.blob`;
const seaConfig = `${out}/sea-config.json`;
const exe = `${out}/abap-debugger-mcp${process.platform === 'win32' ? '.exe' : ''}`;

if (!existsSync(`${root}dist/index.js`)) throw new Error('dist/index.js is missing: run npm run build first.');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [`${root}dist/index.js`],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${process.versions.node.split('.')[0]}`,
  legalComments: 'none',
  logLevel: 'warning',
  // Express's view engines are looked up by name at runtime; the server renders no views.
  logOverride: { 'unsupported-require-call': 'silent' },
});
// The executable runs the script as it is: no shebang line.
writeFileSync(bundle, readFileSync(bundle, 'utf8').replace(/^#!.*\r?\n/, ''));

writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

copyFileSync(process.execPath, exe);
await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);
for (const file of [blob, seaConfig]) rmSync(file);

const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
process.stdout.write(`${exe} (abap-debugger-mcp ${version}, Node ${process.versions.node})\n`);

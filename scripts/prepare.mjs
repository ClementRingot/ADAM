// npm runs `prepare` after installing from git (npx github:…), in a clone, and while Cloud Foundry
// stages the app. The first two build dist/ from the sources; the staged app carries no sources,
// only the dist/ the MTA build made, and installs no TypeScript.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url);
const keep = (why) => {
  process.stderr.write(`prepare: ${why}: keeping the prebuilt dist/.\n`);
  process.exit(0);
};
if (!existsSync(new URL('tsconfig.json', root)) || !existsSync(new URL('src', root))) keep('no sources here');
try {
  createRequire(import.meta.url).resolve('typescript/package.json');
} catch {
  keep('TypeScript is not installed (runtime dependencies only)');
}
execSync('npm run build', { stdio: 'inherit', cwd: root });

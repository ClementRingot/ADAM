# Contributing

ADAM is a single-package TypeScript project. **Requirements:** Node.js ≥ 22.12.

```bash
git clone https://github.com/ClementRingot/ADAM.git
cd ADAM
npm ci             # also builds dist/
npm run typecheck && npm run lint && npm test
```

See [docs/configuration.md](./docs/configuration.md) to run the server against a
system, and [docs/btp-deployment.md](./docs/btp-deployment.md) for SAP BTP.

## Pull requests

1. Branch off `main` (e.g. `feat/<short-topic>`); keep changes focused, with tests
   and docs alongside the code.
2. **Add a changeset** when the PR changes what ships (`src/**`, runtime
   dependencies, the lockfile's production closure, `mta.yaml`, `xs-security.json`,
   `scripts/prepare.mjs`, `scripts/build-exe.mjs`):

   ```bash
   npx changeset              # pick patch / minor / major and describe the change
   npx changeset add --empty  # a shipped change that should not release (yet)
   ```

   The `guard` CI check fails without one. Docs, tests and CI changes need none.
3. Use a [Conventional Commit](https://www.conventionalcommits.org/) title
   (`feat:`, `fix:`, `docs:`, `chore:` …). CI must be green to merge.

Releases are automatic: see [docs/RELEASE.md](./docs/RELEASE.md). Never edit the
version by hand — the version PR bumps `package.json` and mirrors it into
`src/version.ts`, `mta.yaml` and the `.mtar` references.

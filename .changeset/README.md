# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets).
See its [common questions](https://github.com/changesets/changesets/blob/main/docs/common-questions.md).

## In this repo

- **A shipped change needs a changeset.** A PR that changes what ADAM ships
  (`src/**`, `scripts/prepare.mjs`, `scripts/build-exe.mjs`, runtime deps, the
  lockfile production closure, `mta.yaml` or `xs-security.json`) must include a
  changeset, or the `guard` CI check fails. Add one with:

  ```bash
  npx changeset
  ```

- **Not releasing this (yet)?** Record it explicitly with an empty changeset —
  this satisfies the guard with a loud "no release" note:

  ```bash
  npx changeset add --empty
  ```

- **Releasing** is automatic: merging the `chore(release): version packages` PR
  that the Changesets bot maintains bumps the version, updates the changelog, and
  tags `vX.Y.Z`, which triggers `release.yml`. See [`../docs/RELEASE.md`](../docs/RELEASE.md).

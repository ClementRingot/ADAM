# @adam-mcp/server

All notable changes to this project are documented here. Entries are written by
[Changesets](https://github.com/changesets/changesets) from the `.changeset/*.md`
files each pull request adds (see [docs/RELEASE.md](./docs/RELEASE.md)); the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.1

### Patch Changes

- fc7d6f7: Update runtime dependencies (production closure): `@abaplint/core` 2.120.112, `@arc-mcp/xsuaa-auth` 1.2.2,
  `fast-xml-parser` 5.12.1, `undici` 8.13.1, and transitive SAP Cloud SDK 4.10, `@sap/xssec` 4.16, `axios`,
  `node-forge`, `follow-redirects`, and `hono` 4.13.21 / `@hono/node-server` 2.1.11 under the MCP SDK
  (minor/patch bumps; `npm audit` reports no vulnerability left in the runtime dependencies).

## 1.0.0

### Major Changes

- 74c3be0: First stable release, 1.0.0. Published to npm as `@adam-mcp/server` through Trusted Publishing (OIDC) only,
  with provenance; the bootstrap token is gone. No change to the tools, the configuration or the SAP BTP
  deployment since 0.1.1.

## 0.1.1

### Patch Changes

- 20121ab: Publish on npm as `@adam-mcp/server`, in the `adam-mcp` organization (as ROSA's `@rosa-mcp/server`),
  instead of the unscoped `abap-debugger-mcp`. The command (`abap-debugger-mcp`), the server name in the
  MCP handshake and `/health`, and the SAP BTP application are unchanged.

## 0.1.0

First version released by the release train: one-shot captures and interactive
debugging sessions of ABAP code over MCP (stdio or HTTP on SAP BTP Cloud Foundry),
plus source reading and object search. Earlier `v0.0.x` tags were development
snapshots.

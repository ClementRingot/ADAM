# ADAM

![Node.js 22.12+](https://img.shields.io/badge/node-%E2%89%A522.12-339933)
![MCP server](https://img.shields.io/badge/MCP-server-6e56cf)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**ADAM** is an [MCP](https://modelcontextprotocol.io) server that lets an AI assistant — Claude,
GitHub Copilot, Cursor… — **debug ABAP code in SAP's own debugger**: set breakpoints, run the code,
read the variables, step through it. It speaks the ABAP Development Tools (ADT) REST API, as Eclipse
does, so nothing has to be installed on the SAP system.

```text
You:     Why does ZCL_ORDER=>GET_TOTAL return 0 for order 4711?

Claude:  abap_source  {type: "CLAS", name: "ZCL_ORDER", method: "get_total"}
         abap_debug   {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, hits: 3}],
                       variables: ["LS_ITEM-NETWR", "LV_TOTAL"], steps: 2}
         → three iterations of the loop in one run, each with both values and two steps
```

## Features

- **Two modes.** *One-shot*: a single tool call arms the breakpoints, runs the code, records every
  stop and releases the program. *Interactive*: the program waits at its first stop and the assistant
  drives it — step in, over or out, continue, inspect — deciding each move from what it sees.
- **Breakpoints** on lines and methods of classes, programs and function modules (RAP behavior pools
  included), with ABAP conditions and hit counts; on messages, statement kinds (`COMMIT WORK`, …) and
  exceptions.
- **Triggers**: the object's ABAP Unit tests, an OData `GET`, or your own run of a Fiori app or report.
- **Long runs stay readable**: thousands of steps fold into a compact trace (`(9-12)×497`) with the
  values only where they changed, and `until` stops on a line or a changed variable.
- **Safe by design**: observes without changing anything, debugs only your own SAP user, never takes
  over another debugger, always cleans up, bounded in time and result size.
- **Local or shared**: next to the assistant (stdio), or as a server on SAP BTP Cloud Foundry where
  each user signs in and debugs as their own SAP user.

## Quick start

You need Node.js 22.12+ and git, an SAP system with ADT (on-premise SAP_BASIS 7.50 or later, or the
SAP BTP ABAP Environment), and an SAP user with ADT access (`S_ADT_RES`) and debug authorization
(`S_DEVELOP` with `OBJTYPE = DEBUG`, `ACTVT = 03`).

**Claude Code**

```bash
claude mcp add adam \
  -e SAP_URL=https://my-sap-host:44300 -e SAP_CLIENT=100 \
  -e SAP_USER=DEVELOPER -e SAP_PASSWORD=secret \
  -- npx -y --allow-git=root github:ClementRingot/ADAM
```

**Claude Desktop, Cursor, VS Code and other clients** — `claude_desktop_config.json`,
`.cursor/mcp.json` or `.vscode/mcp.json` (in VS Code the top-level key is `servers`):

```json
{
  "mcpServers": {
    "adam": {
      "command": "npx",
      "args": ["-y", "--allow-git=root", "github:ClementRingot/ADAM"],
      "env": {
        "SAP_URL": "https://my-sap-host:44300",
        "SAP_CLIENT": "100",
        "SAP_USER": "DEVELOPER",
        "SAP_PASSWORD": "secret"
      }
    }
  }
}
```

Then ask, for instance: *"Debug ZCL_ORDER=>GET_TOTAL with its unit tests and show me LV_TOTAL at
line 42."*

Single sign-on cookies, the BTP ABAP Environment, a corporate proxy and every other setting:
[Configuration](docs/configuration.md).

<details>
<summary>Installation notes</summary>

- npx fetches the repository from GitHub and builds it once: the first start takes a while. Run
  `npx -y --allow-git=root github:ClementRingot/ADAM --version` once in a terminal first, so
  the client does not wait for the build.
- `--allow-git=root`: npm 12 refuses to install from git unless allowed; earlier versions accept the
  flag too.
- Pin a version by appending `#<tag or commit>` to the repository name.
- On Windows, some clients start `npx` only through the shell: `"command": "cmd"` with
  `"args": ["/c", "npx", "-y", "--allow-git=root", "github:ClementRingot/ADAM"]`.
- From a clone: `git clone https://github.com/ClementRingot/ADAM.git`, then `npm ci` (it also
  builds), and register `node /path/to/ADAM/dist/index.js` as the command.
- Instead of an `env` block, the server can read a file: add `"--env-file", "/path/to/.env"` to `args`
  (see [.env.example](.env.example)).

</details>

## Tools

| Tool | What it does |
|---|---|
| `abap_debug` | Arms breakpoints, runs the code and records every stop of that run: position, call stack, variables, steps. With `interactive: true`, holds the program at its first stop |
| `abap_debug_session` | Drives a held program one move at a time: `step`, `continue`, `inspect`, `end` — and `wait`s for a capture or move that outlasts its call |
| `abap_source` | The active source of a class, program or function module, with the line numbers breakpoints use — and of interfaces, includes, CDS views, behavior and service definitions; a service binding's service definitions: the way from a Fiori app to its code |
| `abap_search` | Finds objects of every type by name, name start or pattern — service bindings and definitions included, with SAP's generated service objects left out |

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{method: "get_total"}]}
    stop in GET_TOTAL while the class's unit tests run: stack and local variables

abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, condition: "sy-tabix = 500"}], variables: ["LS_ITEM"]}
    only the 500th pass of the loop

abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, until: {changed: "LV_STATUS"}}
    step until LV_STATUS changes, and show where

abap_debug {type: "PROG", name: "ZREPORT", line: 30, trigger: "none", timeoutSeconds: 120}
    run ZREPORT yourself, as the same SAP user, while the capture waits

abap_debug         {type: "CLAS", name: "ZCL_ORDER", line: 42, interactive: true}
abap_debug_session {action: "step", stepMode: "into", variables: ["LV_TOTAL"]}
abap_debug_session {action: "inspect", variables: ["LS_HEAD"], stack: true}
abap_debug_session {action: "end"}
    an interactive session, one move per call
```

Parameters, results and more examples: [Tool reference](docs/tools.md).

## How it works

```text
1. Resolve   the breakpoints against the active source — input errors stop here
2. Arm       external breakpoints for your SAP user, and SAP's debugger listener
3. Run       the trigger: ABAP Unit, an OData GET, or your own run
4. Follow    attach where the program stopped; record each stop, step, continue
5. Release   let the program finish; remove the breakpoints and the listener — always
```

The program runs **once**, however many stops you ask for: a breakpoint in a loop with `hits: 5`
shows five iterations of the same run. A one-shot capture never leaves a program suspended. An
interactive session holds it — and its SAP work process — until `end`, two minutes without a call, or
fifteen minutes in all (both adjustable).

More in the [tool reference](docs/tools.md#how-a-capture-works) and in
[the ADT debugger protocol](docs/adt-debugger-protocol.md), which also records what has been verified
on real systems.

## Safety

- **Observes, never changes**: no variable writes, no jumps, no system debugging. The one exception is
  on request: ending an interactive session with `terminate: true` aborts the program. When SAP can
  only attach in non-exclusive mode, where every debugger step commits the program's database work,
  the capture lets the program go at once instead of inspecting it.
- **Only your own SAP user**: the user SAP itself names for the session, never a name passed in a call.
- **No takeover**: if Eclipse, VS Code or another capture debugs the same user, the call refuses.
- **Harmless triggers**: ABAP Unit runs harmless tests only; the HTTP trigger only reads an OData path
  on the connected system.
- **Always cleaned up**: on every path, errors and timeouts included, the breakpoints and the listener
  are removed and the program is released.
- **Bounded**: 20 breakpoints and 50 stops per call; steps as far as the call's time (default 120 s)
  and result size (default 40 KB) allow, both capped by the server's ceilings; a few captures and
  sessions at once per server, since each held program takes an SAP work process.
- **Fits the client's patience**: a call answers within 50 s (many clients give up after 60); longer
  work goes on in the background, and `abap_debug_session` `wait` picks up its answer.

## On SAP BTP

Deploy the MTA on Cloud Foundry (`mbt build`, `cf deploy`), point it at a destination, assign the role
collection, and connect the clients to `https://<route>/mcp`. They sign in through XSUAA in the
browser, and each user debugs as their own SAP user: principal propagation through the Cloud
Connector for an on-premise system, a user token for the BTP ABAP Environment. See the
[deployment guide](docs/btp-deployment.md).

## Documentation

| Page | Contents |
|---|---|
| [Tool reference](docs/tools.md) | Parameters, results, examples, limits |
| [Configuration](docs/configuration.md) | Connecting to SAP, every setting |
| [Deploying on SAP BTP](docs/btp-deployment.md) | XSUAA, destinations, Cloud Connector, MTA |
| [Troubleshooting](docs/troubleshooting.md) | When a capture does not stop where expected |
| [The ADT debugger protocol](docs/adt-debugger-protocol.md) | How SAP's debugger is driven, and what was verified live |
| [Roadmap](docs/roadmap.md) | Ideas and open checks |

## Status

Version 0.1. The capture engine has been observed live on the SAP BTP ABAP Environment: attaching
across application servers, several stops in one run, steps. This server's own HTTP client, the
conditional, message and statement breakpoints, long step runs, interactive sessions and the BTP
deployment are tested against a simulated SAP so far. Live checks on-premise (7.50, 7.58, 8.16) and a
first deployment on a real subaccount come next — see the [roadmap](docs/roadmap.md).

## Development

```bash
npm ci              # installs, then builds (the prepare script)
npm test            # unit tests (vitest)
npm run typecheck   # tsc over sources and tests
npm run lint        # biome
npm run dev         # run from source (tsx)
```

| Folder | Contents |
|---|---|
| `src/adt/` | ADT HTTP client, debugger protocol, ABAP Unit, repository reads, BTP ABAP login |
| `src/abap/` | Object types, method locator |
| `src/tools/` | The tools: `debug-capture.ts` runs a capture, `debug-follow.ts` follows a run, `debug-session.ts` holds interactive sessions; `debug-arm.ts`, `debug-view.ts` and `debug-trace.ts` arm breakpoints and render what was seen |
| `src/btp/` | Per-user SAP connections through the Destination service |
| `src/` | `index.ts` (entry point, stdio or `--http`), `server.ts` (MCP), `http-server.ts` (Streamable HTTP with XSUAA and API keys), `config.ts` |

Logs go to stderr only: over stdio, stdout carries the MCP protocol.

## License and attribution

MIT — see [LICENSE](LICENSE). This server is derived from [ARC-1](https://github.com/arc-mcp/arc-1)
(MIT), from which the ADT HTTP conventions, the BTP login, the method locator and the ABAP Unit parsing
were ported. The ADT debugger contract was corroborated against
[abap-adt-api](https://github.com/marcellourbani/abap-adt-api),
[vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) and
[vibing-steampunk](https://github.com/oisee/vibing-steampunk).

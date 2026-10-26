# abap-debugger-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant debug ABAP code on an SAP
system. In **one tool call** it arms breakpoints, runs the code, and at every stop of that run records
where the program stands, the call stack, the variables and optional steps — then lets the program
finish and removes everything it set. The assistant gets snapshots of one run, never a remote control
of a stopped program.

```text
You:     Why does ZCL_ORDER=>GET_TOTAL return 0 for order 4711?
Claude:  abap_source  {type: "CLAS", name: "ZCL_ORDER", method: "get_total"}
         abap_debug   {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, hits: 3}],
                       variables: ["LS_ITEM-NETWR", "LV_TOTAL"], steps: 2}
         → three loop iterations of the same run, each with both values and two steps
```

It talks to SAP through the ABAP Development Tools (ADT) REST API — the same resources Eclipse ADT
uses — so nothing has to be installed on the SAP system.

## How a capture works

1. **Resolve.** The breakpoints are resolved against the **active** source (a `method` breakpoint
   lands on the method's first statement; a line without a statement moves to the next lines SAP
   accepts). Everything that can fail on input fails here, before any debugger state exists on SAP.
2. **Arm.** External breakpoints are set for the session's own SAP user, and SAP's debugger listener
   starts (a long poll). If Eclipse or VS Code is already debugging that user, the capture refuses
   instead of taking the session over.
3. **Run.** The trigger runs the code: the object's harmless ABAP Unit tests, an OData `GET`, or
   nothing (`trigger: "none"`) while you run it yourself — a Fiori app, a report — as the same SAP user.
4. **Follow.** When the program stops, the capture attaches from the debuggee's application server,
   records the stop (position, call stack, variables, steps), retires a breakpoint once it has made
   its `hits`, and continues to the next stop of the **same run**.
5. **Release.** The program runs on to its end; the capture's breakpoints and listener are removed in
   every case, including errors and timeouts.

The program runs **once**, however many stops you ask for: a breakpoint in a loop with `hits: 5`
shows five iterations of one run. Because nothing stays stopped after the call returns (a suspended
program holds an SAP work process), the assistant must ask for every variable it needs up front; to
look again, it runs another capture.

## Requirements

- Node.js 22.12 or later.
- An SAP system reachable over HTTP(S) with ADT enabled: SAP NetWeaver / S/4HANA on-premise (SAP_BASIS
  7.50 or later), or the SAP BTP ABAP Environment.
- An SAP user with ADT access (`S_ADT_RES`) and debug authorization (`S_DEVELOP` with
  `OBJTYPE = DEBUG`, `ACTVT = 03`). The unit-test trigger also needs the authorization to run ABAP Unit
  on the objects concerned.

## Installation

The package is not on npm yet. npx can run it straight from GitHub: it fetches the repository, builds
it once — the first start takes a while, later ones come from npm's cache — and starts the server. It
needs Node.js 22.12+ and git.

**Claude Code**

```bash
claude mcp add abap-debugger \
  -e SAP_URL=https://my-sap-host:44300 -e SAP_CLIENT=100 \
  -e SAP_USER=DEVELOPER -e SAP_PASSWORD=secret \
  -- npx -y --allow-git=root github:ClementRingot/abap-debugger
```

**Claude Desktop, Cursor, VS Code and other clients** (`claude_desktop_config.json`, `.cursor/mcp.json`,
`.vscode/mcp.json` — the top-level key is `servers` in VS Code):

```json
{
  "mcpServers": {
    "abap-debugger": {
      "command": "npx",
      "args": ["-y", "--allow-git=root", "github:ClementRingot/abap-debugger"],
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

- Run `npx -y --allow-git=root github:ClementRingot/abap-debugger --version` once in a terminal first,
  so the client's first start does not wait for the build.
- `--allow-git=root`: npm 12 refuses to install from git unless allowed; earlier versions accept the
  flag too.
- Pin a version by appending `#<tag or commit>` to the repository name.
- On Windows, some clients start `npx` only through the shell: `"command": "cmd"` with
  `"args": ["/c", "npx", "-y", "--allow-git=root", "github:ClementRingot/abap-debugger"]`.

**From a clone** — for development, or to run a build you control:

```bash
git clone https://github.com/ClementRingot/abap-debugger.git
cd abap-debugger
npm ci                 # also builds → dist/index.js
```

Then register `node /path/to/abap-debugger/dist/index.js` as the command instead of npx.

Instead of `env`, the server can read a file: add `"--env-file", "/path/to/.env"` to `args`
(see [.env.example](.env.example)). The variable names are ARC-1's, so an ARC-1 `.env` works unchanged.

**SAP BTP ABAP Environment.** Create a service key for the ABAP instance in the BTP cockpit, save it
as a file, and set `SAP_BTP_SERVICE_KEY_FILE` instead of URL and credentials. On the first call the
server opens your browser for the SAP login (the flow Eclipse ADT uses); the token is then refreshed
automatically.

## Configuration

| Variable | Meaning |
|---|---|
| `SAP_URL` | SAP system URL, e.g. `https://my-sap-host:44300` |
| `SAP_CLIENT` | Client, e.g. `100` (default: the system's default client) |
| `SAP_LANGUAGE` | Logon language (default `EN`) |
| `SAP_USER`, `SAP_PASSWORD` | Basic authentication |
| `SAP_COOKIE_FILE` | Netscape cookie file, re-read when SAP rejects the session |
| `SAP_COOKIE_STRING` | Inline cookies: `name=value; name2=value2` |
| `SAP_BTP_SERVICE_KEY_FILE` / `SAP_BTP_SERVICE_KEY` | BTP ABAP Environment service key (file or inline JSON); URL and client come from it |
| `SAP_BTP_OAUTH_CALLBACK_PORT` | Port of the local login callback (default: a free port) |
| `SAP_PROXY` | Corporate proxy for SAP and the BTP login, e.g. `http://proxy.example:8080` (`http://user:password@proxy:8080` when it asks for a login); HTTPS goes through it as a tunnel |
| `SAP_INSECURE` | `true` skips TLS certificate checks — test systems only |
| `SAP_DISABLE_SAML` | `true` asks SAP not to redirect to SAML single sign-on |
| `SAP_ABAP_RELEASE` | SAP_BASIS release (e.g. `758`): the ABAP grammar used to locate methods in classic code |
| `ABAP_DEBUGGER_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` — logs go to stderr |

A server that is not configured still starts; every tool call then lists what is missing.

## Tools

### `abap_debug` — capture one run

| Parameter | Description |
|---|---|
| `type`, `name` | Object of `line`, and the default object of every breakpoint and of the unit-test trigger: `CLAS`, `PROG` or `FUNC` |
| `line` | Shorthand for one breakpoint at this line of `type` + `name` |
| `breakpoints` | Up to 20 breakpoints. A line or method breakpoint is `{ line \| method, include?, condition?, hits?, type?, name? }`; an event breakpoint is `{ message \| statement \| exceptionClass, hits? }`. `line`: 1-based, as `abap_source` numbers the active source. `method` (`CLAS`): `get_total`, `zif_order~process`, or a local-class method such as `lhc_travel~validate_dates`. `include` (`CLAS`): `implementations` or `testclasses`, detected for `lhc_`/`lcl_`/`ltc_` methods. `condition`: an ABAP condition SAP evaluates there, so the run stops only where it holds (`lv_index = 500`, `ls_item-matnr = 'X' AND sy-tabix > 10`) — one pass of a long loop; when SAP cannot evaluate it, it stops anyway and the stop says so. `message`: `{ id, number, type? }` — stop where a `MESSAGE` statement issues it (any type when `type` is left out), e.g. `{ id: "ZSD", number: "042", type: "E" }`. `statement`: stop at every statement of a kind, e.g. `COMMIT WORK` or `CALL FUNCTION` (a kind SAP does not know is refused with the list of those it does). `exceptionClass`: stop where it is raised. `hits` (1-50, default 1): how often this breakpoint may stop the run |
| `exceptionClass` | Shorthand for one exception breakpoint, e.g. `CX_SY_ZERODIVIDE` |
| `trigger` | `unittest` (default): the harmless ABAP Unit tests of `triggerName`, else of `type` + `name`, else of the first breakpoint's object (a function module's tests are its group's). `http`: a `GET` of `url`. `none`: wait `timeoutSeconds` while you run the code yourself as the same SAP user |
| `triggerName` | The class, program or function group whose unit tests run the code, when it is not the breakpoint object |
| `url` | `trigger: "http"`: a host-relative OData path, `/sap/opu/odata4/…` or `/sap/opu/odata/sap/<SRV>/…` |
| `variables` | Up to 20 expressions read at every stop and after every step: `LV_TOTAL`, `LS_HEAD-VBELN`, `LT_ITEMS`, `LT_ITEMS[3]`, `ME->MV_STATE`, `SY-SUBRC`. Default: every variable of the stopped frame (up to 60) |
| `steps` | Steps after each stop (0-20, at most 100 per capture) |
| `stepMode` | `over` (default), `into` (follow calls) or `out` (return to the caller) |
| `timeoutSeconds` | How long to wait for the first stop (1-240, default 60) |

The result is JSON: `hit`; `breakpoints` (each set, with the `hits` it made — `0` = the run never got
there — or refused with SAP's reason); `debuggee` (program, line, application server); `stops` (each
with `at`, `stoppedAt`, the call `stack` on a breakpoint's first stop, `variables`, `steps` with their
values); `release`; `trigger` (the unit-test summary or HTTP status); `warnings`. Without a stop it
carries the `reason` (timeout, trigger finished first, conflict) and a `hint`.

A breakpoint's later stops — a loop — are compact: `{ stop, at, hit, values }`, without the position
and call stack its first stop already showed, and with `unchanged` for a structure or table equal to
the breakpoint's previous stop. A capture is bounded by what its result costs, not by counting: it
follows the run until the stops and steps fill about 40 KB of JSON, so two named values allow many more
iterations than sixty frame variables.

Values are shown as SAP renders them: structures one level deep, tables with their line count and
first 5 rows, values up to 500 characters. A string keeps its leading and trailing blanks (they
count: `CONV string( 124 )` is `"124 "`); other values are trimmed. After a step, a structure or table
equal to the previous step's reads `unchanged`, and a step that entered or left a method says so
(`frame: entered | returned | changed`) — a variable of the same name is then a different variable.

### `abap_source` — the active source with line numbers

The source of a class (`main`, or a local-class include: `implementations`, `testclasses`,
`definitions`), a program or a function module, numbered exactly as `abap_debug` breakpoints address
it. Narrow it with `method`, `lineStart`/`lineEnd` or `grep` (a case-insensitive regular expression;
matches are shown with one line of context). At most 1,500 lines per call.

### `abap_search` — find objects

The repository quick search: exact name, type, package and description for a name or pattern
(`ZCL_ORDER*`, `*TRAVEL*`), optionally of one `objectType`.

## Examples

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{method: "get_total"}]}
    stop in GET_TOTAL while the class's unit tests run: stack and local variables

abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, variables: ["LV_TOTAL", "LT_ITEMS"], steps: 3}

abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, hits: 5}, {line: 60}], variables: ["LV_TOTAL"]}
    five loop iterations, then the line after the loop — one run

abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, condition: "sy-tabix = 500"}], variables: ["LS_ITEM"]}
    only the 500th pass of the loop

abap_debug {type: "CLAS", name: "ZBP_I_TRAVEL",
            breakpoints: [{method: "lhc_travel~validate_dates"}, {type: "CLAS", name: "ZCL_TRAVEL_RULES", method: "check_dates"}],
            trigger: "http", url: "/sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel"}

abap_debug {type: "PROG", name: "ZREPORT", line: 30, trigger: "none", timeoutSeconds: 120}
    run ZREPORT yourself (same SAP user) while the capture waits

abap_debug {exceptionClass: "CX_SY_ITAB_LINE_NOT_FOUND", trigger: "unittest", triggerName: "ZCL_ORDER"}
    where is it raised?

abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{message: {id: "ZSD", number: "042", type: "E"}}],
            variables: ["LS_ORDER"]}
    which code issues error ZSD 042, and with which order?

abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{statement: "COMMIT WORK", hits: 3}]}
    who commits during this run? Each stop shows its own position and call stack
```

## Guarantees and limits

- **Observes, never changes.** No variable writes, no jumps, no system debugging; the program's flow
  is the one it would have taken anyway. Frames of SAP system programs are skipped.
- **Only the session's own user.** The debug user is the one SAP itself names for the session
  (`/sap/bc/adt/core/http/systeminformation`), never a name passed in a call. SAP_BASIS 7.50 and older
  lack that resource; there `SAP_USER` is used, behind Basic or cookie authentication only.
- **No takeover.** If another debugger (Eclipse, VS Code, another capture) listens for the same user,
  the capture refuses. One capture per SAP user runs at a time.
- **Harmless triggers.** ABAP Unit runs harmless tests only; the HTTP trigger only `GET`s an OData
  path on the connected system. Saves and actions are reached through a unit test or
  `trigger: "none"`.
- **Always cleaned up.** Breakpoints and the listener are removed and the program released on every
  path; the release has its own time budget, so an exhausted inspection never leaves a program
  suspended.
- **Bounds per capture:** 20 breakpoints; the run is followed until about 40 KB of result, 50 stops,
  100 steps or 120 s of inspection after the first stop — whichever comes first — then goes on without
  stopping, and a warning says which bound ended the capture.

**Several application servers** (the BTP ABAP Environment and larger on-premise systems): SAP attaches
only from the server the program stopped on. The capture opens sessions before the run until two land
on the same server and runs its unit tests on one of them, so the stop and the attach meet. With
`trigger: "http"` or `"none"` it can attach only where it already has a session; when it cannot, the
result says which server was missed — retry.

## Troubleshooting

- **The unit tests finished without reaching the breakpoint.** No harmless test covers that code, or
  the code was activated moments ago and has not reached the application server that ran it yet (wait
  about a minute). Use `triggerName` for a test class elsewhere, or `trigger: "none"`.
- **`trigger: "http"` fails with 403 "blocked by UCON".** A service published moments ago can be
  refused for a few minutes on the BTP ABAP Environment; check the URL works on its own.
- **`trigger: "none"` stops at the wrong request.** The capture takes the first request of that user
  that reaches a breakpoint: in a Fiori Elements app the list read may come before the action you
  meant. Start the capture once the page has loaded, then trigger the action, and prefer breakpoints in
  code only that action runs.
- **`ADT network error: fetch failed: …` behind a corporate proxy.** Set `SAP_PROXY`, with
  `user:password@` when the proxy answers `Proxy response (407)`; the server does not read
  `HTTPS_PROXY`, so an internal SAP system is never sent through a proxy by surprise. A proxy that
  inspects TLS signs with its own certificate authority (`unable to get local issuer certificate`): give
  Node.js that certificate with `NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem` in the client's `env`
  block — Node.js reads it at startup, so not from `--env-file` — rather than `SAP_INSECURE`.
- **An unassigned field symbol** reads like an empty value; read it where it is assigned.
- **A message breakpoint never stops** although the message appears: it catches `MESSAGE` statements
  only. RAP messages (`new_message( … )` in `reported`) and BAPI return tables carry a message without
  issuing it; search the message number in the source (`abap_source` with `grep`) instead.

## Status

The debugger was built and live-tested inside [ARC-1](https://github.com/arc-mcp/arc-1) on the SAP BTP
ABAP Environment (multi-server attach, multi-stop runs, steps); the contract and its evidence are in
[docs/research](docs/research/2026-10-22-abap-debugger-one-shot-capture.md). This server ports that
code unchanged in behavior over its own minimal HTTP client; its unit tests run the whole capture
against a simulated SAP. Live runs of this standalone build, and on-premise checks on 7.50, 7.58 and
8.16, are still to come — see the [roadmap](docs/roadmap.md).

## Development

```bash
npm ci              # installs, then builds (the prepare script)
npm test            # unit tests (vitest)
npm run typecheck   # tsc over sources and tests
npm run lint        # biome
npm run build
npm run dev         # run from source (tsx)
```

Source layout: `src/adt/` (HTTP client, debugger protocol, ABAP Unit, repository reads, BTP login),
`src/abap/` (object types, method locator), `src/tools/` (the three tools), `src/server.ts` (MCP),
`src/config.ts`, `src/index.ts` (stdio entry point). Logs go to stderr only: stdout carries the MCP
protocol.

## License and attribution

MIT — see [LICENSE](LICENSE). This server is derived from [ARC-1](https://github.com/arc-mcp/arc-1)
(MIT), from which the debugger capture, the ADT HTTP conventions, the BTP login, the method locator
and the ABAP Unit parsing were ported. The ADT debugger contract was corroborated against
[abap-adt-api](https://github.com/marcellourbani/abap-adt-api),
[vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) and vibing-steampunk.

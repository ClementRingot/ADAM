# ADAM

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant debug ABAP code on an SAP
system, in two modes:

- **One-shot** (default): in **one tool call** it arms breakpoints, runs the code, and at every stop
  of that run records where the program stands, the call stack, the variables and as many steps as
  the call's time and size budgets allow — then lets the program finish and removes everything it set.
- **Interactive** (`interactive: true`): it stops at the first breakpoint and keeps the program
  waiting there; the assistant then drives it one move per call — step in, over or out, continue,
  inspect any variable — deciding each move from what it sees, until it ends the session.

```text
You:     Why does ZCL_ORDER=>GET_TOTAL return 0 for order 4711?
Claude:  abap_source  {type: "CLAS", name: "ZCL_ORDER", method: "get_total"}
         abap_debug   {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, hits: 3}],
                       variables: ["LS_ITEM-NETWR", "LV_TOTAL"], steps: 2}
         → three loop iterations of the same run, each with both values and two steps
```

It talks to SAP through the ABAP Development Tools (ADT) REST API — the same resources Eclipse ADT
uses — so nothing has to be installed on the SAP system. It runs locally next to the assistant (stdio),
or as a shared server on **SAP BTP Cloud Foundry** like ARC-1 — XSUAA sign-in, every user debugging as
their own SAP user through principal propagation ([deployment guide](docs/btp-deployment.md)).

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
shows five iterations of one run. In the one-shot mode nothing stays stopped after the call returns
(a suspended program holds an SAP work process), so the assistant asks for every variable it needs up
front; to look again, it runs another capture — or starts an interactive session, which holds the
program at step 4 until the session ends (see [`abap_debug_session`](#abap_debug_session--drive-an-interactive-session)).

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

**As a shared server on SAP BTP.** Deploy the MTA to Cloud Foundry (`mbt build`, `cf deploy`), point it
at a principal-propagation destination, assign the role collection, and connect the clients to
`https://<route>/mcp` — they sign in through XSUAA in the browser, and each user debugs as their own
SAP user. See the [deployment guide](docs/btp-deployment.md). The same HTTP mode
(`ABAP_DEBUGGER_TRANSPORT=http`) runs on any host with API keys.

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
| `ABAP_DEBUGGER_MAX_SECONDS` | Ceiling of a call's `maxSeconds` (10-3600, default 600) |
| `ABAP_DEBUGGER_MAX_RESULT_KB` | Ceiling of a call's `maxResultKB` (5-1000, default 200) |
| `ABAP_DEBUGGER_IDLE_SECONDS` | An interactive session is released after this long without a call (10-3600, default 120) |
| `ABAP_DEBUGGER_SESSION_SECONDS` | An interactive session is released after this long in all (60-14400, default 900) |
| `ABAP_DEBUGGER_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` — logs go to stderr |

A server that is not configured still starts; every tool call then lists what is missing.

Over HTTP (`--http` or `ABAP_DEBUGGER_TRANSPORT=http`), on SAP BTP or any host, these apply too — see
the [deployment guide](docs/btp-deployment.md#settings):

| Variable | Meaning |
|---|---|
| `SAP_BTP_DESTINATION` | BTP destination of the SAP system: `PrincipalPropagation` (on-premise, Cloud Connector) or `OAuth2UserTokenExchange` (BTP ABAP Environment) — each user as themselves |
| `ABAP_DEBUGGER_API_KEYS` | Comma-separated API keys (20+ characters each), besides XSUAA OAuth when an XSUAA instance is bound |
| `ABAP_DEBUGGER_ALLOW_SHARED_USER` | `true` accepts one SAP identity for every MCP user (`SAP_URL` + `SAP_USER`, a Basic destination) — they can then catch each other's runs |
| `ABAP_DEBUGGER_PORT`, `ABAP_DEBUGGER_HOST` | Port (default `8080`, `PORT` on Cloud Foundry) and bind address (default `127.0.0.1`, `0.0.0.0` on Cloud Foundry) |
| `ABAP_DEBUGGER_PUBLIC_URL` | Public URL for the OAuth metadata behind a reverse proxy (default: the Cloud Foundry route) |
| `ABAP_DEBUGGER_DCR_SIGNING_SECRET` | 32+ characters: keeps the MCP clients' OAuth registrations valid across deployments |
| `ABAP_DEBUGGER_ALLOWED_ORIGINS` | CORS origins of browser MCP clients |

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
| `steps` | Steps after each stop (default 0, up to 10,000): as far as the budgets allow. Up to 20 come back one entry each; more come back as a compact trace (below) |
| `stepMode` | `over` (default), `into` (follow calls) or `out` (return to the caller) |
| `until` | End the steps early: `{ line }` once the program stands on that line of the source the steps started in, `{ changed: "LV_STATUS" }` once that variable's value changed. Without `steps`: step until it holds |
| `maxSeconds` | Time budget of the inspection once the program stopped (default 120; ceiling `ABAP_DEBUGGER_MAX_SECONDS`, default 600). Each step costs two or three requests to SAP |
| `maxResultKB` | Size budget of the result in KB of JSON (default 40, about 10k tokens; ceiling `ABAP_DEBUGGER_MAX_RESULT_KB`, default 200) |
| `interactive` | `true`: return at the first stop and keep the program waiting there for [`abap_debug_session`](#abap_debug_session--drive-an-interactive-session) |
| `timeoutSeconds` | How long to wait for the first stop (1-240, default 60) |

The result is JSON: `hit`; `breakpoints` (each set, with the `hits` it made — `0` = the run never got
there — or refused with SAP's reason); `debuggee` (program, line, application server); `stops` (each
with `at`, `stoppedAt`, the call `stack` on a breakpoint's first stop, `variables`, `steps` with their
values); `release`; `trigger` (the unit-test summary or HTTP status); `warnings`. Without a stop it
carries the `reason` (timeout, trigger finished first, conflict) and a `hint`.

A breakpoint's later stops — a loop — are compact: `{ stop, at, hit, values }`, without the position
and call stack its first stop already showed, and with `unchanged` for a structure or table equal to
the breakpoint's previous stop. A capture is bounded by what its result costs and by time, not by
counting: it follows the run until the stops and steps fill `maxResultKB` of JSON or `maxSeconds` run
out, so two named values allow many more iterations than sixty frame variables.

**Long step runs.** Past 20 steps from one stop, the steps come back as a compact `trace` instead of
one entry each: `path` lists the lines executed frame by frame — `10-12 (9-12)×497 13` is lines 10 to
12, then a loop over 9-12 run 497 times, then 13; a segment with `frame: entered` or `returned` is a
call or a return — and `changes` lists the watched variables only at the steps where they changed.
Two thousand steps of a loop fit in a few hundred characters; the time budget is then the real limit.

Values are shown as SAP renders them: structures one level deep, tables with their line count and
first 5 rows, values up to 500 characters. A string keeps its leading and trailing blanks (they
count: `CONV string( 124 )` is `"124 "`); other values are trimmed. After a step, a structure or table
equal to the previous step's reads `unchanged`, and a step that entered or left a method says so
(`frame: entered | returned | changed`) — a variable of the same name is then a different variable.

### `abap_debug_session` — drive an interactive session

`abap_debug` with `interactive: true` takes the same parameters as a one-shot capture, returns at the
first stop with a session id, and keeps the program waiting there. Each `abap_debug_session` call then
makes one move and answers where the program stands: its `position`, the `code` around it (the
current line marked `>`), and the watched variables.

| Parameter | Description |
|---|---|
| `action` | `step`, `continue`, `inspect` or `end` |
| `session` | The id `abap_debug` returned (default: the open session) |
| `stepMode`, `count`, `until` | `step`: `over` (default), `into` or `out`; how many steps (default 1, past 20 a compact trace); end early on a line or a change |
| `toLine` | `continue`: run to this line of the source the program stands in instead of the next breakpoint |
| `timeoutSeconds` | `continue`: how long to wait for the next stop (1-240, default 60) |
| `variables` | `step` / `continue`: the variables to watch from now on. `inspect`: read these now — any variable, structures expanded, tables' first rows (default: the whole frame) |
| `stack` | `inspect`: include the call stack |
| `terminate` | `end`: abort the program where it stands instead of letting it run to its end — e.g. before it commits |
| `maxSeconds`, `maxResultKB` | Budgets of this call, as for `abap_debug` |

The program holds an SAP work process — and its caller's request — while the session is open, exactly
as when a developer stops at a breakpoint in Eclipse. So end the session when done: `end` lets the
program run to its end, removes the breakpoints and reports the trigger's outcome. A session is also
released automatically after `ABAP_DEBUGGER_IDLE_SECONDS` without a call (default 120 s), after
`ABAP_DEBUGGER_SESSION_SECONDS` in all (default 15 min), and when the server stops or the MCP client
disconnects; every answer says how long it has left. One session at a time: while it is open, other
captures for the same SAP user are refused.

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

abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, steps: 2000, variables: ["LV_TOTAL"], maxSeconds: 600}
    follow the run for 2000 statements: a compact trace of the lines, LV_TOTAL where it changed

abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, until: {changed: "LV_STATUS"}}
    step until LV_STATUS changes, and show where

abap_debug         {type: "CLAS", name: "ZCL_ORDER", line: 42, interactive: true}
abap_debug_session {action: "step", variables: ["LV_TOTAL"]}
abap_debug_session {action: "step", stepMode: "into"}
abap_debug_session {action: "inspect", variables: ["LS_HEAD", "ME->MT_ITEMS"], stack: true}
abap_debug_session {action: "continue", toLine: 80}
abap_debug_session {action: "end"}
    an interactive session: each answer shows the position, the code around it and the watched values
```

## Guarantees and limits

- **Observes, never changes.** No variable writes, no jumps, no system debugging; the program's flow
  is the one it would have taken anyway — unless an interactive session is ended with
  `terminate: true`, which aborts the program on request. Frames of SAP system programs are skipped.
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
- **Bounds per call:** 20 breakpoints and 50 stops; steps as far as `maxResultKB` (default 40 KB) and
  `maxSeconds` (default 120 s) allow, each capped by the server's ceiling. A one-shot capture then lets
  the program go on without stopping, an interactive session keeps it waiting; a warning says which
  bound ended the call. A client that cancels the call stops it the same way.
- **Interactive sessions are bounded too:** released after `ABAP_DEBUGGER_IDLE_SECONDS` without a
  call and after `ABAP_DEBUGGER_SESSION_SECONDS` in all, and when the server stops or the client
  disconnects.
- **Progress.** Clients that ask for progress notifications get one at most every two seconds while
  a call waits for the first stop, records stops or steps — some clients keep a long call alive on
  them.

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
8.16, are still to come — see the [roadmap](docs/roadmap.md). The SAP BTP mode is tested with XSUAA
and the Destination service simulated (OAuth discovery, API keys, per-user identities, the
Connectivity proxy against a real local proxy) and its MTA builds; a first deployment on a real
subaccount is still to come.

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
`src/abap/` (object types, method locator), `src/tools/` (the tools: `debug-capture.ts` orchestrates
a capture, `debug-follow.ts` follows a run, `debug-session.ts` holds interactive sessions,
`debug-arm.ts`/`debug-view.ts`/`debug-trace.ts` arm breakpoints and render what was seen),
`src/btp/` (per-user SAP connections through the Destination service), `src/http-server.ts`
(Streamable HTTP with XSUAA/API-key auth), `src/server.ts` (MCP), `src/config.ts`, `src/index.ts`
(entry point, stdio or `--http`). Logs go to stderr only: stdout carries the MCP protocol over stdio.

## License and attribution

MIT — see [LICENSE](LICENSE). This server is derived from [ARC-1](https://github.com/arc-mcp/arc-1)
(MIT), from which the ADT HTTP conventions, the BTP login, the method locator
and the ABAP Unit parsing were ported. The ADT debugger contract was corroborated against
[abap-adt-api](https://github.com/marcellourbani/abap-adt-api),
[vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) and [vibing-steampunk](https://github.com/oisee/vibing-steampunk).

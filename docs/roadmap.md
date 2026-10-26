# Roadmap

Ideas, not commitments. Each entry says why it remains and how to resume it.

| ID | Idea | Priority | Effort | Status |
|---|---|---|---|---|
| [WATCH-1](#watch-1) | Watchpoints: stop where a variable changes | P3 | M | Needs live check |
| [LOG-1](#log-1) | Dynamic logpoints: observe a line across many runs | P3 | M | Needs research |
| [LIVE-1](#live-1) | Live verification of this standalone build | P1 | S | Needs a system |
| [NET-1](#net-1) | Corporate HTTP proxy (`HTTPS_PROXY`) | P3 | S | Ready |
| [INC-1](#inc-1) | Breakpoints in program and function-group includes | P3 | S | Needs research |

<a id="live-1"></a>
## LIVE-1 — Live verification of this standalone build

**Idea.** Run the capture scenarios of the research dossier (§9) with this server — not ARC-1 — on
the BTP ABAP Environment and on-premise 7.50, 7.58 and 8.16.

**Why it remains.** The capture logic was live-tested inside ARC-1 on the BTP ABAP Environment; this
server ports it over a new, minimal HTTP client, tested so far against simulated SAP answers only.

**Resume with.** Basic auth on an on-premise system (one class with unit tests, one loop, one RAP
behavior pool with `trigger: "none"`), then the BTP browser login; record the answers as fixtures.
Conditional breakpoints follow the reference clients (abap-adt-api, vscode_abap_remote_fs) and need
their own checks: how SAP answers an invalid condition (refused at the final sync, or a stop flagged
`unresolvableCondition`), and that a step onto the line of a condition that does not hold carries no
`reachedBreakpoints`. Message and statement breakpoints are reference-derived too (abap-adt-api
`formatBreakpoint`, `debuggerStatements`): check which message types SAP accepts, the statement kinds it
lists, and that it names the event breakpoint it stopped at in `reachedBreakpoints`.

<a id="net-1"></a>
## NET-1 — Corporate HTTP proxy

**Idea.** Honor `HTTPS_PROXY` / `NO_PROXY` (undici's `EnvHttpProxyAgent`) for systems reached through
a corporate proxy, with `SAP_INSECURE` applied to the proxied TLS connection too.

<a id="inc-1"></a>
## INC-1 — Breakpoints in includes

**Idea.** Accept `INCL` breakpoints (report includes, function-group includes such as `LZFGF01`).

**Resume with.** Verify the breakpoint URI SAP expects for an include used by one main program, and
how it answers for an include several programs use (Eclipse asks for the main-program context).

<a id="watch-1"></a>
## WATCH-1 — Watchpoints

**Idea.** Stop where a variable changes (optionally with a condition): "where does `LV_STATUS` become
'E'?" without knowing the line.

**Evidence.** abap-adt-api 9.2.0: `POST /sap/bc/adt/debugger/watchpoints?variableName=…&condition=…` on
the attached session; old and current values via child variables of `@WATCHPOINTS.<uri>`.

**Resume with.** A watchpoint lives in the attached session, so it can only be set at a stop: define the
shape (set at the first stop, continue to each change), and check its cost on long runs.

<a id="log-1"></a>
## LOG-1 — Dynamic logpoints

**Idea.** For "which values does this line see across many runs and users", SAP's dynamic logpoints
record fields at a line without stopping anything — no work process held, no stop cap.

**Why not instead of the compact stops.** Logpoints are system objects with an activation period,
visible to others and needing their own authorization and cleanup, and their log aggregates values
by key rather than keeping the order of one run. The debugger capture stays the tool for following
one run; logpoints would be a separate tool.

**Resume with.** abap-adt-api's `logpoints` module (definitions, activation per user/server, logs by
key) and the authorization they need.


# Roadmap

Ideas, not commitments. Each entry says why it remains and how to resume it.

| ID | Idea | Priority | Effort | Status |
|---|---|---|---|---|
| [LIVE-1](#live-1) | Live verification of this server | P1 | S | Needs a system |
| [LIVE-2](#live-2) | First deployment on a real SAP BTP subaccount | P1 | S | Needs a subaccount |
| [INC-1](#inc-1) | Breakpoints in program and function-group includes | P3 | S | Needs research |
| [WATCH-1](#watch-1) | Watchpoints: check them on a real system | P2 | S | Needs live check |
| [LOG-1](#log-1) | Dynamic logpoints: observe a line across many runs | P3 | M | Needs research |

<a id="live-1"></a>
## LIVE-1 — Live verification of this server

**Idea.** Run the [live checks](adt-debugger-protocol.md#9-live-checks-still-owed) with this server on
the BTP ABAP Environment and on-premise 7.50, 7.58 and 8.16.

**Why it remains.** The capture engine was observed live on the BTP ABAP Environment only
([what was seen](adt-debugger-protocol.md#8-observed-live)), before this server's own HTTP client, its
conditional, message and statement breakpoints, its long step runs and its interactive sessions; those are tested
against simulated SAP answers so far.

**Resume with.** Basic authentication on an on-premise system — one class with unit tests, one loop,
one RAP behavior pool with `trigger: "none"` — then the BTP browser login, then an interactive session
held for a few minutes; record SAP's answers as test fixtures.

<a id="live-2"></a>
## LIVE-2 — First deployment on SAP BTP

**Idea.** Deploy the MTA on a real subaccount and run the scenarios end to end: the OAuth sign-in of
Claude Code, Claude Desktop and VS Code through XSUAA (dynamic client registration), a
principal-propagation destination through the Cloud Connector (the SAP user each caller debugs as),
an `OAuth2UserTokenExchange` destination to the BTP ABAP Environment, an interactive session over
HTTP across several calls, and a restage while a session is open (released on SIGTERM).

**Why it remains.** XSUAA, the Destination service and the Connectivity proxy are simulated in the unit
tests, and the MTA was only built and staged locally. Check also how long the Cloud Foundry router lets
a long one-shot capture's request run.

<a id="inc-1"></a>
## INC-1 — Breakpoints in includes

**Idea.** Accept `INCL` breakpoints (report includes, function-group includes such as `LZFGF01`).

**Resume with.** Verify the breakpoint URI SAP expects for an include used by one main program, and
how it answers for an include several programs use (Eclipse asks for the main-program context).

<a id="watch-1"></a>
## WATCH-1 — Watchpoints on a real system

**Idea.** `watch` (one-shot, set at the first stop) and the interactive `watch` action are implemented
from abap-adt-api 9.2.0's contract (`POST /sap/bc/adt/debugger/watchpoints?variableName=…&condition=…`
on the attached session) and tested against simulated answers only.

**Why it remains.** What SAP names at a watchpoint's stop is unknown — the server falls back to the
value that changed — as are its refusals and how a watchpoint on a local behaves across frames
([live check 20](adt-debugger-protocol.md#9-live-checks-still-owed)).

**Resume with.** A loop that changes a local and an attribute: watch both from the loop's first line,
with and without a condition, once with a variable not yet visible; record SAP's answers as fixtures.

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


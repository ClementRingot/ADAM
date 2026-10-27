# Roadmap

Ideas, not commitments. Each entry says why it remains and how to resume it.

| ID | Idea | Priority | Effort | Status |
|---|---|---|---|---|
| [LIVE-1](#live-1) | Live verification of this server | P1 | S | Needs a system |
| [LIVE-2](#live-2) | First deployment on a real SAP BTP subaccount | P1 | S | Needs a subaccount |
| [INC-1](#inc-1) | Breakpoints in program and function-group includes | P3 | S | Needs research |
| [WATCH-1](#watch-1) | Watchpoints: check them on a real system | P2 | S | Needs live check |
| [TRACE-1](#trace-1) | One call from an OData URL or a Fiori app to its handler methods | P3 | M | Idea |
| [LOG-1](#log-1) | Dynamic logpoints: observe a line across many runs | P3 | M | Needs research |

<a id="live-1"></a>
## LIVE-1 — Live verification of this server

**Idea.** Run the [live checks](adt-debugger-protocol.md#9-live-checks-still-owed) with this server on
the BTP ABAP Environment and on-premise 7.50, 7.58 and 8.16.

**Why it remains.** On the BTP ABAP Environment this server itself has run conditions, long step runs,
statement kinds and an interactive session ([what was seen](adt-debugger-protocol.md#8-observed-live)).
No on-premise release has been tried yet, and the later additions were observed nowhere: answers that
outlast a call (`wait`), the release on a non-exclusive attach, the removal of leftovers
(`abap_breakpoints`), and the wider search and source types.

**Resume with.** On the BTP trial after a redeploy: a capture with `trigger: "none"` that waits past
50 seconds and is picked up with `wait`; `abap_breakpoints` `list` during a capture and `delete` after a
killed one; `abap_search` on a service binding's name; `abap_source` from `SRVB` to the behavior pool.
Then Basic authentication on an on-premise system — one class with unit tests, one loop, one RAP
behavior pool with `trigger: "none"`. Record SAP's answers as test fixtures.

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

<a id="trace-1"></a>
## TRACE-1 — From an OData URL or a Fiori app to the handlers, in one call

**Idea.** `abap_search` and `abap_source` lead from a service binding to its service definition, the
CDS views it exposes, the behavior definition and the behavior pool, one call each, and give a
published binding's service URL. One call could walk it all from what the user has at hand: the app's
OData URL, its BSP application's `/sap/bc/ui5_ui5/…/manifest.json`, or a classic Gateway (SEGW)
service and its `*_DPC_EXT` class.

**Evidence.** On the BTP ABAP Environment trial, `$metadata` answered 200 at the URLs built from the
binding's metadata: `/sap/opu/odata4/dmo/ui_travel_d_d_o4/srvd/dmo/ui_travel_d_d/0001/` (V4 UI),
`/sap/opu/odata4/dmo/api_travel_u_v4/srvd_a2x/dmo/travel_u/0001/` (V4 Web API),
`/sap/opu/odata/dmo/UI_TRAVEL_D_D_O2/` (V2). So a URL leads back to its binding: the V4 service group
is the binding's name, the V2 service its service name.

**Why it remains.** The walk is four or five cheap calls today. Still unchecked: a V2 service version
past 0001 (`;v=…`), and the SEGW registration (`IWSG`) that links a classic service to its project.

**Resume with.** Parse a URL into binding and entity set, search the binding, and chain the reads;
check a versioned V2 service and a SEGW service on a system that has them.

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


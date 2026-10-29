# Roadmap

Ideas, not commitments. Each entry says why it remains and how to resume it.

| ID | Idea | Priority | Effort | Status |
|---|---|---|---|---|
| [LIVE-1](#live-1) | Live verification of this server | P1 | S | Needs a system |
| [LIVE-2](#live-2) | First deployment on a real SAP BTP subaccount | P1 | S | Needs a subaccount |
| [MULTI-1](#multi-1) | Several SAP systems from one deployment: a fixed list of destinations | P2 | M | After LIVE-2 |
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
On-premise, only SAP GUI runs on one S/4HANA system were tried, with experiment scripts rather than
this server ([SAP GUI runs](adt-debugger-protocol.md#sap-gui-runs)). The later additions were observed
nowhere: answers that outlast a call (`wait`), the release on a non-exclusive attach, the removal of
leftovers (`abap_breakpoints`), the wider search and source types, the SAP GUI route itself, and the
debugger session routed to the program's application server (`X-sap-adt-server-instance`, read in
SAP's source only).

**Resume with.** On the BTP trial the redeploy of 29 October 2026 ran routing, interactive sessions,
`http`, conditions, event breakpoints, `SRVB` → behavior pool, `wait`, `abap_breakpoints` and
watchpoints ([§8](adt-debugger-protocol.md#8-observed-live)); left there: a process killed outright
(not stopped) mid-capture, and a message breakpoint on code that issues a `MESSAGE`.
Then Basic authentication on an on-premise system — one class with unit tests, one loop, one RAP
behavior pool with `trigger: "none"`; on S/4HANA with several servers, a program stopped on another
server than the debugger session's — attached, stepped and released there through the routed session
— and a capture caught from SAP GUI on each server, armed there
([live checks 21-24](adt-debugger-protocol.md#9-live-checks-still-owed)). Record SAP's answers as test
fixtures.

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

<a id="multi-1"></a>
## MULTI-1 — Several SAP systems from one deployment

**Idea.** The administrator lists the destinations a deployment serves
(`SAP_BTP_DESTINATIONS=S4D_PP,S4Q_PP`); each gets its own MCP route, `/<SID>/<client>/mcp`, from the
destination's `sap-sysid` and `sap-client` (the shape of ARC-1's pinned routes), and `/mcp` stays for a
deployment with one system. A connector is then one system, chosen by the person who adds it: the
tools keep their schemas and no call names a target, so the model cannot arm breakpoints — or hold a
work process — on QAS when it meant DEV. With five tools, several connectors stay cheap.

**Why it remains.** One deployment per system already works, and isolates best: on BTP one MTA per
Cloud Foundry space (the descriptor derives the `xsappname` and the role collection from the space),
locally one MCP client entry per system. And the first deployment on a real subaccount
([LIVE-2](#live-2)) comes first.

**What it takes.**
- One capture or session per SAP user *and system* (`holderOf` compares the user name only), and per
  MCP user and system.
- The caps per system, since they protect its dialog work processes (`rdisp/wpdbug_max_no`), and one
  more for the process's memory.
- One `BtpConnections` per destination; the records of leftover breakpoints already carry the system.
- Protected-resource metadata (RFC 9728) for each route: `@arc-mcp/xsuaa-auth` serves it for `/mcp`
  only.
- Only destinations that log each user on as themselves: a `BasicAuthentication` one is refused, as
  everyone would debug as one SAP user (a person alone keeps one local entry per system). Two
  destinations for the same system and client are refused too.
- A destination that fails leaves the others working, and its route says why.
- Still one Cloud Foundry instance: interactive sessions live in the process.

**Not in this step.** What else ARC-1's multi-target mode does (its ADR-0006 and ADR-0008):
destinations discovered by a property and refreshed, systems filtered per user by XSUAA attributes,
and an aggregate route with a `target` on every call — for a debugger the system should be the
connector's, not the model's choice of the moment.

**Opens.** In a hub landscape, one capture could arm breakpoints on the back end and run the OData GET
on the front-end server. Today: a back-end capture with `trigger: "none"` while the person runs the
app, which should catch the RFC call made as that user (trusted RFC, current user — unchecked).

**Resume with.** Once LIVE-2 has run: two systems where the person has the same SAP user name (DEV and
QAS through principal propagation), a capture on each at the same time, the caps per system, and the
OAuth sign-in on two routes.

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

**Resume with.** Seen on the BTP trial (29 October 2026): a watchpoint on a local stopping at each
change with from and to, and SAP's refusal of a variable not visible
([§8](adt-debugger-protocol.md#8-observed-live)). Left: an attribute, a condition, the one-shot
`watch` parameter, and SAP's answers recorded as fixtures.

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


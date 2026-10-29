# The ADT debugger protocol

How this server drives SAP's ABAP debugger: the ADT REST resources it calls, what SAP answers, and
what has been observed on real systems. It is the reference behind
[`src/adt/debugger.ts`](../src/adt/debugger.ts); what the tools make of it is in the
[tool reference](tools.md).

**Evidence.** The contract below is corroborated by three independent clients that drive the same
SAP resources, two of them with recorded live verification. **L** marks what was observed live on
the SAP BTP ABAP Environment in October 2026, with the capture engine this server is built on, **G**
what was observed with SAP GUI on an S/4HANA system, **R** what SAP's own ABAP source says. Everything
else still has to be confirmed release by release: see [§9](#9-live-checks-still-owed).

| | Source |
|---|---|
| **A** | [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) 9.2.0 — `build/api/debugger.js`, `AdtClient.js` |
| **V** | [vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) — `client/src/adt/debugger/` (`debugListener.ts`, `debugService.ts`, `breakpointManager.ts`, `variableManager.ts`) |
| **S** | [vibing-steampunk](https://github.com/oisee/vibing-steampunk) — `pkg/adt/debugger.go`, `pkg/saprfc/adtdebug.go`, and the live notes of its README |
| **L** | Live, SAP BTP ABAP Environment trial, October 2026 |
| **G** | Live, S/4HANA on-premise with two application servers, October 2026: SAP GUI runs, with experiment scripts on this server's modules (not kept; release not recorded) |
| **R** | SAP's ABAP source, read in October 2026 on an S/4HANA system (SAP_BASIS 8.16), the BTP ABAP Environment trial (9.20) and an ECC system (7.50): `CL_ABDBG_ACT_FOR_ATTACH__USER`, `CL_TPDAPI_SERVICE`, `CL_TPDA_ADT_RES_DEBUGGER`, `CL_ADT_WB_RES_APP`, `SADT_REST_RFC_ENDPOINT` |

## Nothing to install on SAP

The debugger is driven over plain ADT REST, as Eclipse ADT drives it: no ABAP helper, no WebSocket,
no RFC of its own. What it needs is **one stateful ADT session (`sap-contextid`) that lives from the
attach to the release, whose requests SAP runs on the application server where the stopped program
waits** ([§5](#5-reaching-the-debuggees-application-server)).
A client that gives the listener and the attach separate sessions never finds the program its
listener caught — the reason an HTTP-only debugger once shipped disabled (S): *"listen and attach
each got their own session, so the attach never found the debuggee the listen had caught. Nothing
about the resources was wrong — only the session under them."*

## A run at a glance

```text
1. breakpoints  POST /sap/bc/adt/debugger/breakpoints   external breakpoints of the SAP user
2. listener     POST /sap/bc/adt/debugger/listeners     long poll, on the stateless client
3. trigger      ABAP Unit, an OData GET, or the user's own run — as the same SAP user
4. stop         the listener answers with the waiting program (STPDA_DEBUGGEE)
5. attach       POST /sap/bc/adt/debugger?method=attach on a stateful session SAP routes to that program's server
6. inspect      stack, variables, steps, session breakpoints — on the same session
7. release      stepContinue until SAP reports the program ended
8. clean up     delete the listener, clear the breakpoints, close the stateful sessions
```

A one-shot capture runs all eight steps inside one tool call. An interactive session runs 1 to 5,
keeps the session of step 6 open between tool calls, and runs 7 and 8 when it ends.

## 1. Identity

Every breakpoint and listener request carries `debuggingMode=user`, `requestUser=<SAP user, upper
case>`, `terminalId` and `ideId` (A, S). In user mode SAP keys the **listener** by the user alone:
`ABDBG_LISTENER` holds `IDE_ID=<user>`, `TERMINAL_ID='%_USER'` (S).

`requestUser` must be the real SAP logon user: a listener for an empty or wrong user "matches
nothing — it waits out its whole timeout" (S). [§6](#6-who-is-debugged) says how the server finds it.
Each capture uses fresh random `terminalId` and `ideId` values (32 hexadecimal characters).

## 2. Breakpoints

```xml
<?xml version="1.0" encoding="UTF-8"?>
<dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" scope="external" debuggingMode="user"
    requestUser="DEVELOPER" terminalId="…" ideId="…" systemDebugging="false" deactivated="false">
  <syncScope mode="full"></syncScope>
  <breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="line" clientId="…" skipCount="0"
      adtcore:uri="/sap/bc/adt/oo/classes/zcl_order/source/main#start=42" condition="lv_index = 500"/>
  <breakpoint kind="exception" clientId="…" skipCount="0" exceptionClass="CX_SY_ZERODIVIDE"/>
  <breakpoint kind="message" clientId="…" skipCount="0" msgId="ZSD" msgNo="042" msgTy="E"/>
  <breakpoint kind="statement" clientId="…" skipCount="0" statement="COMMIT WORK"/>
</dbg:breakpoints>
```

- `POST /sap/bc/adt/debugger/breakpoints`, `Content-Type: application/xml`, `Accept: application/xml`
  (A, S); SAP reads it with the simple transformation `TPDA_ADT_BREAKPOINTS_REQUEST` (S).
- The POST **synchronizes the IDE's breakpoint set**: `syncScope mode="full"` replaces the whole set of
  this identity, `partial` plus an `adtcore:objectReference` replaces it inside one object (A, V). A
  `GET` answers 200 with an empty body — the set is IDE state (S). With a fresh `ideId` per capture, a
  full sync touches only the capture's own set, and an empty full set clears it.
- The answer lists each breakpoint with its `clientId`: an accepted one with its `id`
  (`KIND=0.SOURCETYPE=ABAP.MAIN_PROGRAM=…`), a refused one with an `errorMessage` instead — e.g.
  *"Cannot create a breakpoint at this position"* for a line without a statement (S, live). The armed
  line is read back from the answer's `adtcore:uri`.
- Kinds: `line`, `exception`, `statement` and `message` (S, live on 7.58). A message breakpoint carries
  `msgId`, `msgNo` and `msgTy` (S); the server sends an empty `msgTy` to match every type (A). The
  statement kinds SAP offers come from `GET /sap/bc/adt/debugger/breakpoints/statements` (A).
- A line breakpoint's URI is the source URI plus `#start=<line>` (V):
  `…/oo/classes/<class>/source/main`, `…/oo/classes/<class>/includes/implementations|testclasses`,
  `…/programs/programs/<program>/source/main`, `…/functions/groups/<group>/fmodules/<module>/source/main`.
  An include of a program needs a URI carrying its main program (V): not supported yet
  ([INC-1](roadmap.md#inc-1)).
- A `condition` on a line breakpoint is evaluated by SAP at that line (A, V). When SAP cannot evaluate
  it at run time, it stops anyway and flags the breakpoint in `reachedBreakpoints` with
  `unresolvableCondition` (and an error offset).
- `DELETE /sap/bc/adt/debugger/breakpoints/{id}?scope=…&debuggingMode=user&requestUser=…&terminalId=…&ideId=…`
  removes one breakpoint (A, S).
- Breakpoints in SAP standard code are accepted but never fire without `systemDebugging` (S), which
  the server never sets.

**How the server places a breakpoint.** It resolves the location against the active source, then
probes: SAP refuses lines without a statement, so one POST carries up to 5 candidate lines from the
requested one (up to 16 from a `METHOD` statement, blank and comment lines skipped) for every
location, and a final full sync keeps the first line SAP accepted for each, with its condition.

## 3. Listener

| Call | Contract |
|---|---|
| Conflict check | `GET /sap/bc/adt/debugger/listeners?debuggingMode=user&requestUser=…&terminalId=…&ideId=…&checkConflict=true` — an empty body: nobody else listens. An ADT exception with subtype `conflictDetected` or `conflictNotification`: another IDE (Eclipse, VS Code, another capture) listens for the user (A, V, L). |
| Listen | `POST …/listeners?debuggingMode=user&requestUser=…&terminalId=…&ideId=…&checkConflict=true&isNotifiedOnConflict=true&timeout=<seconds>`, `Accept: application/vnd.sap.as+xml` (S). A **long poll**: it answers when a program stops, on a conflict, or at the timeout — an empty body means nothing stopped (S). |
| Stop listening | `DELETE …/listeners?debuggingMode=user&requestUser=<USER>` — **by user only**: a DELETE that quotes the ids "matches no row", and the registration silently swallows the next stop (S, live). Deleting it also ends external debugging for the user and drops the user's external breakpoints (S). |

The stopped program arrives as `<asx:abap><asx:values><DATA><STPDA_DEBUGGEE>` with `DEBUGGEE_ID`,
`DEBUGGEE_USER`, `PRG_CURR`, `INCL_CURR`, `LINE_CURR`, `DBGEE_KIND` and `IS_ATTACH_IMPOSSIBLE`, on newer
releases also `URI`, `TYPE` and `NAME` (A, S), and where it waits (A, L, R): `INSTANCE_NAME` (the
server as `TH_SERVER_LIST` names it — the name a `sap-contextid` cookie carries), `APPSERVER` (its host
name, `SAPLOCALHOSTFULL`), `IS_SAME_SERVER` (that server answers the listener) and `CAN_ADT_CROSS_SERVER`
— always `true`: the ADT handler hard-codes it, saying the back end routes requests between servers,
nothing about the program ([§5](#5-reaching-the-debuggees-application-server)). `LINE_CURR` counts within `INCL_CURR` (a method include such as
`…CM004`), while `URI` numbers the line in the source as `abap_source` shows it (L): the server takes
the line from the URI, and reports `include` and `includeLine` when there is none.

The registration survives the poll's answer and must be deleted explicitly (S). A client that stops
waiting does not stop the poll on SAP's side, which runs on to its timeout — so it must not run on
the session the debugger needs (S). The server long-polls on its stateless client, as V does, with an
HTTP timeout 30 seconds beyond SAP's, and deletes the registration through it.

## 4. The debug session

Every call below runs on **one stateful session**, on the server where the program waits.

| Operation | Request | Answer and notes |
|---|---|---|
| Attach | `POST /sap/bc/adt/debugger?method=attach&debuggeeId=…&dynproDebugging=true&debuggingMode=user&requestUser=…` | `<dbg:attach isSteppingPossible isPostMortem …>` with `<reachedBreakpoints><breakpoint id kind/>`. The program is attachable only while it waits: listen and attach back to back, else `invalidDebuggee` (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`) (S). It must run on the program's own application server: the session is routed there ([§5](#5-reaching-the-debuggees-application-server), L, R). |
| Stack | `GET /sap/bc/adt/debugger/stack?method=getStack&emode=_&semanticURIs=true` | `<dbg:stack>` of `<stackEntry stackPosition stackType stackUri programName includeName line eventType eventName sourceType systemProgram isVit uri/>`. SAP_BASIS 7.50 has no `/debugger/stack` (404): `POST /sap/bc/adt/debugger?method=getStack&emode=_&semanticURIs=true` instead (A gates it on discovery, S falls back on the 404 — live on 7.50). |
| Variables | `POST /sap/bc/adt/debugger?method=getVariables`, body `<asx:abap><asx:values><DATA><STPDA_ADT_VARIABLE><ID>LV_X</ID></STPDA_ADT_VARIABLE>…`, `Content-Type: application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.Variables` | Rows `STPDA_ADT_VARIABLE`: `ID`, `NAME`, `DECLARED_TYPE_NAME`, `ACTUAL_TYPE_NAME`, `META_TYPE`, `VALUE`, `TECHNICAL_TYPE`, `LENGTH`, `TABLE_LINES`, `IS_VALUE_INCOMPLETE`, … Ids are expressions: `LS_S-COMP`, `LT_T[2]`, `ME->MV_A`, `SY-SUBRC` (V). |
| Child variables | `POST /sap/bc/adt/debugger?method=getChildVariables`, body `<DATA><HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID>…`, `dataname=com.sap.adt.debugger.ChildVariables` | `HIERARCHIES` (`PARENT_ID`, `CHILD_ID`, `CHILD_NAME`) and `VARIABLES`. `@ROOT`'s children are the frame's scopes (V shows them as the Variables view's scopes) or, on some releases, the variables directly; a structure's children are its components. Several parents fit in one request. |
| Step | `POST /sap/bc/adt/debugger?method=stepInto` — likewise `stepOver`, `stepReturn`, `stepContinue`, `stepRunToLine` (with `uri=<source URI>#start=<line>`) and `terminateDebuggee` | `<dbg:step isSteppingPossible …>`, optionally with `<reachedBreakpoints>`. `stepContinue` answering 200 means stopped again at the next breakpoint, still attached; the exception `debuggeeEnded` or `noSessionAttached` means the program ran to its end (S). `stepRunToLine` takes the target line as `uri` (A, V, S; live: it runs to the line). |
| Session breakpoints | `POST /sap/bc/adt/debugger/breakpoints` with `scope="debugger"`, or `DELETE …/breakpoints/{id}?scope=debugger&…`, on the attached session | The attached run keeps its own copies of the breakpoints, apart from the external ones (V syncs and deletes `scope=debugger` copies on each attached thread). The server deletes one copy to retire a breakpoint whose `hits` are spent, and clears them all before the release. |
| Watchpoints | `POST /sap/bc/adt/debugger/watchpoints?variableName=…&condition=…&active=true`, `DELETE …/watchpoints/{id}`, on the attached session (A) | `<watchpoints><watchpoint id variableName kind active expired procedure>` with `condition`, `oldValue`, `currentValue` texts (A). Set where the run stands, for a variable visible there; the run then stops where it changes. No request lists a run's watchpoints. The server tells a watchpoint's stop by the id in `reachedBreakpoints`, else by the watched value that changed, and deletes every watchpoint before the release — a live one would stop the releasing `stepContinue`. Not yet observed live. |
| Release | `stepContinue` until `debuggeeEnded` | `method=detach` is unknown on 7.58 (400 "Unknown method") (S); V releases the same way. `terminateDebuggee` aborts the program and its caller's request: the server sends it when an interactive session ends with `terminate: true`, and as the last resort when three continues do not end the run. |

**Accept headers.** Naming a concrete media type makes ADT answer **404 "No suitable resource found"**
on releases whose resource produces only its own vendor type — that is how 7.50's stack first looked
absent (S). The server sends `Accept: */*` on the conflict check, the attach, the stack and the steps,
and `application/vnd.sap.as+xml` on the listener and the variable calls — the shapes S verified.

**Errors** are ADT exception documents whose machine-readable part is
`<entry key="com.sap.adt.communicationFramework.subType">` (A `parseDebugError`, V): `conflictDetected`,
`conflictNotification`, `invalidDebuggee`, `noSessionAttached`, `debuggeeEnded`, `notAuthorized`.

**Exclusive and non-exclusive debugging.** A held program keeps a dialog work process for itself;
SAP allows `rdisp/wpdbug_max_no` of them at once (by default half of the dialog work processes). With
all of them taken, SAP attaches a user with debug change authorization in **non-exclusive mode**: the
program rolls out after each debugger interaction, which commits its open database work, and SELECT
loops end in a `DBIF_RSQL_INVALID_CURSOR` dump (SAP Help, *Debugging Modes*; not offered in
productive systems). The attach and step answers carry `isNonExclusive` and `isNonExclusiveToggled`
(A's `DebugState`). No capture may commit for the program, so on an attach flagged `isNonExclusive`
the server releases the program at once, reading and stepping nothing, and says why.

**Closing a session.** The server closes every stateful session it opens the way Eclipse ADT does:
`GET /sap/bc/adt/core/http/sessions` with `sap-adt-purpose: close-session` on that session's context.
Where that resource is missing (7.50), a stateless request on the context closes it. A session routed
to another server ([§5](#5-reaching-the-debuggees-application-server)) is closed without the routing
header: where it is, and the ABAP session it opened on the routed server goes with it.

## 5. Reaching the debuggee's application server

On a system with several application servers, the attach must **run on the server the program waits
on** (`INSTANCE_NAME`). What SAP's source says (R), and what was seen on the BTP ABAP Environment
trial with two servers (L):

- **Why.** The listener's answer comes from `ABDBG_ACTIVATION`, SAP's table of waiting programs. The
  attach (`CL_ABDBG_ACT_FOR_ATTACH__USER`, method `ATTACH`) reads the program's row, **deletes it and
  commits**, then attaches with the row's `DBGKEY` (C call `TPDA_ATTACH`), a key valid on the
  program's own server only. Run on any other server, that call fails: SAP answers **500
  `invalidDebuggee`** (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`), and with the row gone, **every later attach
  fails too**, from the right server as well — the refused attempt spoils the stopped program (L).
  `dynproDebugging=true|false` makes no difference (L). The handler's own subtype for this case,
  `invalidServer` with the properties `currentServer` and `debuggeeServer`, is never reached: it needs
  the row, already deleted.
- **What the fields say.** `INSTANCE_NAME` names the program's server as `TH_SERVER_LIST` does
  (`<host>_<SID>_<nr>` on-premise, `appserver-…` pods on BTP), `APPSERVER` its host; `IS_SAME_SERVER`
  compares it with the server answering the listener; `CAN_ADT_CROSS_SERVER` is hard-coded `X`
  (`CL_TPDA_ADT_RES_DEBUGGER`, `lcl_handler_get_dbgee_sessions`). The listener's registration,
  `LISTENER_CTX_ID` (empty when the program stopped elsewhere, L) and the server the listener runs on
  play no part in the attach.
- **How SAP gets a request there.** SAP's ADT handler runs a request on the server that the request
  header **`X-sap-adt-server-instance`** names: when it names another instance of `TH_SERVER_LIST`,
  the server that received the request forwards it over RFC — `CALL FUNCTION 'SADT_REST_RFC_ENDPOINT'
  DESTINATION '<instance>'` — and maps the answer back. Over HTTP that is `CL_ADT_WB_RES_APP`:
  `get_debugger_destination` picks `lcl_rfc_request_proxy_dbg`, which checks the CSRF token itself,
  drops the header (the target must not forward again) and adds `X-sap-adt-internal-server-instance:
  true`; Eclipse's RFC connections reach the same function module, which routes the same way. SAP's
  own unit test says what it is for: *"Via a special http header it is possible to route a request to
  a specific app server instance"* (`LSADT_RESTT99`). The RFC connection belongs to the ABAP session
  that opened it: in a stateful HTTP session it serves every later request, so the attach, the stack,
  the variables and the steps all reach one ABAP session on the program's server.
- **Failures.** A request SAP cannot forward answers `CX_ADT_REST_ROUTING` — type
  `ExceptionRequestRooting` (sic), subtype `ExceptionOnTargetServer` (502: the RFC failed) or
  `NoAuthorization` (403) — without having run on the target. A forwarded request runs there as the
  same SAP user, over RFC: it takes the authorization `S_RFC` for function group `SADT_REST`, which
  Eclipse ADT's RFC connections take too.
- **Releases.** Both the HTTP handler and the RFC function module route in SAP_BASIS 8.16 (S/4HANA)
  and in the BTP ABAP Environment (9.20). SAP_BASIS 7.50 routes in the RFC function module only; its
  HTTP handler ignores the header. Releases in between: not read.

So the server **opens no session ahead of the run and probes no server**. After the stop it opens one
stateful session — wherever the load balancer puts it — and every request of it carries
`X-sap-adt-server-instance: <INSTANCE_NAME>`, `sap-adt-saplb: fetch` and `saplb: <INSTANCE_NAME>`
(below). Before the attach, one harmless request (`GET /sap/bc/adt/core/http/systeminformation`) shows
where SAP runs them: the ADT handler answers `sap-adt-saplb` with its own server's name
(`cl_icm_api=>get_encoded_instance_name`, MD5-encoded under `is/instname_encoding = md5`) only for a
request it runs itself. Without the header, SAP forwarded the request; naming the program's server,
the session is there already; naming another server, SAP ignored the route — and then **no attach is
sent**, which would fail and spoil the program. On a release without that resource (7.50), which
routes no HTTP request either, the server the session landed on (`sap-contextid`) decides the same
way. A forwarding failure is reported in SAP's words, nothing attached. The session's close
(`sap-adt-purpose: close-session`) goes without the routing headers: it ends the session where it is,
and the ABAP session it opened on the program's server with it. A program without `INSTANCE_NAME`
(one application server) gets a plain stateful session.

`saplb` is for the BTP ABAP Environment's load balancer: Eclipse sends it there on the attach of a new
stateful session, whose answer's `sap-contextid` then names that server — 10 attaches of 10, 5 across
servers (mcp-abap-adt-clients, from Eclipse's Communication Log). A session placed there runs its
requests itself, with nothing to forward. On-premise nothing is known to read it (SAP Web Dispatcher
balances with `saplb_*` cookies, not this header); the ADT handler forwards instead.

Before that, the server looked for the program's server by opening sessions: a new stateful session
is load-balanced, and once a program waits, new sessions avoid its server — 16 of 16 probes landed on
the other one, either way round (L) — so it opened them before the run and ran its unit tests on one
of them, and missed whenever another trigger ran the code.

### SAP GUI runs

Where the breakpoints are armed matters for a run started from SAP GUI (G):

- External breakpoints are the user's on every server, and HTTP runs — a Fiori app's requests, a REST
  client's — stop on either server, wherever they were armed.
- A **SAP GUI dialog run stops reliably only on the server where the breakpoints were armed last**:
  arming switches debugging on for the user on that server alone. The stateless client's sync lands
  wherever the load balancer sends it. The arming stores the arming server's `RFC_SYSTEM_INFO` with
  the user's external debugging (`HTTP_DEBUG_UPDATE`, parameter `gui_rfcsi`, R): consistent with it,
  not confirmed as its cause.
- Removing the last breakpoint switches debugging off only on the server that removes it.
- SAP records one `USR41` row per SAP GUI logon — `SERVER`, `LOGON_DATE`, `LOGON_TIME` — and ADT's own
  sessions leave none. `SERVER` is the instance name SM51 shows (`<host>_<SID>_<nr>`), the name a
  `sap-contextid` cookie carries and `X-sap-adt-server-instance` takes.

So with `trigger: "none"`, where the run may come from SAP GUI, the server:

1. asks which server answers — `sap-adt-saplb: fetch` on `systeminformation` — and stops there when a
   BTP ABAP Environment pod does: it has no SAP GUI;
2. reads the user's `USR41` rows through the ADT data preview — `POST
   /sap/bc/adt/datapreview/freestyle?rowNumber=100`, `Content-Type: text/plain`, `Accept:
   application/xml, application/vnd.sap.adt.datapreview.table.v1+xml`, body `SELECT server, logon_date,
   logon_time FROM usr41 WHERE bname = '<USER>'` — and takes the latest logon's server. The answer lists
   the columns, each with its values in row order (`tableData` → `columns` → `metadata name`, `dataSet`
   → `data`);
3. opens one stateful session routed to that server and checks the route as for the attach — then
   runs the final breakpoint sync from it, after the probe sync from the stateless client, and removes
   the breakpoints from that same session at the end;
4. while it waits, reads the logons again every 5 seconds: when the latest is on another server than
   the one armed last — a SAP GUI logon opened after the capture started — it opens a session routed
   there and runs the same full sync from it. SAP may renumber the breakpoints: their old ids stay
   known, for the stops that name them. The reads stop once the wait is over, before anything is
   attached or removed, after a failed read, and never start while an exception or message breakpoint
   is armed for the whole user, since the reads themselves could stop at it.

The query runs as the session user and needs that user's authorization to display `USR41` through
the data preview; a refusal costs a warning, and the capture arms from the stateless client as before
— so does a SAP GUI server SAP cannot reach. `ABAP_DEBUGGER_SAP_GUI_LOOKUP=false` turns the lookup
off. With SAP GUI logons on several servers, only the latest one's server is armed, and the hint of a
run that did not stop names the others.

## 6. Who is debugged

Always the session's own logon user — never a name from the model, a tool argument or a token claim:

1. **SAP names it.** `GET /sap/bc/adt/core/http/systeminformation` with
   `Accept: application/vnd.sap.adt.core.http.systeminformation.v1+json` answers
   `{systemID, client, userName, userFullName, language}` for the session that asks. Under principal
   propagation each MCP user thereby gets their own **mapped** SAP user (whatever the Cloud Connector
   and `CERTRULE` produced), on the BTP ABAP Environment the internal `CB99…` user (L), under Basic
   authentication the logon user. It is asked once per capture and never cached: the answer belongs to
   the credentials that asked. Evidence: SAP Fiori tools (`@sap-ux/axios-extension` 2.1.2,
   `SystemInfoService.getSystemInfo()`, type `SystemInfo`) and vibing-steampunk (`pkg/adt/identity.go`:
   "Eclipse ADT reads it right after logon").
2. **Releases without the resource** (SAP_BASIS 7.50 and older answer 404, 405, 406 or 501): only
   `SAP_USER` counts, set beside Basic authentication (SAP accepted its password) or cookies (the
   operator vouches for it). A bearer token never supplies the user: a token's display name need not
   be the SAP user it maps to.
3. Otherwise the capture is **refused** with an explicit message. Any other failure of the request
   (401, 403, 5xx, network) is reported as it is, never replaced by a guess.

When SAP's answer and `SAP_USER` differ, SAP's answer wins: it is the user the debugger sees.

## 7. Per-release notes

| Release | Notes |
|---|---|
| 7.50 | No `/debugger/stack` resource: the dispatcher's `getStack` instead (S, live). No `systeminformation`: `SAP_USER` names the user ([§6](#6-who-is-debugged)). No close-session resource: a stateless request on the context. The ADT HTTP handler does not route requests to another application server (R): with several servers, the attach succeeds only where the session landed on the program's. |
| 7.50 and older | ADT does not natively keep a stateful session (`X-sap-adt-sessiontype: stateful`) without the `abapfs_extensions` enhancement; expect `noSessionAttached` after the attach — to verify. |
| 7.58 | `method=detach` is unknown; line, statement, exception and message breakpoints accepted (S, live). |
| 8.16 | The ADT HTTP handler routes a request to the server `X-sap-adt-server-instance` names, and answers `sap-adt-saplb: fetch` (R). |
| BTP ABAP Environment | The same resources as on-premise. Several application servers (pods): the debugger session is routed to the program's ([§5](#5-reaching-the-debuggees-application-server); the handler routes, R). `systeminformation` names the internal `CB99…` user (L). |

## 8. Observed live

On the SAP BTP ABAP Environment trial, October 2026, each user debugging as themselves (principal
propagation):

- **Triggers.** `unittest`: a line breakpoint in a class method stopped, with the stack, named locals
  and three `stepOver`s with changing values, then a `stepContinue` release with the unit test
  passing; on a RAP behavior pool, 35 of 35 tests passed around two stops. `http`: a breakpoint in the
  query provider of a custom entity, behind a freshly published OData V4 UI service, stopped under the
  SADL and Gateway V4 stack, with the request and response objects readable — though for the first
  minutes after the publish the service answered 403 "blocked by UCON". `none`: actions started by hand
  in Fiori Elements apps as the same SAP user, on a RAP draft business object (`/DMO/BP_TRAVEL_D`,
  service `/DMO/UI_TRAVEL_D_D_O4`) and a managed one without draft.
- **Breakpoints.** Line and method breakpoints (a method breakpoint lands on the `METHOD` line, SAP
  accepting it), several in one run, a loop breakpoint with `hits: 2` stopping twice through
  `stepContinue`, an exception breakpoint (`CX_SY_ZERODIVIDE`, caught) stopping where it is raised, a
  breakpoint in a `testclasses` include.
- **Steps.** `stepInto` into a local helper and from a test method into the production method,
  `stepOver`, `stepReturn`. A `stepOver` or `stepReturn` that runs into a breakpoint stops there — over
  a `MODIFY ENTITIES … EXECUTE` into a breakpoint of the called handler, out of a loop's line back to
  that line for the next pass; the server makes such a step the next stop, counting toward that
  breakpoint's `hits`. Whether SAP names the breakpoint in the step's `reachedBreakpoints` was not
  recorded, so the server also matches the top frame's position.
- **Variables.** Simple values, structure components, field symbols and tables with their rows, at
  stops and across steps. A string keeps its trailing blanks: `CONV string( 124 )` reads `"124 "` (the
  sign position).
- **Steps through SAP code** stop in places that vary: `stepOver` at the end of a handler went up into
  `CL_RAP_BHV_PROCESSOR=>EXECUTE_PRECHECKS`, while `stepReturn` out of another skipped eleven frames
  (`CL_DSP_*`, `CL_RAP_EML_*`) straight back to the caller, and `stepInto` on a `MODIFY ENTITIES` went
  straight into the called handler. Consistent with SAP skipping system programs while system
  debugging is off — not confirmed.
- **`trigger: "none"` takes the first request that stops.** The Fiori Elements list read
  (`READ_ENTITY_LIST`) ran `get_instance_authorizations` before the *Edit* click that was meant.
- **Conflicts.** With Eclipse listening for the same user, the capture is refused with SAP's conflict
  text, and nothing is armed.
- **Freshly activated code.** Once, in the 75 seconds after re-activating a class, breakpoints on a
  newly added method did not stop although the unit tests ran — consistent with the new version
  reaching the other application server late (buffer synchronization); not reproduced later.
- **Unexplained.** An unassigned field symbol reads like an empty value. A breakpoint can make fewer
  stops than its `hits` (consistent with the test data, not confirmed).

With this server, deployed over HTTP and reached as a remote MCP connector, on the same trial
(October 2026), on a demo class with harmless unit tests:

- **One run, several stops.** A loop breakpoint with `hits: 3`, two steps after each stop and five
  named variables: three stops of one run, each with its steps.
- **Conditions.** `idx = 2` stopped only on that pass. A condition naming a variable that does not
  exist was accepted when armed, and the stop came back flagged `unresolvableCondition`: SAP stopped
  regardless of it.
- **Long step runs.** 300 steps from one stop came back as one compact trace.
- **Statement kinds.** SAP lists them (`/debugger/breakpoints/statements`); an unknown kind is refused
  with that list before anything is armed.
- **Statement breakpoints armed for the whole user stop this server's own requests.** `CLEAR` armed as
  an external breakpoint caught the server's ADT requests too, which then hung past the client's time
  limit. Statement breakpoints are therefore set in the debugged run only, once a line or method
  breakpoint stopped it, and the server keeps its own requests after the arming as few as possible.
- **Method breakpoints** land on the first statement where SAP refuses the `METHOD` line itself (this
  class), on the `METHOD` line where it accepts it (the behavior pool above). `until: { changed }`
  ended the steps at the change.
- **Interactive session.** Started at a line with named variables, three steps at once, `continue`
  with `toLine` (`stepRunToLine` ran to the line), `inspect` with the stack, then `end` with
  `terminate: true`: the test method was aborted and ABAP Unit went on with the other tests.
- **The client's time limit.** The MCP client gave up on a call after 60 seconds, which ended
  captures waiting for their stop. Each call now answers within `ABAP_DEBUGGER_CALL_SECONDS` and the
  rest goes on in the background.

With the debugger session routed to the program's server ([§5](#5-reaching-the-debuggees-application-server)),
deployed on the same trial (29 October 2026; two pods, `appserver-n2nxt` and `appserver-w4krn`):

- **Routing.** Every attach succeeded, with no session opened ahead and no server probed: 10 captures
  and 3 interactive sessions, stopped on either pod, the unit tests run stateless. Whether the
  trial's load balancer placed the session (`saplb`) or the ADT handler forwarded it was not visible.
- **Interactive, a Fiori action.** *Accept Travel* clicked in the Fiori Elements preview of
  `/DMO/UI_TRAVEL_D_D_O4` stopped in `lhc_travel~acceptTravel` under the OData V4 batch, held across
  calls, stepped over and into (`MODIFY ENTITIES … IN LOCAL MODE` was stepped over: the managed
  framework runs no handler there), then released by the idle timeout; the action completed.
- **Interactive, unit tests.** A step, `continue` with `toLine`, `inspect` with the stack and the
  whole frame, then `end` with `terminate: true`: this time ABAP Unit reported the whole run
  `incomplete`, no test counted. A session held 120 s past a `DURATION SHORT` test let the run finish
  with 3 of 6 tests skipped and 4 warnings.
- **Breakpoints.** `hits: 1` on a loop line stopped the first pass only; a condition
  (`ls_item-product = 'Ink'`) skipped the pass where it did not hold; an exception breakpoint armed
  for the whole user (`CX_SY_ZERODIVIDE`, caught) stopped on the `CATCH` line; a `SORT` statement
  breakpoint, set in the run after its line breakpoint, stopped at the statement.
- **`trigger: "http"`.** A `GET` of the service's `Travel` set stopped three times in one run:
  `get_global_authorizations`, `get_instance_authorizations` (two keys), `get_instance_features`.
- **Steps.** 35 `stepInto`s, through the loop, two calls and back into the test, in 6 seconds for the
  whole capture.
- **Sources.** `abap_search` on a service binding's name, then `abap_source` from `SRVB` to `SRVD` to
  `BDEF` and its behavior pools.
- **A capture that outlasts its call.** `trigger: "none"` with 75 seconds answered after 49 with its
  session id; `abap_breakpoints` `list` meanwhile named the capture and its listener; `wait` gave the
  timeout result — no SAP GUI lookup, no warning, on the pods.
- **Watchpoints.** Set in an interactive session at a `LOOP` line on `RS_SUMMARY-TOTAL`, `hits: 2`:
  each `continue` stopped on the statement after the change, `0 → 108` then `108 → 113`, the stop
  named as the watchpoint's. A local of another method (`LV_SUBTOTAL`) was refused: *"Cannot create
  watchpoint: Variable 'LV_SUBTOTAL' not found"*, the session going on.
- **A server stopped mid-capture.** `cf restart` while a capture waited: Cloud Foundry stops the
  process with SIGTERM, the server released what it held, and `abap_breakpoints` then found no
  listener and no leftovers; the next capture ran at once. A process killed outright was not tried —
  and on Cloud Foundry its records (`ABAP_DEBUGGER_STATE_DIR`, the container's temporary directory)
  would not survive the restart, leaving the listener to its two-minute expiry and the breakpoints to
  `abap_breakpoints` with `listener: true`.

On an S/4HANA on-premise system with two application servers (October 2026), experiments with this
server's modules established where a run started from SAP GUI stops: see
[SAP GUI runs](#sap-gui-runs).

## 9. Live checks still owed

The runs above cover the BTP ABAP Environment, and SAP GUI runs on one S/4HANA system — both before the
debugger session was routed to the program's server ([§5](#5-reaching-the-debuggees-application-server)). Still to check
([LIVE-1](roadmap.md#live-1), [LIVE-2](roadmap.md#live-2), [WATCH-1](roadmap.md#watch-1)):

1. **On-premise 7.58 and 8.16**: `trigger: "unittest"` on a class with a line breakpoint — a stop, the
   stack's top on the line, the locals; record the `@ROOT` scope names (`CHILD_NAME`).
2. **7.50**: the same; the stack's dispatcher fallback, and whether the attach holds without
   `abapfs_extensions` ([§7](#7-per-release-notes)).
3. **`trigger: "http"`** on-premise, against an OData V4 RAP service with a breakpoint in the behavior
   pool.
4. **Conflict**: Eclipse debugging the same user — refused with SAP's conflict text.
5. **Cleanup**: after every path (stop, timeout, refused breakpoint, trigger error, interactive `end`,
   idle expiry), no `ABDBG_LISTENER` row and no breakpoint remain, and the trigger's request completes.
6. **Fixtures**: recorded SAP answers in place of the reference-derived test fixtures.
7. **Parallelism**: the long poll and the trigger share the logon cookie on the stateless client;
   confirm on-premise that the trigger is not queued behind the poll (on BTP they ran side by side).
8. **Stale listener**: a capture killed before its cleanup may leave its registration; how long SAP
   keeps it, and whether the next capture then reports a conflict.
9. **Arm delay**: the 1.5 seconds between arming and triggering assume SAP has registered the
   listener; measure on a busy system.
10. **Session user**: `systeminformation` on 7.58 and 8.16, and under a principal-propagation mapping
    where the identity provider's name differs from the SAP user (the mapped user is expected); the
    first release that has the resource.
11. **Cloud Connector**: the long poll (`timeoutSeconds` + 30 seconds) through the Connectivity proxy
    and the Cloud Connector's timeouts.
12. **S/4HANA Cloud Public Edition**: external breakpoints and the attach for a developer-extensibility
    user on the development tenant, the unit-test trigger, and `systeminformation` under its SAML-based
    principal propagation.
13. **Session breakpoints**: once a breakpoint's session copy is deleted, no more stops there; whether
    `reachedBreakpoints` on the attach and on a step carries the external ids.
14. **Conditions**: that a step onto the line of a condition that does not hold carries no
    `reachedBreakpoints` (an invalid condition is accepted and its stop flagged, [§8](#8-observed-live)).
15. **Message and statement breakpoints**: the message types SAP accepts (and the empty `msgTy`), and
    that it names the event breakpoint it stopped at.
16. **Long step runs**: the time one step costs (step, stack, variables) on-premise and on BTP, to tune
    the default `maxSeconds`.
17. **Interactive sessions**: how long SAP keeps a held program and its stateful session between
    calls, how the trigger's request fares meanwhile, and that `terminateDebuggee` rolls back the
    program's uncommitted work.
18. **Non-exclusive attach**: once `rdisp/wpdbug_max_no` held programs exist, what the attach answers
    for a user with debug change authorization (`isNonExclusive="true"` expected) and for one without
    (a refusal expected).
19. **A move that outlasts its call**: a `continue` the client's call no longer waits for, then
    `end` — whether SAP lets the release through while the first `stepContinue` still waits on the
    same stateful session.
20. **Watchpoints**: the create answer's shape, the `kind` SAP names in `reachedBreakpoints` at a
    watchpoint's stop, how it refuses a variable not visible where the run stands, whether a
    watchpoint on a local stops in other frames, and the condition's semantics (after the change).
21. **SAP GUI runs, end to end**: a capture through this server (not the experiment scripts) catching a
    SAP GUI run on the SAP GUI's server — armed there through a routed session — and one from a logon
    opened while the capture waits; whether a sync forwarded over RFC switches debugging on for the user
    there as a session on that server does, and whether that lasts once the routed session ends;
    whether SAP renumbers breakpoints synced again on another server; with three servers or more; the
    release.
22. **USR41 through the data preview**: SAP's answer without authorization for the table or for the
    data preview, and on a release without `/datapreview/freestyle`.
23. **SAP GUI for HTML**: whether a WebGUI session (a classic transaction opened from the Fiori
    launchpad) leaves a `USR41` row, and whether its runs behave as SAP GUI's or as HTTP runs.
24. **Routing to the program's server** ([§5](#5-reaching-the-debuggees-application-server), read in
    SAP's source only): on an on-premise system with several servers, a debuggee on another server than
    the debugger session's — the route check answering without `sap-adt-saplb`, the attach, steps,
    variables and the release all on the program's server, one ABAP session there throughout. SAP's
    answer without `S_RFC` for `SADT_REST`; the answer under `is/instname_encoding = md5`; the same on
    the BTP ABAP Environment, whose pods may not take RFC between them (Eclipse sends `saplb` there);
    the first on-premise release whose HTTP handler routes (between 7.50 and 8.16).

## What the server deliberately leaves out

- **Changing the run**: variable writes (`setVariableValue`), `stepJumpToLine` and system debugging.
  The only intervention is `terminateDebuggee`, on request or as the release's last resort.
- **Running arbitrary code**: a class run (`IF_OO_ADT_CLASSRUN`) as a trigger would execute whatever
  code it names. The triggers are ABAP Unit tests declared harmless, a read-only OData `GET`, or the
  user's own run.
- **Dynamic logpoints** (`/sap/bc/adt/dlp/logpoints`, A): non-blocking and asynchronous, a separate
  tool rather than the debugger ([LOG-1](roadmap.md#log-1)).

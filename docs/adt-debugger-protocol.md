# The ADT debugger protocol

How this server drives SAP's ABAP debugger: the ADT REST resources it calls, what SAP answers, and
what has been observed on real systems. It is the reference behind
[`src/adt/debugger.ts`](../src/adt/debugger.ts); what the tools make of it is in the
[tool reference](tools.md).

**Evidence.** The contract below is corroborated by three independent clients that drive the same
SAP resources, two of them with recorded live verification. **L** marks what was observed live on
the SAP BTP ABAP Environment in October 2026, with the capture engine this server is built on.
Everything else still has to be confirmed release by release: see [§9](#9-live-checks-still-owed).

| | Source |
|---|---|
| **A** | [abap-adt-api](https://github.com/marcellourbani/abap-adt-api) 9.2.0 — `build/api/debugger.js`, `AdtClient.js` |
| **V** | [vscode_abap_remote_fs](https://github.com/marcellourbani/vscode_abap_remote_fs) — `client/src/adt/debugger/` (`debugListener.ts`, `debugService.ts`, `breakpointManager.ts`, `variableManager.ts`) |
| **S** | [vibing-steampunk](https://github.com/oisee/vibing-steampunk) — `pkg/adt/debugger.go`, `pkg/saprfc/adtdebug.go`, and the live notes of its README |
| **L** | Live, SAP BTP ABAP Environment trial, October 2026 |

## Nothing to install on SAP

The debugger is driven over plain ADT REST, as Eclipse ADT drives it: no ABAP helper, no WebSocket,
no RFC. What it needs is **one stateful ADT session (`sap-contextid`) that lives from the attach to
the release, on the application server where the stopped program waits** ([§5](#5-reaching-the-debuggees-application-server)).
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
5. attach       POST /sap/bc/adt/debugger?method=attach on a stateful session on that program's server
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
releases also `URI`, `TYPE` and `NAME` (A, S), and where it waits: `INSTANCE_NAME` (the server name
the `sap-contextid` cookie carries), `IS_SAME_SERVER` (relative to the listener's server) and
`CAN_ADT_CROSS_SERVER` (A, L). `LINE_CURR` counts within `INCL_CURR` (a method include such as
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
| Attach | `POST /sap/bc/adt/debugger?method=attach&debuggeeId=…&dynproDebugging=true&debuggingMode=user&requestUser=…` | `<dbg:attach isSteppingPossible isPostMortem …>` with `<reachedBreakpoints><breakpoint id kind/>`. The program is attachable only while it waits: listen and attach back to back, else `invalidDebuggee` (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`) (S). Only from the program's own application server ([§5](#5-reaching-the-debuggees-application-server), L). |
| Stack | `GET /sap/bc/adt/debugger/stack?method=getStack&emode=_&semanticURIs=true` | `<dbg:stack>` of `<stackEntry stackPosition stackType stackUri programName includeName line eventType eventName sourceType systemProgram isVit uri/>`. SAP_BASIS 7.50 has no `/debugger/stack` (404): `POST /sap/bc/adt/debugger?method=getStack&emode=_&semanticURIs=true` instead (A gates it on discovery, S falls back on the 404 — live on 7.50). |
| Variables | `POST /sap/bc/adt/debugger?method=getVariables`, body `<asx:abap><asx:values><DATA><STPDA_ADT_VARIABLE><ID>LV_X</ID></STPDA_ADT_VARIABLE>…`, `Content-Type: application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.debugger.Variables` | Rows `STPDA_ADT_VARIABLE`: `ID`, `NAME`, `DECLARED_TYPE_NAME`, `ACTUAL_TYPE_NAME`, `META_TYPE`, `VALUE`, `TECHNICAL_TYPE`, `LENGTH`, `TABLE_LINES`, `IS_VALUE_INCOMPLETE`, … Ids are expressions: `LS_S-COMP`, `LT_T[2]`, `ME->MV_A`, `SY-SUBRC` (V). |
| Child variables | `POST /sap/bc/adt/debugger?method=getChildVariables`, body `<DATA><HIERARCHIES><STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>@ROOT</PARENT_ID>…`, `dataname=com.sap.adt.debugger.ChildVariables` | `HIERARCHIES` (`PARENT_ID`, `CHILD_ID`, `CHILD_NAME`) and `VARIABLES`. `@ROOT`'s children are the frame's scopes (V shows them as the Variables view's scopes) or, on some releases, the variables directly; a structure's children are its components. Several parents fit in one request. |
| Step | `POST /sap/bc/adt/debugger?method=stepInto` — likewise `stepOver`, `stepReturn`, `stepContinue`, `stepRunToLine` (with `uri=<source URI>#start=<line>`) and `terminateDebuggee` | `<dbg:step isSteppingPossible …>`, optionally with `<reachedBreakpoints>`. `stepContinue` answering 200 means stopped again at the next breakpoint, still attached; the exception `debuggeeEnded` or `noSessionAttached` means the program ran to its end (S). `stepRunToLine` takes the target line as `uri` (A, V, S; not yet observed live). |
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
Where that resource is missing (7.50), a stateless request on the context closes it.

## 5. Reaching the debuggee's application server

On a system with several application servers, the attach must come from **a session on the server the
program waits on** (`INSTANCE_NAME`). Observed on the BTP ABAP Environment trial, with two servers (L):

- From any other server SAP answers **500 `invalidDebuggee`** (`CX_ABDBG_ACTEXT_CANNOT_ATTACH`, raised
  in `CL_ABDBG_ACT_FOR_ATTACH__USER`), although the program reports `IS_ATTACH_IMPOSSIBLE=false` and
  `CAN_ADT_CROSS_SERVER=true`. `dynproDebugging=true|false` makes no difference.
- **The refused attempt spoils the stopped program**: every later attach fails the same way, from the
  right server too. Retrying is useless; the first attach has to come from the right server.
- Running the listener on a stateful session and attaching there does not help: the program waits on
  whichever server ran the trigger, not on the listener's (`IS_SAME_SERVER=false`, `LISTENER_CTX_ID`
  empty).
- The first attach from a session on the program's server succeeds, and stack, variables and steps
  follow on that session.

Nothing addresses a server directly. A new stateful session is load-balanced, and SAP names where it
landed in the `sap-contextid` cookie — `SID:ANON:<server>:<context id>`, `appserver-…` pods on BTP,
`<host>_<SID>_<nr>` on classic systems — by which the load balancer then routes the session.

**Find the server before the stop, not after.** The balancer prefers the least-loaded server, and a
stopped program loads its own (it holds a work process). Once a program waits, new sessions avoid
exactly its server: 16 of 16 probes landed on the other one, either way round, with fresh TCP
connections too. Probing after the stop worked only when other users' load happened to tip the balance.

So the server opens its sessions **before the run** (`openSessionsAhead`): stateful sessions with one
cheap `GET /sap/bc/adt/core/http/systeminformation` each, until two land on the same server (at most 6;
a balanced pair takes 3). The unit-test trigger runs on the second session of that pair, so the program
stops on its server, where the first one waits to attach. For a run the server does not place —
`trigger: "http"` or `"none"` — the attach takes whichever waiting session is on the program's server;
only when none is does it probe after the stop (`openSessionOnServer`, at most 8 sessions), usually in
vain, and the result then names the server it missed. Without a server name (no `INSTANCE_NAME`,
another cookie shape, no `systeminformation` on 7.50), the attach goes wherever it lands.

On BTP the servers are pods whose names change over time (`appserver-t4w2x` and `-rpsxx`, later
`-w4krn`, L); the server discovers them at every run.

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
| 7.50 | No `/debugger/stack` resource: the dispatcher's `getStack` instead (S, live). No `systeminformation`: `SAP_USER` names the user ([§6](#6-who-is-debugged)). No close-session resource: a stateless request on the context. |
| 7.50 and older | ADT does not natively keep a stateful session (`X-sap-adt-sessiontype: stateful`) without the `abapfs_extensions` enhancement; expect `noSessionAttached` after the attach — to verify. |
| 7.58 | `method=detach` is unknown; line, statement, exception and message breakpoints accepted (S, live). |
| BTP ABAP Environment | The same resources as on-premise. Several application servers: attach from the program's ([§5](#5-reaching-the-debuggees-application-server)). `systeminformation` names the internal `CB99…` user (L). |

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

## 9. Live checks still owed

The runs above cover the BTP ABAP Environment only, and preceded this server's own HTTP client, its
long step runs, its interactive sessions and its BTP deployment. Still to check
([LIVE-1](roadmap.md#live-1), [LIVE-2](roadmap.md#live-2)):

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
14. **Conditions**: how SAP answers an invalid condition (refused at the final sync, or a stop flagged
    `unresolvableCondition`), and that a step onto the line of a condition that does not hold carries
    no `reachedBreakpoints`.
15. **Message and statement breakpoints**: the message types SAP accepts (and the empty `msgTy`), the
    statement kinds it lists, and that it names the event breakpoint it stopped at.
16. **Long step runs**: the time one step costs (step, stack, variables) on-premise and on BTP, to tune
    the default `maxSeconds`.
17. **Interactive sessions**: how long SAP keeps a held program and its stateful session between
    calls, how the trigger's request fares meanwhile, what `stepRunToLine` and `terminateDebuggee`
    answer, and that the latter rolls back the program's uncommitted work.
18. **Non-exclusive attach**: once `rdisp/wpdbug_max_no` held programs exist, what the attach answers
    for a user with debug change authorization (`isNonExclusive="true"` expected) and for one without
    (a refusal expected).
19. **A move that outlasts its call**: a `continue` the client's call no longer waits for, then
    `end` — whether SAP lets the release through while the first `stepContinue` still waits on the
    same stateful session.
20. **Watchpoints**: the create answer's shape, the `kind` SAP names in `reachedBreakpoints` at a
    watchpoint's stop, how it refuses a variable not visible where the run stands, whether a
    watchpoint on a local stops in other frames, and the condition's semantics (after the change).

## What the server deliberately leaves out

- **Changing the run**: variable writes (`setVariableValue`), `stepJumpToLine` and system debugging.
  The only intervention is `terminateDebuggee`, on request or as the release's last resort.
- **Running arbitrary code**: a class run (`IF_OO_ADT_CLASSRUN`) as a trigger would execute whatever
  code it names. The triggers are ABAP Unit tests declared harmless, a read-only OData `GET`, or the
  user's own run.
- **Dynamic logpoints** (`/sap/bc/adt/dlp/logpoints`, A): non-blocking and asynchronous, a separate
  tool rather than the debugger ([LOG-1](roadmap.md#log-1)).

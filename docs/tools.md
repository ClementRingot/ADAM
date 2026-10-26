# Tool reference

| Tool | What it does |
|---|---|
| [`abap_debug`](#abap_debug--capture-one-run) | Arms breakpoints, runs the code and records every stop of that run — or, with `interactive: true`, holds the program at its first stop |
| [`abap_debug_session`](#abap_debug_session--drive-an-interactive-session) | Drives a held program one move at a time: step, continue, inspect, end |
| [`abap_source`](#abap_source--the-active-source-with-line-numbers) | The active source with the line numbers breakpoints use |
| [`abap_search`](#abap_search--find-objects) | Finds objects by name or pattern |

Lines are always numbered as `abap_source` shows the **active** source.

## How a capture works

1. **Resolve.** Breakpoints are resolved against the active source: a `method` breakpoint stops where
   the method is entered, and a line without a statement moves to the next line SAP accepts.
   Everything that can fail on input fails here, before any debugger state exists on SAP.
2. **Arm.** External breakpoints are set for the session's own SAP user, and SAP's debugger listener
   starts (a long poll). If Eclipse or VS Code already debugs that user, the capture refuses instead
   of taking the session over.
3. **Run.** The trigger runs the code: the object's harmless ABAP Unit tests, an OData `GET`, or
   nothing (`trigger: "none"`) while you run it yourself — a Fiori app, a report — as the same SAP user.
4. **Follow.** When the program stops, the capture attaches from the application server the program
   waits on, records the stop (position, call stack, variables, steps), retires a breakpoint once it
   has made its `hits`, and continues to the next stop of the **same run**.
5. **Release.** The program runs on to its end, and the capture's breakpoints and listener are removed —
   on every path, errors and timeouts included.

The program runs **once**, however many stops you ask for: a breakpoint in a loop with `hits: 5` shows
five iterations of one run. In a one-shot capture nothing stays stopped after the call returns (a
suspended program holds an SAP work process), so the assistant asks for every variable it needs up
front; to look again, it runs another capture — or starts an interactive session, which holds the
program at step 4 until the session ends.

The protocol behind each step is described in [the ADT debugger protocol](adt-debugger-protocol.md).

## `abap_debug` — capture one run

| Parameter | Description |
|---|---|
| `type`, `name` | The object of `line`, and the default object of every breakpoint and of the unit-test trigger: `CLAS`, `PROG` or `FUNC` |
| `line` | Shorthand for one breakpoint at this line of `type` + `name` |
| `breakpoints` | Up to 20 breakpoints — see [Breakpoints](#breakpoints) |
| `exceptionClass` | Shorthand for one exception breakpoint, e.g. `CX_SY_ZERODIVIDE` |
| `trigger` | `unittest` (default), `http` or `none` — see [Triggers](#triggers) |
| `triggerName` | The class, program or function group whose unit tests run the code, when it is not the breakpoint's object |
| `url` | `trigger: "http"`: a host-relative OData path, `/sap/opu/odata4/…` or `/sap/opu/odata/sap/<SRV>/…` |
| `variables` | Up to 20 expressions read at every stop and after every step: `LV_TOTAL`, `LS_HEAD-VBELN`, `LT_ITEMS`, `LT_ITEMS[3]`, `ME->MV_STATE`, `SY-SUBRC`. Default: every variable of the stopped frame (up to 60) |
| `steps` | Steps after each stop: 0 (default) to 10,000, as far as the budgets allow. Up to 20 come back one entry each; more as a [compact trace](#long-step-runs) |
| `stepMode` | `over` (default), `into` (follow calls) or `out` (return to the caller) |
| `until` | End the steps early: `{ line }` once the program stands on that line of the source the steps started in, `{ changed: "LV_STATUS" }` once that variable changed. Without `steps`: step until it holds |
| `maxSeconds` | Time budget once the program stopped (default 120; ceiling `ABAP_DEBUGGER_MAX_SECONDS`, default 600). A step costs two or three requests to SAP |
| `maxResultKB` | Size budget of the result, in KB of JSON (default 40, about 10k tokens; ceiling `ABAP_DEBUGGER_MAX_RESULT_KB`, default 200) |
| `interactive` | `true`: return at the first stop and keep the program waiting there for [`abap_debug_session`](#abap_debug_session--drive-an-interactive-session) |
| `timeoutSeconds` | How long to wait for the first stop (1-240, default 60) |

### Breakpoints

Each item of `breakpoints` is one of these:

| Kind | Shape | Stops |
|---|---|---|
| Line | `{ line, include?, condition?, hits?, type?, name? }` | At that line (1-based, as `abap_source` numbers it) |
| Method | `{ method, include?, condition?, hits?, type?, name? }` | Where the method is entered. `CLAS` only: `get_total`, `zif_order~process`, or a local-class method such as `lhc_travel~validate_dates` |
| Message | `{ message: { id, number, type? }, hits? }` | Where a `MESSAGE` statement issues it — any type when `type` is left out, e.g. `{ id: "ZSD", number: "042", type: "E" }` |
| Statement | `{ statement, hits? }` | At every statement of a kind, e.g. `COMMIT WORK` or `CALL FUNCTION` (a kind SAP does not know is refused with the list of those it does) |
| Exception | `{ exceptionClass, hits? }` | Where the exception is raised |

- `include` (`CLAS`): `implementations` or `testclasses` — detected for `lhc_`, `lcl_` and `ltc_` methods.
- `condition`: an ABAP condition SAP evaluates at the line, so the run stops only where it holds —
  `lv_index = 500`, `ls_item-matnr = 'X' AND sy-tabix > 10`: one pass of a long loop. When SAP cannot
  evaluate it, it stops anyway and the stop says so.
- `hits` (1-50, default 1): how many times this breakpoint may stop the run.
- `type` and `name`: the breakpoint's own object, so one run can stop in several objects.

### Triggers

| `trigger` | Runs the code by |
|---|---|
| `unittest` (default) | The harmless ABAP Unit tests of `triggerName`, else of `type` + `name`, else of the first breakpoint's object. A function module's tests are its group's |
| `http` | A `GET` of `url`, an OData path on the connected system |
| `none` | Nothing: the capture waits `timeoutSeconds` while you run the code yourself, as the same SAP user |

Saves and actions are reached through a unit test or `trigger: "none"`: the HTTP trigger only reads.

### Result

JSON with:

- `hit` — whether the program stopped;
- `breakpoints` — each one set, with the `hits` it made (`0`: the run never got there), or refused with
  SAP's reason;
- `debuggee` — program, line, application server;
- `stops` — each with `at` (the breakpoint), `stoppedAt` (the position), the call `stack` on a
  breakpoint's first stop, `variables`, and its `steps` or `trace`;
- `release`, `trigger` (the unit-test summary or HTTP status) and `warnings`.

Without a stop, the result carries the `reason` (timeout, trigger finished first, conflict) and a `hint`.

**Repeated stops.** A breakpoint's later stops — a loop — are compact: `{ stop, at, hit, values }`,
without the position and stack its first stop already showed, and with `unchanged` for a structure or
table equal to the previous stop's. A capture is bounded by what its result costs and by time, not by
counting: it follows the run until the stops and steps fill `maxResultKB` or `maxSeconds` runs out, so
two named values allow many more iterations than sixty frame variables.

### Long step runs

Past 20 steps from one stop, the steps come back as a compact `trace` instead of one entry each:

- `path` lists the lines executed, frame by frame: `10-12 (9-12)×497 13` is lines 10 to 12, then a loop
  over lines 9 to 12 run 497 times, then line 13. A segment marked `frame: entered` or `returned` is a
  call or a return.
- `changes` lists the watched variables only at the steps where they changed.

Two thousand steps of a loop fit in a few hundred characters; the time budget is then the real limit.

### How values are shown

As SAP renders them: structures one level deep, tables with their line count and first 5 rows
(`table[0]` when empty), values up to 500 characters. A string keeps its leading and trailing blanks —
they count: `CONV string( 124 )` is `"124 "` — other values are trimmed.

After a step, a structure or table equal to the previous step's reads `unchanged`, and a step that
entered or left a method says so (`frame: entered | returned | changed`): a variable of the same name
is then a different variable. A watched variable the frame cannot see is listed in `notVisible`.

## `abap_debug_session` — drive an interactive session

`abap_debug` with `interactive: true` takes the same parameters as a one-shot capture, returns at the
first stop with a session id, and keeps the program waiting there. Each `abap_debug_session` call
then makes one move and answers where the program stands: its `position`, the `code` around it (the
current line marked `>`) and the watched variables.

| Parameter | Description |
|---|---|
| `action` | `step`, `continue`, `inspect` or `end` |
| `session` | The id `abap_debug` returned (default: the open session) |
| `stepMode`, `count`, `until` | `step`: `over` (default), `into` or `out`; how many steps (default 1; past 20, a compact trace); end early on a line or a change |
| `toLine` | `continue`: run to this line of the source the program stands in, instead of the next breakpoint |
| `timeoutSeconds` | `continue`: how long to wait for the next stop (1-240, default 60) |
| `variables` | `step` and `continue`: the variables to watch from now on. `inspect`: read these now — any variable, structures expanded, tables' first rows (default: the whole frame) |
| `stack` | `inspect`: include the call stack |
| `terminate` | `end`: abort the program where it stands instead of letting it run to its end — e.g. before it commits |
| `maxSeconds`, `maxResultKB` | Budgets of this call, as for `abap_debug` |

**A held program holds an SAP work process** — and its caller's request — exactly as when a developer
stops at a breakpoint in Eclipse. So end the session when done: `end` lets the program run to its end,
removes the breakpoints and reports the trigger's outcome. A session is also released automatically:

- after `ABAP_DEBUGGER_IDLE_SECONDS` without a call (default 120 s);
- after `ABAP_DEBUGGER_SESSION_SECONDS` in all (default 15 min);
- when the server stops or the MCP client disconnects.

Every answer says how long the session has left. One session per user at a time: while it is open,
other captures for the same SAP user are refused.

## `abap_source` — the active source with line numbers

| Parameter | Description |
|---|---|
| `type`, `name` | `CLAS`, `PROG` or `FUNC`, and the object's name |
| `include` | `CLAS`: a local-class include instead of the main source — `implementations`, `testclasses` or `definitions` |
| `method` | `CLAS`: just this method, numbered as in the whole source |
| `lineStart`, `lineEnd` | A range of lines |
| `grep` | A case-insensitive regular expression: matching lines with one line of context |

At most 1,500 lines per call.

## `abap_search` — find objects

The repository quick search: exact name, type, package and description for a name or pattern
(`query`: `ZCL_ORDER*`, `*TRAVEL*`), optionally of one `objectType`, at most `maxResults` (default 30).

## Examples

Stop in a method while the class's unit tests run — stack and local variables:

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{method: "get_total"}]}
```

Two variables and three steps from a line:

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, variables: ["LV_TOTAL", "LT_ITEMS"], steps: 3}
```

Five loop iterations, then the line after the loop — one run:

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, hits: 5}, {line: 60}], variables: ["LV_TOTAL"]}
```

Only the 500th pass of the loop:

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{line: 42, condition: "sy-tabix = 500"}], variables: ["LS_ITEM"]}
```

A RAP validation, through its OData V4 service, stopping in two objects:

```text
abap_debug {type: "CLAS", name: "ZBP_I_TRAVEL",
            breakpoints: [{method: "lhc_travel~validate_dates"},
                          {type: "CLAS", name: "ZCL_TRAVEL_RULES", method: "check_dates"}],
            trigger: "http", url: "/sap/opu/odata4/sap/zui_travel/srvd/sap/ztravel/0001/Travel"}
```

Run `ZREPORT` yourself, as the same SAP user, while the capture waits:

```text
abap_debug {type: "PROG", name: "ZREPORT", line: 30, trigger: "none", timeoutSeconds: 120}
```

Where is this exception raised? Which code issues error ZSD 042, and for which order? Who commits?

```text
abap_debug {exceptionClass: "CX_SY_ITAB_LINE_NOT_FOUND", trigger: "unittest", triggerName: "ZCL_ORDER"}
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{message: {id: "ZSD", number: "042", type: "E"}}], variables: ["LS_ORDER"]}
abap_debug {type: "CLAS", name: "ZCL_ORDER", breakpoints: [{statement: "COMMIT WORK", hits: 3}]}
```

Follow 2,000 statements — a compact trace of the lines, `LV_TOTAL` where it changed:

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, steps: 2000, variables: ["LV_TOTAL"], maxSeconds: 600}
```

Step until `LV_STATUS` changes, and show where:

```text
abap_debug {type: "CLAS", name: "ZCL_ORDER", line: 42, until: {changed: "LV_STATUS"}}
```

An interactive session — each answer shows the position, the code around it and the watched values:

```text
abap_debug         {type: "CLAS", name: "ZCL_ORDER", line: 42, interactive: true}
abap_debug_session {action: "step", variables: ["LV_TOTAL"]}
abap_debug_session {action: "step", stepMode: "into"}
abap_debug_session {action: "inspect", variables: ["LS_HEAD", "ME->MT_ITEMS"], stack: true}
abap_debug_session {action: "continue", toLine: 80}
abap_debug_session {action: "end"}
```

## Limits

- **Per call:** 20 breakpoints and 50 stops; steps as far as `maxResultKB` (default 40 KB) and
  `maxSeconds` (default 120 s) allow, each capped by the server's ceiling. A one-shot capture then
  lets the program go on without stopping, an interactive session keeps it waiting; a warning says
  which bound ended the call. A client that cancels the call stops it the same way.
- **One capture per SAP user** at a time, and one interactive session per MCP user.
- **Progress.** Clients that ask for progress notifications get one at most every two seconds while a
  call waits for the first stop or records stops and steps — some clients keep a long call alive on
  them.

**Several application servers** (the BTP ABAP Environment and larger on-premise systems): SAP attaches
only from the server the program stopped on. The capture opens sessions before the run until two land
on the same server, and runs its unit tests on one of them, so the stop and the attach meet. With
`trigger: "http"` or `"none"` it can attach only where it already has a session; when it cannot, the
result says which server was missed — retry.

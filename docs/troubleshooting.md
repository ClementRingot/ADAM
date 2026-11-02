# Troubleshooting

**The unit tests finished without reaching the breakpoint.** No harmless test covers that code, or the
code was activated moments ago and has not reached the application server that ran it yet (wait
about a minute). Use `triggerName` for a test class elsewhere, or `trigger: "none"`.

**`trigger: "http"` fails with 403 "blocked by UCON".** A service published moments ago can be refused
for a few minutes on the BTP ABAP Environment; check the URL works on its own.

**`trigger: "none"` stops at the wrong request.** The capture takes the first request of that user that
reaches a breakpoint: in a Fiori Elements app the list read may come before the action you meant.
Start the capture once the page has loaded, then trigger the action, and prefer breakpoints in code
only that action runs.

**"Another debugger is already listening for SAP user …".** Eclipse, VS Code or another capture is
debugging the same SAP user, and a capture never takes such a session over. End that debug session
first, then retry. If none runs — a capture whose server was killed leaves its listener for up to two
minutes — `abap_breakpoints` with `action: "delete"` and `listener: true` removes it.

**The SAP user's requests stop at odd places in Eclipse.** Breakpoints of a capture whose server was
killed may still be armed: `abap_breakpoints` with `action: "list"` shows them, `"delete"` removes them
(the next capture of the user removes them too).

**A run started from SAP GUI does not stop, while the same code run from a Fiori app does.** On some
systems a session opened from SAP Logon or SAP Business Client (SM04: type `GUI`) never stops at
external breakpoints — Eclipse's neither. A session opened through transaction SM51 (SM04: type `RFC`)
does: once the capture waits, select the application server in SM51, then *Goto → Remote Logon →
Normal*, and run the code in the new session — a session opened before the
capture started does not stop either. Prefer `trigger: "unittest"` or `"http"` where
the code allows. Why GUI sessions ignore them is a question for the system's Basis team or SAP (kernel
patch, profile parameters): see [SAP GUI runs](adt-debugger-protocol.md#sap-gui-runs).

**`reason: "conflict: …"` right after the capture started.** Another debugger activation of the same
SAP user ended the wait — most often external breakpoints set in SAP GUI (ABAP Editor; SAP GUI shows
*ED702 "Debugging hindered by external development environment"*), which exclude ADT's. Delete them
in SAP GUI (*Utilities → Breakpoints → Delete*, Ctrl+Shift+F12 in the ABAP Editor), or stop the other
IDE's debugger, and retry.

**"SAP could not reach the debuggee's application server …" or "SAP did not route the debugger session
…".** The program stopped on another server than the one the capture's session landed on, and SAP did
not run the session's requests there: the RFC to that server failed — most often the user lacks the
`S_RFC` authorization for function group `SADT_REST`, which Eclipse ADT needs as well — or the release
does not forward ADT requests between servers (SAP_BASIS 7.50 does not). Nothing was attached; the
program waits at its breakpoint until SAP stops waiting for a debugger.

**`ADT network error: fetch failed: …` behind a corporate proxy.** Set `SAP_PROXY`, with
`user:password@` when the proxy answers `Proxy response (407)`. A proxy that inspects TLS signs with
its own certificate authority (`unable to get local issuer certificate`): give Node.js that certificate
with `NODE_EXTRA_CA_CERTS` — see [Configuration](configuration.md#connecting-to-sap).

**"Cannot tell which SAP user this session runs as".** The release lacks
`/sap/bc/adt/core/http/systeminformation` (SAP_BASIS 7.50 and older): set `SAP_USER` to the logon user.

**An unassigned field symbol** reads like an empty value; read it where it is assigned.

**A message breakpoint never stops** although the message appears: it catches `MESSAGE` statements
only. RAP messages (`new_message( … )` in `reported`) and BAPI return tables carry a message without
issuing it; search the message number in the source (`abap_source` with `grep`) instead.

**An interactive session was released.** It is released after `ABAP_DEBUGGER_IDLE_SECONDS` without a
call (default 120 s), after `ABAP_DEBUGGER_SESSION_SECONDS` in all (default 15 min), and when the
server stops — on SAP BTP also by a restage or a redeploy. Start a new one.

**"SAP attached in non-exclusive mode".** Every work process the SAP system allows for exclusive
debugging is taken — by other held programs, Eclipse sessions included (`rdisp/wpdbug_max_no`). In that
mode each debugger step would commit the program's open database changes, so the capture let the
program run on untouched. Retry once a debug session has ended; if it keeps happening, the system
needs a higher `rdisp/wpdbug_max_no` or more dialog work processes.

**A call answered `running: true`.** The capture or the move needs longer than one call may take
(`ABAP_DEBUGGER_CALL_SECONDS`, default 50 s) and goes on in the background: call `abap_debug_session`
with `action: "wait"` for its answer, or `action: "end"` to stop it.

**The client says the tool call timed out** (`… timed out after 60s`). The client gave up before the
server answered, and cancelled the call — which stops the capture. Set `ABAP_DEBUGGER_CALL_SECONDS` a
few seconds below the client's timeout.

**"Debug captures running on this server: 4 of 4" (or sessions).** The server caps how many programs
it holds at once, since each takes an SAP dialog work process; wait for one to end, or raise
`ABAP_DEBUGGER_MAX_CAPTURES` / `ABAP_DEBUGGER_MAX_SESSIONS` within what the SAP system allows — see
[sizing](configuration.md#sizing-against-the-sap-system).

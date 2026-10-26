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
first, then retry.

**The attach fails on a system with several application servers.** With `trigger: "http"` or `"none"`
the program may stop on a server where the capture holds no session; the result names the server it
missed. Retry, or use the unit-test trigger, which runs where the capture can attach.

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

# Configuration

The server reads environment variables: the `env` block of the MCP client's server entry, or a file
passed with `--env-file /path/to/.env` (see [.env.example](../.env.example)). A server that is not
configured still starts; every tool call then says what is missing.

## Connecting to SAP

**On-premise, user and password.**

```bash
SAP_URL=https://my-sap-host:44300
SAP_CLIENT=100
SAP_USER=DEVELOPER
SAP_PASSWORD=secret
```

**On-premise, single sign-on cookies.** `SAP_COOKIE_FILE` (Netscape format, as curl or a browser
extension exports it; re-read when SAP rejects the session) or `SAP_COOKIE_STRING`
(`MYSAPSSO2=…; SAP_SESSIONID_…=…`). On SAP_BASIS 7.50 and older, also set `SAP_USER` to the logon
user: those releases cannot say whom the cookies belong to, and the debugger needs that user.

**SAP BTP ABAP Environment.** Create a service key for the ABAP instance in the BTP cockpit, save it
as a file and set `SAP_BTP_SERVICE_KEY_FILE` (or `SAP_BTP_SERVICE_KEY` with the JSON inline) instead of
URL and credentials. On the first call the server opens your browser for the SAP login — the flow
Eclipse ADT uses — and then refreshes the token by itself.

**Behind a corporate proxy.** Set `SAP_PROXY`, with `user:password@` when the proxy asks for a login.
The server does not read `HTTPS_PROXY`, so an internal SAP system is never sent through a proxy by
surprise. A proxy that inspects TLS signs with its own certificate authority: give Node.js that
certificate with `NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem` in the client's `env` block (Node.js
reads it at startup, so not from `--env-file`) rather than turning `SAP_INSECURE` on.

**On SAP BTP Cloud Foundry**, the server reaches SAP through a destination instead — see the
[deployment guide](btp-deployment.md).

## Settings

| Variable | Meaning |
|---|---|
| `SAP_URL` | SAP system URL, e.g. `https://my-sap-host:44300` |
| `SAP_CLIENT` | Client, e.g. `100` (default: the system's default client) |
| `SAP_LANGUAGE` | Logon language (default `EN`) |
| `SAP_USER`, `SAP_PASSWORD` | Basic authentication |
| `SAP_COOKIE_FILE` | Netscape cookie file, re-read when SAP rejects the session |
| `SAP_COOKIE_STRING` | Inline cookies: `name=value; name2=value2` |
| `SAP_BTP_SERVICE_KEY_FILE`, `SAP_BTP_SERVICE_KEY` | BTP ABAP Environment service key (file, or inline JSON); URL and client come from it |
| `SAP_BTP_OAUTH_CALLBACK_PORT` | Port of the local login callback (default: a free port) |
| `SAP_PROXY` | Corporate proxy for SAP and the BTP login, e.g. `http://proxy.example:8080`; HTTPS goes through it as a tunnel |
| `SAP_INSECURE` | `true` skips TLS certificate checks — test systems only |
| `SAP_DISABLE_SAML` | `true` asks SAP not to redirect to SAML single sign-on |
| `SAP_ABAP_RELEASE` | SAP_BASIS release (e.g. `758`): the ABAP grammar used to locate methods in classic code |
| `ABAP_DEBUGGER_MAX_SECONDS` | Ceiling of a call's `maxSeconds` (10-3600, default 600) |
| `ABAP_DEBUGGER_MAX_RESULT_KB` | Ceiling of a call's `maxResultKB` (5-1000, default 200) |
| `ABAP_DEBUGGER_IDLE_SECONDS` | An interactive session is released after this long without a call (10-3600, default 120) |
| `ABAP_DEBUGGER_SESSION_SECONDS` | An interactive session is released after this long in all (60-14400, default 900) |
| `ABAP_DEBUGGER_CALL_SECONDS` | A tool call answers within this time; a capture or move that takes longer goes on in the background (10-3600, default 50) — see [below](#calls-that-take-longer) |
| `ABAP_DEBUGGER_MAX_CAPTURES` | One-shot captures running at once on this server (1-100, default 4) |
| `ABAP_DEBUGGER_MAX_SESSIONS` | Interactive sessions open at once on this server (1-100, default 4) |
| `ABAP_DEBUGGER_STATE_DIR` | Where each capture records its debugger identity while its breakpoints may be armed, so that what a killed capture leaves behind can be found and removed (default: `abap-debugger-mcp` in the system's temporary directory) |
| `ABAP_DEBUGGER_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` — logs go to stderr |

### Calls that take longer

Many MCP clients give up on a tool call after 60 seconds, while a capture may wait minutes for its
stop (`trigger: "none"` while you open the app) or follow a long run, and an interactive `continue`
may wait as long for the next stop. So a call answers within `ABAP_DEBUGGER_CALL_SECONDS` (default
50): work that is not done by then goes on in the background, and the call answers `running: true`
with the session id. `abap_debug_session` with `action: "wait"` waits for the answer again,
`action: "end"` stops it. If your client gives up sooner than 60 seconds, set the variable a few
seconds below its timeout; a client that waits longer can take a higher value and fewer `wait` calls.

### Sizing against the SAP system

While a capture or a session holds a program at a stop, SAP keeps a dialog work process for it
(exclusive debugging). SAP limits how many at once with the profile parameter `rdisp/wpdbug_max_no`
— by default half of the dialog work processes — and Eclipse users debugging the same system take
from the same pool. Keep `ABAP_DEBUGGER_MAX_CAPTURES` plus `ABAP_DEBUGGER_MAX_SESSIONS` well below it,
especially on a shared server on SAP BTP.

SAP also ends a debugging session after `rdisp/max_debug_lazy_time` (600 seconds by default) without
debugger activity, and terminates the request that was debugged — a batch job alone continues. Keep
`ABAP_DEBUGGER_IDLE_SECONDS` below that value, so that this server releases a forgotten program
before SAP aborts it.

### Over HTTP

With `--http` (or `ABAP_DEBUGGER_TRANSPORT=http`) the server serves Streamable HTTP at `/mcp`, on SAP
BTP Cloud Foundry or any host; these settings apply too. The [deployment guide](btp-deployment.md#settings)
lists the values the MTA sets on BTP.

| Variable | Meaning |
|---|---|
| `SAP_BTP_DESTINATION` | BTP destination of the SAP system: `PrincipalPropagation` (on-premise, through the Cloud Connector) or `OAuth2UserTokenExchange` (BTP ABAP Environment) — each user as themselves |
| `ABAP_DEBUGGER_API_KEYS` | Comma-separated API keys (20+ characters each), besides XSUAA OAuth when an XSUAA instance is bound |
| `ABAP_DEBUGGER_ALLOW_SHARED_USER` | `true` accepts one SAP identity for every MCP user (`SAP_URL` + `SAP_USER`, or a Basic destination) — they can then catch each other's runs |
| `ABAP_DEBUGGER_PORT`, `ABAP_DEBUGGER_HOST` | Port (default `8080`; `PORT` on Cloud Foundry) and bind address (default `127.0.0.1`; `0.0.0.0` on Cloud Foundry) |
| `ABAP_DEBUGGER_PUBLIC_URL` | Public URL for the OAuth metadata behind a reverse proxy (default: the Cloud Foundry route) |
| `ABAP_DEBUGGER_DCR_SIGNING_SECRET` | 32+ characters: keeps the MCP clients' OAuth registrations valid across deployments |
| `ABAP_DEBUGGER_ALLOWED_ORIGINS` | CORS origins of browser MCP clients |

## Command line

```text
abap-debugger-mcp [--env-file <path>] [--http]
abap-debugger-mcp --version
abap-debugger-mcp --help
```

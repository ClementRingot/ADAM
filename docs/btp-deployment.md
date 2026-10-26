# Deploy on SAP BTP Cloud Foundry

On SAP BTP the server runs as a Cloud Foundry app, deployed as an MTA: XSUAA signs the MCP clients
in, the Destination service names the SAP system, and the Connectivity service reaches an on-premise
system behind the Cloud Connector. Each MCP user signs in once in the browser and then debugs **as
their own SAP user** (principal propagation): SAP's authorization checks apply to them, and the
debugger catches only their runs.

```text
MCP client (Claude, VS Code, Cursor…)
  │  OAuth (XSUAA, dynamic client registration) → bearer token
  ▼
abap-debugger-mcp on Cloud Foundry   /mcp (Streamable HTTP), scope "debug"
  │  user token → Destination service (PrincipalPropagation)
  ▼
Connectivity proxy → Cloud Connector → SAP ICM (certificate mapped to the user: CERTRULE)
  ▼
SAP: the ADT debugger, as the user's own SAP user
```

The sign-in (XSUAA OAuth with dynamic client registration, API keys) and the destination lookups come
from the [`@arc-mcp/xsuaa-auth`](https://www.npmjs.com/package/@arc-mcp/xsuaa-auth) library.

## Before you start

| What | Owner | Done when |
|---|---|---|
| A Cloud Foundry space with entitlements for XSUAA (`application`), Destination (`lite`) and Connectivity (`lite`) | BTP administrator | `cf marketplace` lists the three plans |
| On-premise: the Cloud Connector connected to the subaccount, with principal propagation configured (system certificate, CA, subject pattern) and a mapping to the SAP system exposing `/sap/bc/adt` with all sub-paths (plus the OData paths you trigger with `trigger: "http"`) | Cloud Connector / Basis | The Cloud Connector's connection check succeeds |
| SAP side of principal propagation: trust the Cloud Connector's CA (STRUST), map certificates to users (CERTRULE), ICM settings | Basis | CERTRULE maps a sample certificate to the intended user |
| Each debugging user: ADT access (`S_ADT_RES`) and debug authorization (`S_DEVELOP` with `OBJTYPE = DEBUG`, `ACTVT = 03`) | Security | The user can debug in Eclipse ADT |
| On your machine: the `cf` CLI with the MultiApps plugin (`cf install-plugin multiapps`), MBT (`npm install -g mbt`), Node.js 22.12+ | You | `cf deploy --help` and `mbt --version` answer |

### Principal propagation to an on-premise system

The standard SAP setup, summarized; SAP's step-by-step guide is
[Configure Identity Propagation for HTTPS][sap-pp-https].

In the **Cloud Connector** (*Configuration → On Premise*, then *Cloud To On-Premise*):

1. A **system certificate**: the Cloud Connector's identity towards the ABAP system (mutual TLS).
2. A **CA certificate**, which signs the short-lived X.509 certificate issued for each user
   ([Configure a CA Certificate][sap-ca]).
3. **Trust** in the subaccount's identity provider ([Set Up Trust][sap-trust]).
4. A **subject pattern** for the short-lived certificates, e.g. `CN=${name}`
   ([Configure Subject Patterns][sap-subject]).
5. A **system mapping**: back-end type *ABAP System*, protocol HTTPS, the internal host and port, a
   virtual host and port, principal propagation allowed with principal type *X.509 Certificate*; and
   the resource `/sap/bc/adt` with *Path and all sub-paths*, plus the OData paths you trigger with
   `trigger: "http"` ([Configure Access Control (HTTP)][sap-access]).

In the **ABAP system**:

1. `STRUST`, *SSL Server Standard*: import the issuer of the Cloud Connector's system certificate (the
   certificate itself if it is self-signed) and add it to the certificate list.
2. `RZ10`: let the ICM trust the Cloud Connector's system certificate, then restart the ICM in `SMICM`
   (kernel 7.42 and lower: `icm/HTTPS/trust_client_with_subject` and `icm/HTTPS/trust_client_with_issuer`):

   ```text
   icm/trusted_reverse_proxy_<x> = SUBJECT="<system certificate's subject>", ISSUER="<its issuer>"
   ```
3. `login/certificate_mapping_rulebased = 1`, and in `CERTRULE` a rule that maps the short-lived
   certificates to SAP users — import a sample certificate the Cloud Connector generates from the
   subject pattern ([Rule-Based Mapping of Certificates][sap-certrule]).
4. `SICF`: the ADT services (`/sap/bc/adt`) accept *Logon Through SSL Certificate*.

### The BTP ABAP Environment

No Cloud Connector: an `OAuth2UserTokenExchange` destination in the same subaccount, with the client
ID, client secret and token URL (`<uaa url>/oauth/token`) of a service key of the ABAP instance
([OAuth User Token Exchange Authentication][sap-token-exchange]).

[sap-pp-https]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/configure-identity-propagation-for-https-a8bb87a.md
[sap-ca]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/configure-a-ca-certificate-d0c4d56.md
[sap-trust]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/set-up-trust-a4ee70f.md
[sap-subject]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/configure-subject-patterns-58803a2.md
[sap-access]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/configure-access-control-http-e7d4927.md
[sap-certrule]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/rule-based-mapping-of-certificates-4f8540f.md
[sap-token-exchange]: https://github.com/SAP-docs/btp-connectivity/blob/main/docs/1-connectivity-documentation/oauth-user-token-exchange-authentication-e3c333f.md

## 1. Create the destination

In the subaccount: **Connectivity → Destinations → Create**.

| Field | On-premise system | BTP ABAP Environment |
|---|---|---|
| Name | e.g. `A4H_PP` | e.g. `ABAP_ENV` |
| Type | HTTP | HTTP |
| URL | `http://<virtual host>:<port>` — the Cloud Connector's virtual host, `http` even when the system speaks HTTPS behind it | `https://<id>.abap.<region>.hana.ondemand.com` |
| Proxy Type | OnPremise | Internet |
| Authentication | PrincipalPropagation | OAuth2UserTokenExchange (client and token URL from the ABAP instance's service key) |
| Location ID | your Cloud Connector's, if it has one | — |
| Additional property | `sap-client` = your client, e.g. `001` | — |

The server checks the destination at its first call: an identity per user, an `http://` URL behind the
Connectivity proxy. A `BasicAuthentication` destination is refused — every user would debug as one SAP
user and could catch each other's runs — unless you set `ABAP_DEBUGGER_ALLOW_SHARED_USER=true` for a
deployment a single person uses.

## 2. Configure and deploy

```bash
git clone https://github.com/ClementRingot/abap-debugger.git
cd abap-debugger
cp mta-overrides.mtaext.example mta-overrides.mtaext    # set SAP_BTP_DESTINATION (and a route if you like)

cf login -a https://api.cf.<region>.hana.ondemand.com
mbt build
cf deploy mta_archives/abap-debugger-mcp_0.1.0.mtar -e mta-overrides.mtaext
cf app abap-debugger-mcp                                  # shows the route
```

The deployment creates the XSUAA, Destination and Connectivity instances, binds them, and starts **one**
instance (256 MB). Keep it at one: an interactive session holds the program and its debugger session in
the process, and the next call must reach the same process.

Recommended once: a dedicated secret for the MCP clients' OAuth registrations, so they stay valid when
the XSUAA binding changes —

```bash
cf set-env abap-debugger-mcp ABAP_DEBUGGER_DCR_SIGNING_SECRET "$(openssl rand -hex 32)"
cf restage abap-debugger-mcp
```

## 3. Give users the role

**Security → Role Collections → ABAP Debugger (\<space\>)** → add the users (or a group of your
identity provider). The role collection carries the scope `debug`, which every tool call needs.

## 4. Connect the MCP clients

The server URL is `https://<route>/mcp`. On the first connection the client opens the browser for the
BTP login; it registers itself (dynamic client registration) — nothing to configure in XSUAA.

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http abap-debugger https://<route>/mcp` |
| Claude Desktop, claude.ai | Settings → Connectors → Add custom connector → `https://<route>/mcp` |
| VS Code (`.vscode/mcp.json`) | `{ "servers": { "abap-debugger": { "type": "http", "url": "https://<route>/mcp" } } }` |
| Cursor (`.cursor/mcp.json`) | `{ "mcpServers": { "abap-debugger": { "url": "https://<route>/mcp" } } }` |

Clients that cannot sign in through OAuth can use an API key (`ABAP_DEBUGGER_API_KEYS`, sent as
`Authorization: Bearer <key>`) — but an API key names no SAP user, so it works only with a shared
identity (see step 1).

## 5. Check

```bash
curl https://<route>/health          # {"status":"ok","name":"abap-debugger-mcp","version":"…"}
```

Then, in the client: `abap_search {query: "ZCL_*"}` (runs as you on SAP) and a first capture —
`abap_debug` on a class with unit tests. `cf logs abap-debugger-mcp --recent` shows the server's log;
it never logs tokens.

## How it behaves on BTP

- **One SAP user per MCP user.** The debugger debugs the user SAP names for the session
  (`/sap/bc/adt/core/http/systeminformation`), never a name passed in a call, and each user reaches only
  their own interactive session.
- **Interactive sessions** end on `end`, after `ABAP_DEBUGGER_IDLE_SECONDS` without a call, after
  `ABAP_DEBUGGER_SESSION_SECONDS` in all, and when the app stops: Cloud Foundry stops an app with SIGTERM
  and kills it ten seconds later, so the server releases the held programs first. A restage or redeploy
  therefore ends open sessions.
- **Long calls**: a one-shot capture may wait `timeoutSeconds` for its stop and then inspect for
  `maxSeconds` (ceiling `ABAP_DEBUGGER_MAX_SECONDS`, 600 s by default). The server sends progress
  notifications to clients that ask for them.

## Settings

The MTA sets the values below; override them in `mta-overrides.mtaext` (an extension can add or
override a property, never remove one).

| Variable | Default on BTP | Meaning |
|---|---|---|
| `SAP_BTP_DESTINATION` | — (required) | The destination of the SAP system |
| `SAP_LANGUAGE` | `EN` | Logon language |
| `ABAP_DEBUGGER_ALLOW_SHARED_USER` | `false` | Accept one SAP identity for every MCP user (Basic destination) |
| `ABAP_DEBUGGER_MAX_SECONDS`, `ABAP_DEBUGGER_MAX_RESULT_KB` | `600`, `200` | Ceilings of a call's time and result size |
| `ABAP_DEBUGGER_IDLE_SECONDS`, `ABAP_DEBUGGER_SESSION_SECONDS` | `120`, `900` | Interactive session limits |
| `ABAP_DEBUGGER_DCR_SIGNING_SECRET` | XSUAA client secret | Signs the MCP clients' registrations (set with `cf set-env`) |
| `ABAP_DEBUGGER_API_KEYS` | — | Comma-separated API keys (20+ characters), besides XSUAA |
| `ABAP_DEBUGGER_ALLOWED_ORIGINS` | — | CORS origins of browser MCP clients |
| `ABAP_DEBUGGER_PUBLIC_URL` | the CF route | Public URL behind a reverse proxy (e.g. SAP API Management) |

## Without SAP BTP

The same HTTP mode runs on any host: `ABAP_DEBUGGER_TRANSPORT=http` (or `--http`), API keys for the
clients, and `SAP_URL` + `SAP_USER`/`SAP_PASSWORD` — one SAP identity for every caller, so only with
`ABAP_DEBUGGER_ALLOW_SHARED_USER=true` — behind a reverse proxy that terminates TLS. Bind address
`ABAP_DEBUGGER_HOST` (default `127.0.0.1`, `0.0.0.0` on Cloud Foundry), port `ABAP_DEBUGGER_PORT`
(default `8080`).

## Known dependency risk

The SAP Cloud SDK chain (`@sap-cloud-sdk/connectivity` → `jks-js` → `node-forge`) carries the
unpatched advisory [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) (RSA
signature verification in node-forge), for which no fixed release exists yet. Check the advisory
before deploying.

## Status

The BTP mode is tested with the SAP Cloud SDK and XSUAA calls simulated: OAuth discovery and API-key
authentication over real HTTP, the destination checks, the per-user identity headers, and the
Connectivity proxy's plain forward proxying (it refuses CONNECT) against a real local proxy. The MTA
builds with MBT, and a staged app (runtime dependencies only) starts. A first deployment on a real
subaccount is still to come — see the [roadmap](roadmap.md).

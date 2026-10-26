# Roadmap

Ideas, not commitments. Each entry says why it remains and how to resume it.

| ID | Idea | Priority | Effort | Status |
|---|---|---|---|---|
| [FEAT-95](#feat-95) | Compact repeated stops with a result-size budget | P2 | M | Ready |
| [LIVE-1](#live-1) | Live verification of this standalone build | P1 | S | Needs a system |
| [NET-1](#net-1) | Corporate HTTP proxy (`HTTPS_PROXY`) | P3 | S | Ready |
| [INC-1](#inc-1) | Breakpoints in program and function-group includes | P3 | S | Needs research |

<a id="feat-95"></a>
## FEAT-95 — Compact repeated stops with a result-size budget

**Idea.** From a breakpoint's second stop on, return only the values (or only the values that
changed) as a compact entry, and end the capture on a result-size budget next to the 120 s
inspection budget, instead of the fixed caps of 10 stops and 40 steps.

**Why it remains.** The fixed counters are a poor proxy for cost: ten stops with two named variables
are small, ten stops with sixty frame variables are large. A size budget allows many more `hits` when
the output stays small, while keeping the result readable for the model.

<a id="live-1"></a>
## LIVE-1 — Live verification of this standalone build

**Idea.** Run the capture scenarios of the research dossier (§9) with this server — not ARC-1 — on
the BTP ABAP Environment and on-premise 7.50, 7.58 and 8.16.

**Why it remains.** The capture logic was live-tested inside ARC-1 on the BTP ABAP Environment; this
server ports it over a new, minimal HTTP client, tested so far against simulated SAP answers only.

**Resume with.** Basic auth on an on-premise system (one class with unit tests, one loop, one RAP
behavior pool with `trigger: "none"`), then the BTP browser login; record the answers as fixtures.
Conditional breakpoints follow the reference clients (abap-adt-api, vscode_abap_remote_fs) and need
their own checks: how SAP answers an invalid condition (refused at the final sync, or a stop flagged
`unresolvableCondition`), and that a step onto the line of a condition that does not hold carries no
`reachedBreakpoints`.

<a id="net-1"></a>
## NET-1 — Corporate HTTP proxy

**Idea.** Honor `HTTPS_PROXY` / `NO_PROXY` (undici's `EnvHttpProxyAgent`) for systems reached through
a corporate proxy, with `SAP_INSECURE` applied to the proxied TLS connection too.

<a id="inc-1"></a>
## INC-1 — Breakpoints in includes

**Idea.** Accept `INCL` breakpoints (report includes, function-group includes such as `LZFGF01`).

**Resume with.** Verify the breakpoint URI SAP expects for an include used by one main program, and
how it answers for an include several programs use (Eclipse asks for the main-program context).

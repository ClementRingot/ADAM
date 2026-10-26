# Roadmap

Ideas, not commitments. Each entry says why it remains and how to resume it.

| ID | Idea | Priority | Effort | Status |
|---|---|---|---|---|
| [FEAT-94](#feat-94) | Conditional breakpoints | P2 | S | Needs research |
| [FEAT-95](#feat-95) | Compact repeated stops with a result-size budget | P2 | M | Ready |
| [LIVE-1](#live-1) | Live verification of this standalone build | P1 | S | Needs a system |
| [NET-1](#net-1) | Corporate HTTP proxy (`HTTPS_PROXY`) | P3 | S | Ready |
| [INC-1](#inc-1) | Breakpoints in program and function-group includes | P3 | S | Needs research |

<a id="feat-94"></a>
## FEAT-94 — Conditional breakpoints

**Idea.** Let a breakpoint carry an ABAP condition, e.g. `{ "line": 42, "condition": "lv_index = 500" }`,
so the run stops only where the condition holds.

**Why it remains.** In a loop a capture can only stop on the first `hits` passes (at most 10), so
reaching iteration 500 is impossible today. ADT line breakpoints accept a `condition` attribute
(abap-adt-api's `formatBreakpoint` sends it), which would replace hundreds of stops with one.

**Resume with.** Verify how SAP reports an invalid or unresolvable condition (`reachedBreakpoints`
carries `unresolvableCondition`) and surface it in the breakpoint report.

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

<a id="net-1"></a>
## NET-1 — Corporate HTTP proxy

**Idea.** Honor `HTTPS_PROXY` / `NO_PROXY` (undici's `EnvHttpProxyAgent`) for systems reached through
a corporate proxy, with `SAP_INSECURE` applied to the proxied TLS connection too.

<a id="inc-1"></a>
## INC-1 — Breakpoints in includes

**Idea.** Accept `INCL` breakpoints (report includes, function-group includes such as `LZFGF01`).

**Resume with.** Verify the breakpoint URI SAP expects for an include used by one main program, and
how it answers for an include several programs use (Eclipse asks for the main-program context).

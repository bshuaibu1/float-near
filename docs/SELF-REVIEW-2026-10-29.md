# Self-review, 2026-10-29

Adversarial read of the value-moving and authority-moving paths, run as a judge
rather than as the author. Evidence or it did not happen; severity calibrated to
reachability x impact x trigger probability, not blast radius.

Three findings, one observation. Two of the three are mine, from today.

---

## F1 — HIGH. The adapter is an unauthenticated spending endpoint on all interfaces

`packages/float-adapter/src/server.ts`

```
453: server.listen(env.port, () => {
455:   console.log(`listening on http://127.0.0.1:${env.port}`);   // FALSE
137:   res.setHeader("access-control-allow-origin", "*");
139:   res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
140:   if (req.method === "OPTIONS") return res.writeHead(204).end();
276:   if (url.pathname === "/v1/pay" && req.method === "POST") {   // signs with the agent key
```

**There is no authentication of any kind.** Grepped for
`authorization|bearer|apiKey|401|unauthorized`: **0 hits**. Positive control —
the single match for "auth" in the whole file is the string
`"content-type, authorization"` inside a CORS header name, which proves the
grep finds what is there.

Three separate mistakes compound:

1. **`listen(port)` with no host binds `0.0.0.0`**, every interface — not
   loopback. Anyone who can route to the machine can reach it.
2. **The log line says `127.0.0.1`.** It is wrong, and it is the kind of wrong
   that stops someone checking.
3. **CORS is wildcard and the preflight succeeds** (`204`, `allow-methods`
   includes POST). `application/json` is not a safelisted content type, so a
   browser preflights — and this server approves it. **Any website the operator
   visits can POST to the adapter and spend.** That is drive-by, not merely LAN.

**Impact.** An attacker spends the vault's entire remaining daily budget. Two
real mitigations keep this out of Critical: the payee allowlist means funds can
only go to recipients the owner already approved, and the caps bound the value.
So it is destruction of the day's budget rather than theft — unless an
allowlisted payee is attacker-controlled, in which case it is theft up to the
daily cap.

**Why it matters more than the number suggests:** the whole product claim is
"the agent cannot exceed its budget." An unauthenticated HTTP endpoint that
spends *on the agent's behalf* means anyone can exhaust that budget without
holding the agent's key at all.

**Fix:** bind `127.0.0.1` explicitly, require a bearer token from the
environment on every mutating route, and drop the CORS wildcard to the
dashboard's exact origin. Smallest version that removes drive-by: bind loopback
and echo the real bound address instead of a hardcoded string.

---

## F2 — MEDIUM. An agent can drain the vault's NEAR, which no cap governs

`contracts/vault/src/lib.rs`, the `Route::Intents` arm — **introduced today.**

Every cross-chain payment attaches `DEPOSIT_ADDRESS_STORAGE` (0.00125 NEAR) to
register the quote's one-time deposit address. That cost is **per transaction**.
The budget tree bounds **token value**. Nothing bounds the NEAR.

Measured live on `float.test015.near`:

| | |
| --- | --- |
| NEAR balance | 2.9913 |
| locked as code storage stake | ~2.8584 |
| **spendable** | **~0.1329** |
| registrations that funds | **~106** |

There is **no minimum payment amount** — `amount.0 == 0` is the only rejection
(lib.rs:1145) — and every node's `cooldown_sec` is **0** on the default tree
(create-float.mjs:634), confirmed live on all four nodes.

So ~106 payments of 0.01 USDC — **1.06 USDC total, inside the 2.04 daily cap** —
exhaust the vault's spendable NEAR and kill the cross-chain rail. No dust
required, no cap exceeded, nothing the contract would call abusive.

**Capability delta: yes.** The agent gains the ability to spend a vault
resource that no limit covers. That is precisely the class of thing this
product exists to prevent.

**Not Critical:** recoverable by topping up NEAR, and it destroys availability
rather than stealing funds. **Not Low:** it is agent-triggerable, cheap, needs
no privilege, and a retry loop reaches it by accident.

**Why the tests missed it:** `intents_registration.rs` proves ONE payment
registers correctly. Nothing asserts anything about N payments, and the cost is
only visible in aggregate. A per-transaction cost is invisible to a
per-transaction test.

**Candidate fixes**, cheapest first: a minimum amount on the Intents rail; a
non-zero default `cooldown_sec` in the wizard's tree; or a per-day NEAR-spend
ceiling in the contract. The first two need no contract change.

---

## F3 — LOW. Cooldown is checked on the paying node only, never its ancestors

`contracts/vault/src/lib.rs:1209-1215`

```rust
let node = self.get_node(node_id);
let last = self.last_paid_ns.get(&node_id).copied().unwrap_or(0);
if node.cooldown_sec > 0 && now < last.saturating_add(...) { blocked(Cooldown) }
```

Every other check in `dispatch_payment` iterates `chain` — frozen, per-tx cap,
daily budget, token allowed. **Cooldown alone does not.** An ancestor's
cooldown is never read, so a rate limit set on a parent is bypassed by paying
from a child, and with two sibling leaves the parent's intended interval is
halved.

**Low, not Medium:** cooldown defaults to 0 so most vaults never set one, it is
a rate limiter rather than a value bound, and it is owner-configured. But it is
an undocumented asymmetry in a loop whose other four checks are hierarchical —
exactly the broken-symmetry shape that is worth fixing before someone relies on
it.

---

## Observation, not a finding

**Agent keys are plaintext on disk** in `.float/` (gitignored). Identical to
AgentCash's `~/.agentcash/wallet.json`, which this project's own research
criticised. The difference that makes it defensible here: that key can call
exactly one method on exactly one contract and cannot attach a deposit, so
stealing it buys the thief only what the budget already allows. Worth stating
explicitly somewhere user-facing rather than leaving the comparison implicit.

---

## Checked and found sound

Recorded so a later reader knows these were examined rather than skipped.

- **`resolve_reservation`** — single resolution point for both rails,
  idempotency gate on `status != TransferPending`, uses `reserved_day` rather
  than `today()` so a post-midnight callback cannot decrement a zeroed ledger,
  checked arithmetic both directions.
- **Two-pass budget check** — pass one mutates nothing, so no chain can be
  half-charged; pass two only runs if every level passed.
- **The quote-signature gate** precedes the allowlist-bypassing deposit
  address, which is what keeps the payee allowlist meaningful on the
  cross-chain rail. Verified on mainnet by `capedge`: a bad signature registers
  nothing.
- **`sweep_stuck_pending`** — the "tokens left but the callback died" window is
  a real under-count, but it is owner-only, age-floored, explicitly documented
  with its mitigation, and tagged `SWEPT_STUCK` to stay distinguishable in an
  audit. A documented tradeoff by a privileged actor is not a finding.
- **`bind_agent` vs `bind_virtual_agent`** — the many-to-one asymmetry is
  deliberate and documented; both are owner-gated. `assert_bindable` correctly
  refuses the owner and the vault itself.
- **`withdraw`** — owner-gated, deliberately outside the budget hierarchy with
  stated reasoning; an owner who can rewrite every cap gains nothing by it.

## Not reviewed

- `apps/dashboard` — vendored Next.js app from the Solana product, not written
  here.
- The Rust unit tier and the sandbox tier themselves.
- `packages/mcp` beyond the signing path and env handling.


---

# Addendum — PoCs and refutation tests

The first pass of this document shipped F1 as HIGH on a code trace alone. The
commander skill is explicit that a High does not ship without an executable
PoC, so this addendum either earns each finding or labels it as reasoned-only.

## F1 — PROVEN, executably, with a precondition

Adapter started on port 8799 with NO agent key, so nothing could be spent.

**1. Bound to every interface**, not loopback:

```
TCP    0.0.0.0:8799    0.0.0.0:0    LISTENING    30172
TCP    [::]:8799       [::]:0       LISTENING    30172
```

IPv4 and IPv6, all interfaces. The server's own log line claims
`listening on http://127.0.0.1:8799`. That is false.

**2. Cross-origin preflight from a hostile origin is approved:**

```
curl -X OPTIONS http://127.0.0.1:8799/v1/pay   -H "Origin: https://evil.example"   -H "Access-Control-Request-Method: POST"   -H "Access-Control-Request-Headers: content-type"

HTTP/1.1 204 No Content
access-control-allow-origin: *
access-control-allow-methods: GET, POST, OPTIONS
```

A browser will therefore proceed with the real POST.

**3. There is no auth gate — the NEGATIVE control:**

```
POST /v1/pay  Origin: https://evil.example  {"amount":"0.01",...}
HTTP/1.1 400 Bad Request
```

**400, not 401.** The request reached body validation. A server with
authentication rejects before parsing the body; this one has nothing to reject
at. That is the decisive evidence, and it is why the test was run with no agent
key: a 400 on the body proves reachability without moving money.

**PRECONDITION, found by devil's advocate.** `/v1/pay` can only sign when
`NEAR_VAULT_AGENT_KEY` is present. The wizard writes it to `.float/adapter.env`
**only when an agent account was created** (create-float.mjs:772-773); with the
default `--agents 0` both lines are commented out, which is why this machine's
file has none. So:

| configuration | exposure |
| --- | --- |
| `--agents 0` (default) | GET routes leak vault state to the network and to any website. No spending. |
| `--agents 1+` (documented, prompted for) | full — anyone reachable can spend the remaining daily budget |

Kept at HIGH rather than downgraded: creating agents is the product's entire
purpose and the wizard prompts for it, so the vulnerable configuration is the
intended one. The allowlist and caps are what keep it out of Critical.

**Devil's advocate, answered:** "nobody runs the adapter" is false — the
wizard's own closing text instructs
`set -a && . .float/adapter.env && set +a && npx @near-vault/float-adapter`
(create-float.mjs:885), which sources exactly the file holding the key.

## F2 — CONFIRMED by refutation test, no executable PoC

The attack needs many small payments. The cheapest thing that could kill it is
1Click refusing to quote small amounts — then the daily cap would bound the
payment COUNT, not just the value. Tested live:

```
deliver 0.010000 -> amountIn 0.012531  QUOTABLE
deliver 0.020000 -> amountIn 0.022634  QUOTABLE
deliver 0.050000 -> amountIn 0.052943  QUOTABLE
```

Not refuted. 106 payments at 0.012531 charge **1.328 USDC against a 2.04 daily
cap**, so the NEAR is exhausted first and well inside one day.

**Honest label: this has arithmetic plus live measurement, not an executable
PoC.** A proper one is a sandbox test making N payments and asserting the
vault's NEAR falls — buildable in the existing tier, not yet built. Treat F2 as
a well-evidenced MEDIUM, not a proven one.

## F3 — reasoned only

Read from source. No PoC, no live test. Labelled LOW partly for that reason.

## What this addendum changes about the first pass

Nothing about the findings' substance, and that is worth saying plainly: both
survived the attempt to kill them. What changed is that F1 is now evidence
rather than argument, and F2 and F3 carry honest labels about how far their
evidence actually goes.


---

# Addendum 2 — F2 now has an executable PoC, and it corrected the arithmetic

`contracts/integration-tests/tests/intents_registration.rs ::
many_small_payments_drain_near_that_no_cap_bounds`

Five payments of 0.01 USDC, each to a FRESH deposit address (which is what
1Click mints, so a drain never benefits from an already-registered one):

```
  5 payments of 10000 base units:
token charged to the budget : 50000 base units
NEAR spent by the vault     : 5520368048093700000005 yocto
                              (1104073609618740000001 per payment)
```

**0.05 USDC of budget consumed 0.00552 NEAR.** The token cost scales with the
amount; the NEAR cost does not scale at all.

## The PoC corrected my arithmetic, and not in the product's favour

The first version asserted `>= 0.00125 * 0.9` per payment, reasoning that
0.00125 NEAR is attached per registration so roughly that much must leave. **It
failed.** The measured net is ~0.0011 NEAR — about 12% less than the attached
deposit, some of which evidently returns through refund accounting. The test
now asserts a measured floor and says so; the exact refund mechanism is not
claimed, because it was not measured.

That makes the finding slightly **worse**: at ~0.0011 rather than 0.00125, the
~0.1329 NEAR spendable on the live mainnet vault funds roughly **120**
payments, not 106.

This is the same mistake the first pass of this document made in a different
place — asserting a number I reasoned to instead of one I measured. The
difference is that this time a test caught it before it was published as fact.

## Evidence status, final

| finding | severity | evidence |
| --- | --- | --- |
| F1 adapter unauthenticated, all interfaces | HIGH | **executable PoC** — netstat bind, 204 preflight from a hostile origin, 400-not-401 on POST |
| F2 agent drains vault NEAR | MEDIUM | **executable PoC** — sandbox test, 5 payments, measured balance fall; plus a live refutation test showing 0.01 USDC is quotable |
| F3 cooldown not hierarchical | LOW | reasoned from source only |

31 sandbox tests (was 30).

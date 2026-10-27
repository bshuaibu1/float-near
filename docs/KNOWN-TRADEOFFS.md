# Known tradeoffs and residual edges

Measured on testnet 2026-10-26 against `v2.floatvault-12329.testnet` and
`v1.signer-prod.testnet`. Numbers here are observations, not estimates; where
something is reasoned rather than measured it says so.

This file is the source for the README's limitations section. It is kept
separate so the numbers can be updated without rewriting prose.

---

## 1. Who pays for a Base-rail payment

The intuition that "the vault is the predecessor on the signer call, so the
vault pays the gas" is **wrong**, and it is worth stating why because it
changes which mitigations are needed.

On NEAR the transaction *signer* prepays gas for the entire receipt chain the
transaction spawns. The agent attaches 280 Tgas; that funds the vault's
execution, the cross-contract `sign` call, and the callback. Measured from the
agent key's remaining allowance:

| Action | Allowance before | after | cost |
| --- | --- | --- | --- |
| One Base payment, including the MPC `sign` call | 0.5 N | 0.4985340624371167 N | **0.00146594 N** |
| One blocked attempt (refused before the signer) | 0.5 N | — | **~0.00024578 N** |

So the function-call key allowance is a **hard per-agent gas budget that NEAR
enforces for free**: at 0.5 N an agent can make roughly 341 Base payments
before its key stops working entirely and the owner must consciously top it
up. That is the per-agent rate limit, already present, not something to add.

What the vault itself pays per signature is **1 yoctoNEAR** — the deposit the
signer requires. Measured: the vault's balance moved by exactly `-1` yocto
across one Base payment. Draining 1 NEAR this way takes 10^24 requests. This is
not a vector.

## 2. The real resource vector is STORAGE, not gas

Each stored request consumes vault storage, and NEAR stakes the vault's own
balance against it. Measured across one Base payment:

```
storage_usage  251948 -> 252307   = +359 bytes
```

At NEAR's 1e19 yocto/byte that is **0.00359 N of the vault's balance locked per
retained request**. The vault currently holds 3.998 N with ~2.519 N already
staked for the contract code, leaving ~1.48 N free — about **412 requests**
before new payments fail for want of storage.

This is the honest griefing statement:

- An agent cannot *steal* through this. It locks the vault's NEAR, it does not
  move it anywhere.
- The daily budget does **not** bound request COUNT in any useful way. A node
  with a 100 USDC cap and a 1-unit minimum payment permits 100,000,000
  requests by amount alone. What actually bounds the count is the key
  allowance (§1).
- With several agents, their allowances sum, so a fleet can collectively reach
  the storage wall even though no single key can.

### Mitigations, in order of how much they actually do

1. **Function-call key allowance** — hard, automatic, already enforced by the
   protocol. ~341 payments per 0.5 N. This is the main defence.
2. **`purge_settled`** — owner-only, already implemented. Reclaims the storage
   of settled requests and therefore the staked balance. Deliberately does NOT
   refund budget (asserted by
   `purge_settled_removes_history_without_refunding_the_budget`).
3. **Per-node `cooldown_sec`** — partial, and only if configured. It is
   optional and defaults to 0, so it mitigates nothing unless the owner sets
   it. A 60-second cooldown caps a node at 1,440 requests/day, which is above
   what its key allowance affords anyway — so this helps against *bursts*, not
   against the storage wall.

### What production would add

A hard per-agent per-day request cap, or requiring the agent to reimburse the
vault's storage stake. Neither is implemented. The project ships with the key
allowance as the bound, which is a real bound but a coarse one — an owner who
funds a key generously is also raising the storage ceiling that key can reach.

## 3. Gas ceiling on the Base rail — CLOSED

This was a genuine hole and is now fixed; recorded here because the reasoning
matters more than the fix.

The budget tree constrains USDC. It says nothing about the native ETH the
vault's derived Base address must hold to pay for gas — and the agent supplies
`max_fee_per_gas`, `max_priority_fee_per_gas` and `gas_limit`. Without a
ceiling, an inflated pair yields a *validly signed* transaction that burns that
ETH. The leash would hold on the token and leak on the fee. This was the only
path by which an agent could move value outside the budget.

`BaseConfig::max_tx_fee_wei` is now a hard ceiling, owner-set, and the rail
refuses `FEE_CEILING_EXCEEDED` before anything is charged and before the signer
is reached.

The ceiling is on the **product**, not on each field. The most a 1559
transaction can ever cost is `gas_limit * max_fee_per_gas`; the network charges
`gas_used * (base_fee + min(priority, max_fee - base_fee))`, which is always
less than or equal to that. Capping the fields independently would leave their
product unbounded in combination — 20 gwei is an ordinary gas price and 30M is
an ordinary block gas limit, but together they are 0.6 ETH.

Live config uses 0.01 ETH. A normal transfer is 100,000 gas x 20 gwei = 0.002
ETH, so that allows a 5x fee spike while bounding the worst case well below any
sane gas balance.

`max_tx_fee_wei = 0` is rejected rather than accepted, because a zero ceiling
would close the rail while the config still read as open. Use
`set_base_config(null)` to close it deliberately.

A priority fee above the max fee is also refused (`INVALID_FEE_FIELDS`): that
transaction is malformed under EIP-1559 and Base would reject it, so the vault
should not spend a signature request on it.

See `docs/MUTATIONS.md` M26/M27 — including the fact that the first version of
the overflow test passed against a `wrapping_mul` and had to be rewritten with
inputs that wrap to zero.

## 4. A stuck reservation

If the signature or transfer callback itself panics or runs out of gas, NEAR
rolls back only that callback's receipt — the `pending` charge taken in the
dispatching receipt survives. The budget stays reserved at every level of the
chain until something releases it.

Bounded honestly:

- An agent cannot **steal** value this way. It can only lock budget.
- The lock is per-day: the ledger is keyed by `(node, token, day)`, so a stuck
  reservation stops mattering once the day rolls over.
- The callbacks are deliberately small and bound how much of the promise result
  they copy (`MAX_PROMISE_RESULT_LEN`, `MAX_MPC_RESULT_LEN`) precisely so they
  cannot be pushed out of gas by a large return value.

`sweep_stuck_pending(limit)` closes this. Owner-only, it releases such a
reservation through `resolve_reservation` — the same single place both rails
use, so it is released exactly once and a late callback finds a non-pending
status and becomes a no-op.

Two details that are deliberate:

- The outcome is tagged `SWEPT_STUCK`, not `TRANSFER_FAILED`, so an audit can
  tell an owner's intervention apart from a rail that actually reported
  failure.
- The age floor (`MIN_SWEEP_AGE_NS`, one hour) is a **constant, not a
  parameter**. An owner who could pass zero could release a live reservation
  whose callback was about to land.

**The tradeoff, stated plainly.** On the NEP-141 rail, if `ft_transfer`
succeeded and only the callback died, the tokens have already left the vault.
Sweeping then releases a reservation for a spend that genuinely happened, and
the budget under-counts it. The age floor makes that window negligible, not
impossible — an owner should check the token balance before sweeping a
NEAR-rail request. The alternative, no sweep at all, locks the budget until the
day rolls over and the storage permanently, which is worse.

A swept request also becomes terminal and therefore purgeable. Before the sweep
existed, `purge_settled` could never reclaim a stuck request's storage, because
it takes only terminal requests.

## 5. What the contract proves about Base, and what it does not

A successful `sign` promise proves the vault obtained a signature over a
transaction it built itself. It does **not** prove that the transaction was
relayed, included, or that USDC moved. Relaying is off-chain and the contract
cannot observe it. This is why `SIGNED` is a distinct reason code from
`SETTLED`, and why the dashboard shows `signed` rather than `success` for that
rail.

### Operator-facilitated delivery — DEMONSTRATED on testnet 2026-10-26

The full loop has now been run end to end:

```
request      relay-1793046018, authorized on NEAR, reason_code SIGNED
Base tx      0x7b44c3757569c2e410045be1c188f6d64b2eb595bdf2c6b8a7ca7de1d4f91d8a
receipt      status SUCCESS, block 50643542, gas used 44843
Transfer     5.00 USDC  0x2beff9b5...c759 -> 0x4200...0006
operator     20.00 -> 15.00 USDC   (measured, predicted before the send)
payee        12.10 -> 17.10 USDC   (+5.00 exactly)
NEAR budgets unchanged by the delivery
```

The user funded NEAR only. They never funded the vault's derived Base address.

Run a second time to show the path is repeatable, not a one-off:

```
request      xcheck-1793047796, 3 USDC
Base tx      0x3eda86b8c624e8ce5be395d2f53a7c0bb3a0150fcb60e07469dcfaa2e00b3103
receipt      status SUCCESS, block 50813910
operator     15.00 -> 12.00 USDC
payee        17.10 -> 20.10 USDC   (+3.00 exactly)
```

And re-running the FIRST request with `--send` refused rather than paying
again:

```
Already delivered: 0x7b44c375... (operator)
Refusing to pay twice for one authorization.
```

That check runs before the operator key is even read, so a replay cannot spend
the float even with the key present. 8.00 USDC delivered across two runs,
every balance delta predicted before the send and matched exactly.

**This leg is CUSTODIAL.** The operator holds the Base float, pays the gas, and
could decline to deliver — delivery is a promise backed by the operator, not by
the chain. Describe it as operator-facilitated. It is not trustless and must
not be presented as such.

What keeps it honest is the authorization gate: the relayer rebuilds the
transaction from the request the CONTRACT stored and refuses to move anything
unless the MPC signature over that rebuild recovers to the vault's derived
address. So the operator can fail to pay, but cannot be directed to pay someone
the vault did not authorize. Tested in both directions — a mismatched signature
recovers to a different address and is refused.

### Vault-signed delivery — still UNPROVEN

`--mode vault` broadcasts the MPC-signed transaction itself, which needs no
operator and is not custodial. It has NOT been demonstrated: the vault's
derived address `0x75e2bc908d3eaf42c680404d7770b6b0ec0e7333` holds no ETH and
no USDC.

#### The nonce defect — FIXED

The nonce is part of the SIGNED payload and the caller used to supply it. With
a hardcoded 0 only the first such transaction could ever land; the rest were
rejected as nonce-too-low **after their NEAR reservation had already been
consumed** — budget spent, nothing delivered. Reading the chain first does not
fix it either: two payments in the same block read the same value and sign for
the same nonce.

`Route::BaseUsdc` keeps its `nonce` field, but the value is now DISCARDED and
replaced with one the contract allocates monotonically before the request is
persisted.

Keeping the field was not cosmetic. `Route` is stored inside `PaymentRequest`,
and all fifteen requests on the live vault are Base-routed with that field in
their borsh bytes. Deleting it shifts every following byte, so those records
would have failed to deserialise and `list_requests` — and the whole dashboard
— would have broken the moment the new code was deployed. `serde(default)`
lets new callers omit it while borsh keeps reading the old records as written.
This was caught by checking the live vault's stored routes, not by the test
suite, which passed throughout. It is the only place that
sees every Base signature in a serial order, so it is the only place the
allocation can be made without racing.

Three consequences worth stating plainly:

- **Allocation is optimistic.** The counter advances when a signature is
  REQUESTED; the nonce only becomes real when somebody broadcasts the
  transaction. A signature that is never sent leaves a gap, and an EVM gap
  stalls every later transaction behind it.
- **A failed signature reclaims its nonce, but only when it is still the most
  recent allocation.** If a concurrent payment has already taken the next one,
  rolling back would hand the same number out twice — the exact collision this
  change removes. The gap stands instead, and `set_base_nonce` resyncs. Trading
  a rare stall for a duplicate nonce would be a bad trade.
- **The contract cannot read Base, so it cannot detect or repair a gap.** Only
  the owner can compare against the real account. `set_base_nonce` is that
  escape hatch, and moving the counter backwards is legitimate *and* dangerous:
  if the skipped transactions are later broadcast, the reissued nonces collide.
  The event records both values so the move is auditable.

The relayer's authorisation gate had to change with it. That gate rebuilds the
exact transaction from the stored request and refuses to move anything unless
the signature recovers to the vault's derived address — and the nonce is part
of that rebuild. The contract now records the signed nonce per request
(`get_request_nonce`), under its own storage key rather than as a field on
`PaymentRequest`, which would have changed the borsh layout of every record
already on chain. The relayer treats a missing nonce as a hard stop: defaulting
to 0 would rebuild the wrong transaction and reject a legitimate payment.

Operator mode never had this problem — it reads its own nonce at send time,
after authorization.

#### What is still unproven

Delivery itself. The derived address still holds no ETH, so `--mode vault` has
never broadcast anything. The nonce is no longer the blocker; funding is.

#### A coverage gap found while fixing this

`Route::BaseUsdc` had **no unit tests at all** — removing a field from it broke
nothing in `cargo test`. Its only coverage was the sandbox tier, which cannot
even compile on Windows (`near-workspaces` fails its build script), so on this
machine the Base rail was effectively untested. It now has unit coverage for
allocation, reclaim, owner resync, and storage isolation.

That gap also produced a false pass worth recording: the first two reclaim
tests re-implemented the rule beside the real one, because the logic lived
inline in a callback no unit test can reach. A mutation inverting the real
condition survived all 90 tests. The decision is now a named function that both
the callback and the tests call, and the same mutation fails immediately.

## 6. A config error no test could catch: chain id vs token address

Found while costing out the relayer, not by any test.

The live vault was configured with `chain_id: 84532` (Base Sepolia) and
`usdc_address: 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` — which is the Base
**MAINNET** USDC. Verified against a Base Sepolia node on 2026-10-26:

```
0x833589fcd6edb6e08f4c7c32d4f71b54bda02913   NO CONTRACT
0x036cbd53842c5426634e7929541ec2318f3dcf7e   code present, symbol() = "USDC"
```

A transaction signed under that config would have been perfectly valid and
would have called an address with no code on Sepolia — the transfer would do
nothing while every NEAR-side assertion still passed.

**No test could have caught this**, and that is the point worth keeping: the
signer is a mock and no chain is involved, so the contract's own view of
correctness ("I signed what I authorized") is satisfied either way. The pairing
only matters to a *relayed* transaction, which is precisely the thing this
project does not do. It is a configuration fact about the outside world, and
the only way to check it was to ask the outside world.

Fixed in the live config and in the test fixture — the fixture does not care
about the value, but a repo that shows a mainnet address beside a testnet chain
id teaches the wrong pairing to whoever copies it next.

The general shape: `max_tx_fee_wei`, `chain_id`, `usdc_address`,
`derivation_path` and `domain_id` are all owner-set facts about an external
chain. The contract validates their SHAPE (lowercase 20-byte hex, non-zero
ceiling) and cannot validate their TRUTH. Anyone deploying this must check the
token address against the chain id they are using.

## 9. Exact concurrency, measured on testnet

`i4_contention_seed_*` establishes the property against any interleaving. This
is the same property observed on the live chain.

### Two agents, one block

r1 and r2 each drew 60 USDC against a shared 100 USDC pool, fired from
parallel background shells 1 ms apart:

```
block hash     B1sac98arB9z...   IDENTICAL for both
block height   274986096         IDENTICAL for both
r1             SIGNED
r2             PARENT_DAILY_BUDGET
pool after     60 of 100         not 120
r2's own node  0 of 100          its own limit never bound
```

### Sixteen agents, one pool

Topology, legal today with no constant changed: `root(100) -> swarm(10) ->
s0..s15(10 each)`. 160 USDC of allowance above a 10 USDC pool, 16x
overcommitted. `MAX_CHILDREN` is exactly 16 and `MAX_DEPTH` 3 is fully
consumed, which is also why agents cannot spawn children without a depth bump.

```
launch spread        4 ms across all 16
block distribution   14 transactions in block 274988232
                      2 transactions in block 274988231
admitted             10
PARENT_DAILY_BUDGET   6
pool after           EXACTLY 10.00 of 10.00
a refused agent      0.00 of its own 10.00 cap
```

Fourteen agents contended inside a single block and the pool landed exactly on
its cap. The refused agents were not throttled by their own limits — each held
its full personal headroom. Only the shared ancestor ledger bound them, which
is what makes this a contention result rather than a per-agent-limit result.

**What it does not show.** Same-block inclusion is not guaranteed; it depends
on where the ~1 s block boundary falls, and a later run could spread further.
"Exactly N admitted" holds regardless of block placement. "All in one block"
is the part that varies, so a recorded run is the honest demo asset.

**Provisioning cost.** 16 restricted keys at the documented 0.5 N floor plus
0.05 N storage = 8.80 N, attached by the owner. The floor was NOT lowered to
save testnet tokens: per §1 it IS the per-agent rate limit, so shaving it
would have quietly undercut the anti-griefing argument.


## 10. The owner could not leave, and could not be replaced — FIXED

Two absences that compounded into the worst failure this contract had, both
found by auditing the design before building an onboarding wizard on top of it.

**What was wrong.** `owner` was written once in `new` and never again: there
was no transfer, no recovery, no second admin. Separately, the only route
tokens could take out of the vault was `request_payment`, to an **allowlisted**
recipient, under a daily cap. The owner had no withdrawal at all.

Each is survivable alone. Together they are a trap:

- Lose the owner key and the vault freezes in whatever configuration it held at
  that instant — caps, recipients, freeze flags, all permanent — with the funds
  still inside. If no agent was bound, or the node was frozen, or the owner was
  never allowlisted as a recipient, the money is unreachable by anyone, for
  ever.
- Even with the key, recovering a deposit meant allowlisting yourself and
  draining it through capped agent payments. A 10,000 USDC deposit under a
  100/day cap is a hundred-day drip.

**What was added.**

- `propose_owner(Option<AccountId>)` / `accept_ownership()` — a two-step
  handover. Two steps, not one, because a single `set_owner` taking immediate
  effect would hand the vault to whatever string was typed, and a typo would
  recreate exactly this unrecoverable state, instantly and irreversibly.
  Requiring the nominee to accept proves the account exists and holds its keys
  before any authority moves. `propose_owner(None)` cancels.
- `withdraw(token, amount, receiver_id)` — owner-only, outside the budget
  hierarchy. Caps bound what AGENTS may spend; applying them to the owner's own
  exit is what created the drip. An owner who can already rewrite every cap
  gains no new capability here, so there is no escalation — only a path that
  should have existed from the start. Deliberately **not** gated on `paused`:
  an escape hatch a pause can close is not an escape hatch.

**Residual edges.**

- Withdrawing can leave less on hand than outstanding reservations expect. Those
  transfers then fail at the token contract and their reservations are released
  by the existing `resolve_reservation` / `sweep_stuck_pending` machinery. No
  accounting is corrupted; a payment simply does not complete.
- The nominated owner is stored under its own storage key rather than as a
  `Vault` field, so the borsh layout is unchanged and the live vault can be
  upgraded in place with its tree, ledgers and payment history intact
  (`scripts/upgrade-testnet.sh`). **Any future change that adds a struct field
  loses this property and needs a migration.**

## 11. The daily window is a cliff, not a rolling 24 hours — OPEN

`today() = block_timestamp / day_len_ns` is a fixed window aligned to the Unix
epoch. Two consequences a user will not expect from the words "daily budget":

- It resets at **00:00 UTC**, not at the owner's local midnight.
- It is a cliff. An agent may spend its full daily cap at 23:59 and the full cap
  again at 00:01 — **two days of budget inside two minutes.**

This is the classic fixed-window versus rolling-window tradeoff, and the fixed
window is what makes the hot path O(1): one ledger key per (node, token, day),
with no history to scan. A rolling window would need per-payment timestamps and
a sweep on every check.

Not fixed, because the cheap mitigation already exists and composes: `per_tx_cap`
bounds any single payment and `cooldown_sec` bounds the rate, so an agent cannot
convert the boundary into an unbounded burst — only into at most 2× its daily
cap across it. Documented rather than silently left for a user to discover.

## 12. Recovering refusals from chain, and what that costs — PARTLY OPEN

A refused payment is never written to contract state (§2 explains why: storing
it is the storage-griefing vector). It exists only as a NEP-297 event inside a
receipt. So the single most important thing this product does is invisible to
anything that was not watching when it happened.

**What was built.** The adapter now follows the chain head and recovers
refusals as they occur (`BlockedFollower`), and `scripts/scan-blocked.mjs`
backfills older ranges. Both share one scanner, deliberately: there were
briefly two copies of the event-parsing logic, and the copy that breaks
silently is always the one that matters, because its output is an empty list
that reads exactly like "no refusals happened".

No indexer is involved. NearBlocks returns nothing at all for this testnet
account — `{"txns":[]}` even for transaction hashes verified to exist — so
everything comes from plain RPC and is reproducible by anyone.

**Measured cost.** One chunk in ten carries any transaction, and an empty
chunk's `tx_root` is the all-ones hash, so empties are skipped without a second
call. Steady-state following is roughly 2 RPC calls per block. A 100-block
range took 28 seconds, of which 4 blocks were unreadable on the first attempt.

**The limitation, measured twice — the second time correcting the first.**
A large backfill is NOT practical against a public endpoint.

Scanning ~1,200 blocks while the follower was also running produced `HTTP 429`
and killed the run outright. The script now paces requests, retries throttling
with exponential backoff, and checkpoints every 500 blocks so a failure costs
one batch rather than the whole run. Re-running the identical range then
succeeded, absorbing five 429s along the way:

| | |
| --- | --- |
| blocks | 1,200 |
| wall clock | 1,045 s (17.4 min) |
| chunks fetched | 565 |
| empty chunks skipped | 11,435 (95%) |
| rate-limit pauses | 5 |

An earlier note here claimed ~80 minutes for the 17,000-block gap this project
actually had. That was extrapolated from an UNPACED run which then got
throttled, so it measured a speed the endpoint will not sustain. At the rate
above — 0.87 s per block, pacing and backoff included — the real figure is
**roughly 4.2 hours.** The corrected number is the one that matters, and it
moves the conclusion from "slow" to "do not": the gap was left recorded rather
than filled.

The honest summary: **following the head is cheap, and backfilling deep
history is not.** Production would use an indexer.

**Consequences for coverage, and why gaps are recorded rather than hidden.**
When the cursor falls further behind the head than `maxCatchupBlocks` (default
5,000), the follower does not grind through the backlog — it records the span
as a GAP and resumes at the head. The alternative, jumping silently, would
report blocks nobody read as covered. Gaps are stored as ranges, surfaced on
`/v1/dashboard` as `blockedCoverage.holes`, and logged loudly with the exact
command to fill them. A reader must always be able to tell "no refusals
happened here" from "nobody has looked here yet"; those are the same empty
list otherwise, and that confusion is the entire thing this feature exists to
remove.

Running the backfill against the file the adapter is following is a
lost-update race — both sides do load/modify/save. The script detects a
recently-written store by mtime and refuses, pointing at
`scripts/merge-blocked.mjs`, which folds a separate backfill in: refusals
union by request id, coverage widens, and a span stops being a gap only if
neither side failed to read it.

## 13. Sub-agents: why delegation is owner-mediated, not agent-initiated

The obvious feature is `spawn_child` — an agent creating its own sub-agent and
handing down part of its budget. It is not built, and the reason is worth
recording, because the blockers are deliberate design rather than oversight.

**An agent cannot call it.** The restricted key from `create_agent_account` is
`method_names = ["request_payment"]`, receiver-locked to the vault, and NEAR
function-call keys cannot attach a deposit at all. The contract says why:

> a key that could call `ft_transfer` directly would hold the vault's own
> transfer authority and every budget check would be moot.

Agent-initiated spawning means widening precisely the key the design is most
careful about, and then having the vault fund sub-account creation out of its
own NEAR — because the caller provably cannot.

**Worse, it was unrecoverable.** `add_node` did `node_order.push` with no
counterpart anywhere in the contract. MAX_NODES was a ONE-WAY budget: a buggy
or compromised agent could consume all sixty-four slots permanently, and
neither freezing it nor revoking its key would give any of them back.

One genuine safety property already held, and is worth stating because it is
what makes delegation sane at all: a payment charges **every ancestor** in the
chain, so a child's spending is also charged to the agent above it. Spawning
children therefore cannot increase total spending power — it only subdivides
what the parent already has.

### What was built instead

- **`remove_node`** — MAX_NODES is now recoverable. Owner-only, and strict
  about it: the node must be frozen (freezing is what stops new reservations
  forming), childless (a descendant keeps it in `path`), not the root, and
  free of open reservations across **today and yesterday** — a reservation
  taken before midnight is still open after it, and checking only today would
  miss exactly that case. The parent gets its allocation and child count back.

  The node's ledgers are deliberately **not** deleted. Ids are never reused,
  so the rows are inert; deleting them would be actively harmful, because a
  surviving reservation releases via `pending.checked_sub` against a ledger
  that `unwrap_or_default()` would resurrect as zero, underflow, and panic
  inside a CALLBACK — stranding that reservation at every level of its chain.

- **`MAX_DEPTH` 3 → 4**, so `root → team → agent → sub-agent` is expressible.
  The cost is real and lands on the hot path: `chain` is path-plus-self and
  every payment loops it three times, so a fourth level is roughly three extra
  map reads and one extra write per payment. It remains a fixed-length walk,
  which is the property that actually matters.

The agent key is unchanged. Delegation is owner-mediated: the owner creates the
sub-agent node and binds an account to it. Autonomous spawning stays open, and
is now at least *possible* to build safely, since slots can be reclaimed — it
would still need a pre-authorised per-node quota and a funding source that is
not simply "the vault's balance, on an agent's say-so".

# Known tradeoffs and residual edges

Numbers here are observations, not estimates; where something is reasoned
rather than measured it says so.

Measured on testnet 2026-10-26 against `v2.floatvault-12329.testnet`, and for
the virtual-agent rail on 2026-10-28 against `v4.floatv4.testnet`.

**The MPC/Base rail was REMOVED on 2026-10-28.** `Route` now has only
`NearDirect` and `Intents`, and a cross-chain payment is an ordinary NEP-141
transfer to a NEAR Intents solver's deposit address — no MPC signature, no
derived address, no nonce. Sections 3, 5 and 6 below are retained as a
historical record: the measurements and the postmortems cost real chain
observation to produce and the lessons outlived the rail. They do **not**
describe reachable behaviour. Where they name a removed API they do so in the
past tense, to explain what was measured; the operational detail of how to use
those APIs has been cut.

Section numbers are stable and deliberately non-contiguous (7 and 8 were
already absent). `packages/float-adapter/src/blocked-scan.ts` cites §2 and
`docs/RUNNING.md` cites §12, so sections are never renumbered.

This file is intended as the source for a README limitations section, kept
separate so the numbers can be updated without rewriting prose. (There is no
README in the repo yet — as of 2026-10-28 this doc is the only place these
limitations are written down.)

---

## 1. Who pays for a payment, and why the key allowance is the rate limit

The intuition that "the vault is the predecessor on the cross-contract call, so
the vault pays the gas" is **wrong**, and it is worth stating why because it
changes which mitigations are needed.

On NEAR the transaction *signer* prepays gas for the entire receipt chain the
transaction spawns — the vault's execution, any cross-contract call, and the
callback. NEAR reserves the FULL prepaid amount against the signer up front and
refunds the unused remainder, which is why an agent key needs working capital
sized to prepaid gas rather than to expected burn (see
`MIN_AGENT_KEY_ALLOWANCE`).

The consequence is the durable one: the function-call key allowance is a **hard
per-agent gas budget that NEAR enforces for free**. When the key's allowance is
exhausted the key stops working entirely and the owner must consciously top it
up. That is the per-agent rate limit, already present, not something to add.

Measured cost per payment, for order of magnitude — **taken on the removed Base
rail (2026-10-26) and not re-measured since**, so treat the mechanism as
current and the figures as historical:

| Action | Allowance before | after | cost |
| --- | --- | --- | --- |
| One payment, including a cross-contract signing call | 0.5 N | 0.4985340624371167 N | **0.00146594 N** |
| One blocked attempt (refused before the external call) | 0.5 N | — | **~0.00024578 N** |

At that cost 0.5 N funded roughly 341 payments. What is measured on the current
rail is gas *burn* rather than allowance draw: 7.85 TGas at tree depth 1 and
9.28 TGas at `MAX_DEPTH`, against a 50 TGas floor — see `MIN_GAS_FOR_DISPATCH`.
Note these are different units and the two are not directly comparable.

## 2. The real resource vector is STORAGE, not gas

Each stored request consumes vault storage, and NEAR stakes the vault's own
balance against it. The mechanic is rail-independent; the byte count below was
measured across one Base-rail payment in 2026-10-26 and the `Route` enum has
changed shape since, so treat it as indicative rather than exact:

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

## 3. Gas ceiling on the Base rail — REMOVED WITH THE RAIL

The hole: the budget tree constrained USDC but said nothing about the native
ETH the vault's derived Base address held to pay gas, and the agent supplied
`max_fee_per_gas` and `gas_limit`. An inflated pair yielded a *validly signed*
transaction that burned that ETH — the leash held on the token and leaked on
the fee. `BaseConfig::max_tx_fee_wei` closed it with a ceiling on the
**product**, not on each field, because 20 gwei and 30M gas are each ordinary
but together are 0.6 ETH.

Unreachable since the rail's removal: there is no signing path, so no agent-
supplied fee fields. The detail is cut rather than kept current.

**The lesson that outlived it** lives in `docs/MUTATIONS.md` (the Base-ceiling
M26): the first overflow test passed against a `wrapping_mul` and had to be
rewritten with inputs that wrap to zero — the mutation survived because the
TEST was weak, not because the guard was strong. That generalises to any
overflow guard and is why a surviving mutation is investigated rather than
explained away.

`BaseConfig`, the `base_config` field and `get_base_config()` were all removed
on 2026-10-28. Because `base_config` was the 5th field of the persisted `Vault`
struct, that is a **borsh layout change**, and it ships with a `migrate`
method — see the migration section in `lib.rs`.

An earlier revision of this section claimed the field was "permanently `None`
on every vault". That was **wrong**, and the correction is the useful part:
`None` is the default and there was no setter left, but `v3.floatvault-12329.
testnet` was configured while the setter still existed and its state holds a
populated config (~116 bytes: `chain_id` 84532, the Sepolia USDC address, a
`base-1` derivation path). Reading the deployed state refuted an inference
drawn from reading the source.

Two measured facts about upgradeability, both from RPC `view_state` on
2026-10-28:

- **`v4.floatv4.testnet` (103 bytes) migrates.** Its layout matches the shadow
  struct exactly, with `base_config` as a single `None` tag.
- **`v3.floatvault-12329.testnet` (284 bytes) cannot, and already could not.**
  Its state has no `pubkey_to_node`/`pubkey_to_nonce` — the virtual-agent
  fields added earlier the same day — so it was already unreadable by current
  code before the Base rail was touched. It must be redeployed, not upgraded.
  Its 15 stored requests match the count recorded in §5.

**The migration has now been EXECUTED against a live vault**, not only against
its bytes. `v4.floatv4.testnet` was carrying real state from that morning's
round-trip — 4 nodes, a bound virtual agent at nonce 4, 4 stored requests, a
populated ledger — and was upgraded via `scripts/upgrade-vault.sh` with
`migrate` as the init call in the same transaction (tx
`HdAbUULJWwdoW2C11deVEGBqmJX8e2ZBPf5duUHrJyMw`). What survived, checked after:

| | before | after |
| --- | --- | --- |
| owner / paused / strict | floatv4.testnet / false / false | unchanged |
| nodes (ids + labels) | 4 | 4, identical |
| stored requests (ids) | 4 | 4, identical |
| ledger, node 0 | executed 5,500,000 · pending 0 | identical |
| virtual-agent nonce | 4 | 4 |
| virtual-agent → node | 0 | 0 |
| `get_base_config` | present | `MethodNotFound` |

Then the decisive functional check, because state that READS correctly but
cannot transact is still a broken vault: a signed virtual-agent payment settled
on the migrated contract — `SETTLED`, nonce 4 → 5, payee +1,000,000, 7.87 Tgas
against 7.85 before. No regression.

Note what the generic verifier could NOT tell us. `scripts/verify-upgrade.mjs`
predates virtual agents, so it compares the tree, requests, config and clock but
says nothing about `pubkey_to_node`/`pubkey_to_nonce` — precisely the newest
fields, and the ones a layout shift is most likely to damage. Those rows above
were checked by hand. A verifier is only as current as the state it knows about,
and a passing verifier is not a statement about the fields it never reads.

## 4. A stuck reservation

If the transfer callback itself panics or runs out of gas, NEAR rolls back only
that callback's receipt — the `pending` charge taken in the dispatching receipt
survives. The budget stays reserved at every level of the chain until something
releases it.

Bounded honestly:

- An agent cannot **steal** value this way. It can only lock budget.
- The lock is per-day: the ledger is keyed by `(node, token, day)`, so a stuck
  reservation stops mattering once the day rolls over.
- The callbacks are deliberately small and bound how much of the promise result
  they copy (`MAX_PROMISE_RESULT_LEN`) precisely so they cannot be pushed out of
  gas by a large return value.

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

## 5. What the contract proved about Base, and what it did not — HISTORICAL

> The Base rail was removed on 2026-10-28. This section is kept because the
> measurements below were taken against real chains and cannot be
> reconstructed, and because the custodial-delivery distinction is the kind of
> claim that gets repeated long after the code is gone. Nothing here is
> reachable now.

A successful `sign` promise proved the vault obtained a signature over a
transaction it built itself. It did **not** prove that the transaction was
relayed, included, or that USDC moved. Relaying was off-chain and the contract
could not observe it. That is why `SIGNED` was a distinct reason code from
`SETTLED`, and why the dashboard showed `signed` rather than `success` for that
rail.

The durable principle: **a signature is authority, not delivery.** Any future
rail that ends in an off-chain hand-off needs the same two-state distinction,
and the Intents rail inherits it — a NEP-141 transfer to a solver's deposit
address proves the deposit, not the far-chain delivery.

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

What kept it honest was the authorization gate: the relayer rebuilt the
transaction from the request the CONTRACT stored and refused to move anything
unless the MPC signature over that rebuild recovered to the vault's derived
address. So the operator could fail to pay, but could not be directed to pay
someone the vault did not authorize. Tested in both directions — a mismatched
signature recovered to a different address and was refused.

The transferable idea: when an off-chain actor performs delivery, bind it to
what the *contract* stored rather than to what the caller passes, so the actor
can refuse but cannot redirect. The Intents rail applies the same shape by
binding the solver's deposit address to the payee with a registered signature.

### Vault-signed delivery — NEVER PROVEN, now removed

`--mode vault` would have broadcast the MPC-signed transaction itself, needing
no operator and not custodial. It was never demonstrated: the vault's derived
address `0x75e2bc908d3eaf42c680404d7770b6b0ec0e7333` never held ETH or USDC,
and the rail was removed before it was funded. The non-custodial version of
this path was therefore never shown to work — worth recording, because the
custodial run above is sometimes remembered as having proved more than it did.

#### Two lessons from the nonce work that outlived the rail

The EVM nonce handling itself is gone — `Route::BaseUsdc`, `set_base_nonce` and
`get_request_nonce` no longer exist, and the Intents rail has no nonce to
allocate. Two findings from that work generalise and are the reason this
subsection survives at all.

**1. Removing a field from a stored enum breaks every record already on chain.**
`Route` is stored inside `PaymentRequest`. All fifteen requests on the live
vault carried a `nonce` field in their borsh bytes; deleting it shifts every
following byte, so those records would have failed to deserialise and
`list_requests` — and the whole dashboard — would have broken the moment the
new code deployed. The field was kept and its value discarded instead, with
`serde(default)` letting new callers omit it while borsh kept reading old
records as written.

This was caught by **checking the live vault's stored routes, not by the test
suite, which passed throughout.** A unit test builds its own fixtures and so
can never see a layout mismatch against records written by older code. This is
why `Route` in `types.rs` still carries its comment that borsh tags variants by
position, that `NearDirect` must stay first, and that new variants are appended
rather than inserted.

**2. A mutation survived all 90 tests because the logic sat where no test could
reach it.** The nonce-reclaim rule lived inline in a callback, so the first two
reclaim tests re-implemented the rule beside the real one and asserted against
their own copy. Inverting the real condition changed nothing. The fix was to
extract the decision into a named function that both the callback and the tests
call, after which the same mutation failed immediately. A test that
re-implements the logic it is checking tests only itself.

A related coverage note: `Route::BaseUsdc` had **no unit tests at all** —
removing a field from it broke nothing in `cargo test`. Its only coverage was
the sandbox tier, which still cannot compile on Windows (`near-workspaces`
fails its build script for want of a Windows sandbox binary), so on this
machine that rail was effectively untested. Any rail whose only coverage is a
tier that does not run on the developer's machine is untested in practice.

## 6. A config error no test could catch: chain id vs token address — HISTORICAL

> The specific misconfiguration is moot: the Base rail is gone and
> `base_config` is permanently `None`. Kept because the *class* of error is
> live for any owner-set external fact, including the Intents rail's solver and
> token addresses, and because the only way it was ever found was asking an
> external chain.

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

It was fixed in the live config and in the test fixture at the time — the
fixture did not care about the value, but a repo that shows a mainnet address
beside a testnet chain id teaches the wrong pairing to whoever copies it next.

**The general shape, which is still live.** Any owner-set address, chain id,
token contract or endpoint is a fact about the outside world. The contract can
validate its SHAPE — lowercase 20-byte hex, non-zero ceiling, well-formed
account id — and **cannot validate its TRUTH**. No unit test can either, because
the external system is mocked and the contract's own notion of correctness ("I
authorized what I signed") is satisfied by a wrong address just as well as a
right one.

That applies now to the Intents rail's token contracts and solver deposit
addresses exactly as it applied to `chain_id` and `usdc_address` before. The
only check is to ask the external system, from outside the test suite, before
trusting the pairing.

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
  (`scripts/upgrade-vault.sh`). **Any future change that adds a struct field
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

## 12b. What a cross-chain payment actually costs — MEASURED against live 1Click

The Intents rail was executed end-to-end on testnet against a real NEP-141
(`usdc.fakes.testnet`, not `mock_ft`), and the 1Click side was priced
read-only against the live mainnet API. Both on 2026-10-28.

**On-chain, testnet (`v4.floatv4.testnet`, node 24):**

| | result |
| --- | --- |
| rail with no quote signer | `QUOTE_SIGNER_UNSET`, 2.77 Tgas, nothing moved |
| settled | 25.00 to a **non-allowlisted** deposit address, **9.12 Tgas** |
| agent substitutes its own deposit address | `QUOTE_BAD_SIGNATURE`, recipient delta 0 |

9.12 Tgas against 7.85 for `NearDirect`. The ~1.27 delta is the second
`ed25519_verify` (over `QuoteBinding`) plus the longer borsh payload, so the
rail costs ~16% more gas and still sits at roughly 11x headroom under the
relay's 100 Tgas.

**Off-chain, live 1Click `/v0/quote` with `dry: true`** — a price, not an
instruction, and it correctly returns no deposit address:

| deliver to payee | vault is charged | spread |
| --- | --- | --- |
| 1 USDC | 1.012733 | 1.27% |
| 5 USDC | 5.053953 | 1.08% |
| 10 USDC | 10.105478 | 1.05% |
| 25 USDC | 25.260054 | 1.04% |
| 100 USDC | 101.032936 | 1.03% |

ETA 22s throughout. The spread converges to ~1.03% and is worst at small
sizes, which matters because `slippageTolerance` defaults to 100 bps and
`EXACT_OUTPUT` reserves that as headroom — most of the spread is the slippage
reserve, not fee.

Two consequences for budgeting, both easy to get wrong:

1. **The cap must cover `amountIn`, not the payee's amount.** A node capped at
   exactly 10.000000 cannot deliver 10 USDC cross-chain. The boundary, measured
   rather than derived:

   | deliver | charged | against a 10.000000 cap |
   | --- | --- | --- |
   | 9.890000 | 9.994343 | passes |
   | 9.900000 | 10.004446 | **refused** |
   | 10.000000 | 10.105478 | refused |

   `EXACT_OUTPUT` is deliberate — a payment is a promise about what the payee
   receives — so this gap is structural, not a tuning artefact. What makes it
   worth calling out is the *attribution*: the refusal comes from your own
   budget, with `PER_TX_LIMIT` or `DAILY_BUDGET`, and nothing about it mentions
   the solver. It reads like a bug unless you are expecting it.
2. **"Funded with 10 USDC" does not buy a 10 USDC cross-chain payment.** The
   largest deliverable from exactly 10 USDC is about 9.89.

**The mainnet defaults are now pre-sized for this.** They used to be flat, so a
user paying the full per-tx cap cross-chain was refused by their own budget. The
mainnet tree in `create-float` now derives each cap through `xchainCap(desired)`
— `ceil(desired × 1.02)` to the cent:

| node | wants to deliver | cap | charged to deliver it (live) | slack |
| --- | --- | --- | --- | --- |
| root daily | 2 | 2.04 | 2.023038 | 0.016962 |
| research daily | 1.5 | 1.53 | 1.517884 | 0.012116 |
| r1/r2 daily | 1 | 1.02 | 1.012733 | 0.007267 |
| per-tx | 0.50 | 0.51 | 0.507579 | 0.002421 |

All four confirmed against live quotes, not just the formula. The overcommit the
tree exists to demonstrate survives the change: `r1 + r2 = 2.04 > research
1.53`.

**Mind which tree is which — this is the easy mistake, and it was made here
first.** `DEFAULT_TREE = MAINNET ? … : …` gives **mainnet the SMALL tree**
(real money, "sized so a total loss is a rounding error") and **testnet the
generous 100/10 one** (fake tokens, sized to make the hierarchy legible). The
first attempt at this change applied `xchainCap` to the testnet branch —
inflating caps for a spread that cannot occur there, while leaving the mainnet
caps flat and the actual problem unfixed. It was caught by running
`--dry-run --network testnet` and seeing `102/day, 10.2/tx` where round numbers
belonged.

That the spread is **worst at small sizes** (1.52% at 0.50 vs 1.03% at 100) is
what makes the mainnet scale the one that matters: a flat `0.50` per-tx cap
cannot deliver 0.50 cross-chain at all.

**Testnet keeps round caps**, because Intents is mainnet-only and step 8 skips
the quote signer there: the rail is closed, so there is no spread to absorb and
inflating them would loosen limits for no benefit.

**The trade, which is a real loosening.** These caps apply to BOTH rails. A
per-tx cap of 0.51 lets a `NearDirect` payment spend 0.51, not 0.50 — 2% more
direct-payment headroom than the operator asked for, bought to make round
cross-chain amounts clear. The wizard says so explicitly rather than leaving it
to be discovered, and anyone who cares more about an exact direct-payment
ceiling should flatten the caps and accept delivering ~98% of them.

`XCHAIN_HEADROOM = 0.02` sits above the measured worst case (1.52% at 0.50)
rather than the ~1.03% the spread converges to, because under-reserving
produces a refusal while over-reserving costs nothing unless a payment is
actually that large. It is a guidance figure, not a protocol constant: nothing
validates against it, no contract reads it, and `scripts/oneclick-probe.mjs`
re-measures it. Slippage tolerance and market depth both move the real number,
which is exactly why it is not compiled into anything.

**A failure mode worth recognising.** `refundTo` must be a MAINNET NEAR
account. Both callers pass `refundTo: vault` (`mcp/src/server.ts:208`,
`float-adapter/src/server.ts:338`), which is correct — but the asset ids in
`ASSETS` are mainnet-only, so a TESTNET vault against them is internally
inconsistent and 1Click answers:

```
HTTP 400 {"message":"Internal server error", "correlationId": ...}
```

That names nothing and reads exactly like an outage on their side. Measured
both ways in one run: `floatv4.testnet` → 400 every time, `wrap.near` → 201
with a real quote. If that 400 appears, check the network of `refundTo` before
suspecting 1Click. `scripts/oneclick-probe.mjs` reproduces both.

**Still not proven:** that a solver fills the order. The deposit address in the
testnet run is an account we control standing in for a one-time quote address,
and the live quote was `dry`, so no solver was ever engaged. On mainnet the
owner's backend takes the address from a non-dry quote and signs the same
binding — the signing step is the production mechanism, not a stub, but the
counterparty is absent. That is the last gap before mainnet.

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

## 13. A cross-chain payment needs a NEAR-side registration the design does not mention

**Measured on mainnet 2026-10-28**, receipt
`4oLJy4hr4AB9TLrLZZkAzUETj34mMTyZBCU518etHCp2`:

```
Smart contract panicked: The account 61c81429…7c0d is not registered
```

Every authorisation step passed — the quote signature verified, the agent
signature verified, the payee allowlist matched, the budget reserved — and the
NEP-141 `ft_transfer` then failed, because 1Click's deposit address is a FRESH
IMPLICIT ACCOUNT with no storage balance on the token.

The contract behaved exactly as designed: `TRANSFER_FAILED`, reservation
released, `executed 0.000000`, `pending 0.000000`, vault balance unchanged at
`1.000000`. The failure cost one quote and 0.00013 NEAR of gas. Worth stating
plainly, because this is the path that most needed to fail safely and did.

**There is no way around the registration.** Measured against the live API:

| attempt | result |
| --- | --- |
| `depositType: ORIGIN_CHAIN` | fresh implicit account per quote |
| `depositType: INTENTS` | fresh implicit account per quote |
| `depositMode: MEMO` | HTTP 400 for this asset pair |

`MEMO` is the mode that would let a deposit ride on an already-registered
shared address with a memo discriminator, and it is unavailable here. So the
sender must `storage_deposit` the one-time address first.

**The standing cost:** 0.00125 NEAR per cross-chain payment — both the `min`
and `max` of `storage_balance_bounds` — paid by the OPERATOR, not the vault,
and unrecoverable, since nobody will unregister a single-use address to reclaim
it. At roughly 0.003 USD it does not move the economics of a 0.50 payment, but
it means the cross-chain rail is **two NEAR transactions, not one**, and the
second is not optional.

**Why the testnet rehearsal could not have caught it.**
`scripts/intents-dryrun.mjs` says in its own header that its deposit address is
"an account we control standing in for a one-time quote address". An account we
control is registered. The absence of the counterparty was documented; this
consequence of it was not — the stand-in differed from the real thing in
precisely the property that mattered, and nothing flagged that the substitution
was load-bearing.

Handled in `scripts/intents-pay.mjs::ensureRegistered`, which registers before
anything is signed, so a failure happens while the quote is still only a quote.

### 13a. The round trip, proven end to end (2026-10-28)

First real cross-chain payment, `float.test015.near` -> Base:

| leg | evidence |
| --- | --- |
| vault debited | `1.000000` -> `0.492421` USDC, exactly `-0.507579` |
| budget charged | node 0 `executed 0.507579`, `available 1.532421` (= 2.040000 - 0.507579) |
| NEAR transfer | `SETTLED` / `SETTLED`, request `base-2-07167232` |
| **Base delivery** | **0.500000 USDC**, block 53216624, 21:23:15Z, tx `0xceda1273…` |

Spread 0.007579 = 1.52%, matching the quote to the base unit, and inside the
0.510000 per-tx cap with 2421 units spare. The cap pre-sizing in
`packages/create-float/bin/xchain.mjs` did exactly what it was measured for.

**A verification mistake worth recording, because it was nearly believed.** The
first attempt to confirm the Base leg scanned `eth_getLogs` and read the
response as `(await call(...)).result ?? []`. The public endpoint answers
HTTP 429 to a wide range, so the error became an empty array, and "0 inbound
transfers" was reported as evidence of non-delivery. The transfer was in block
53216624 — inside the scanned range the whole time. Zero matches and "the query
could not run" are the same output unless the error is checked for.

`intents-pay.mjs::baseUsdcBalance` now throws on a non-200, on a JSON-RPC
`error`, and on a null result; `verify` prints READ FAILED and says explicitly
that it is not evidence of non-delivery. It also records the payee's Base
balance BEFORE paying, because the balance afterwards was 0.501935 for a
0.500000 payment — 0.001935 was already there, and without a before-picture
that is indistinguishable from a short fill. All three guard branches were
exercised (bad method, wide range, bad host) rather than assumed.

### 13b. The slippage reserve is REFUNDED, and the budget is not credited back

Found while pricing the second payment: the vault's USDC balance had RISEN
between payments, `0.492421` -> `0.497497`.

Evidence, all independent reads:

| fact | value |
| --- | --- |
| vault after payment 1 settled | `492421` |
| vault before payment 2 | `497497` |
| delta | **+5076** |
| quote 1 `amountIn - minAmountIn` | `507579 - 502503` = **5076** (exact) |
| owner balance | `10817454`, unchanged — not the source |
| deposit address `4fac8206…` | `0` — swept by the solver |

1Click quotes `amountIn` including a 100 bps `slippageTolerance` held as
headroom. The solver took `minAmountIn` and refunded the remainder to
`refundTo`, which both production callers set to the vault
(`mcp/src/server.ts:208`). So **delivering 0.500000 cost 0.502503 net, a 0.50%
effective spread, not the 1.52% the quote implies.**

**The cap must still be sized on `amountIn`.** That is what actually leaves the
vault, and the per-tx check runs before any refund exists. The sizing in
`xchain.mjs` is correct as it stands; the measured spreads there are gross, and
that is the right basis for a ceiling.

**But the budget ledger charges gross and is never credited.** Node 0 shows
`executed 0.507579` and `available 1.532421` after a payment that truly cost
`0.502503`. The refund arrives as an ordinary inbound NEP-141 transfer that the
contract cannot attribute to any request — there is no correlation id on a token
transfer — so crediting it would mean guessing. Charging gross is the safe
direction.

The consequence is that a day of cross-chain payments consumes roughly 1% more
daily budget than it truly spends, and the overcharge grows with the number of
payments rather than their size. At the current caps that is immaterial. It
would matter for a node doing many small cross-chain payments against a tight
daily cap, and the honest framing for an operator is that a daily cap bounds
GROSS outflow, which is what a cap should do, not net cost.

Not a defect. Recorded because "executed" reads like "spent" and here it is
measurably larger.

### 13c. Second payment: the refund reproduces, and a second data point

0.250000 delivered to Base, charged 0.255004 gross, request `base-3-67990016`.
Delivery confirmed exact. Node 0 accumulated correctly across both payments:
`executed 0.762583` = 0.507579 + 0.255004, `available 1.277417`.

| deliver | gross amountIn | refund | net cost | gross spread | net spread |
| --- | --- | --- | --- | --- | --- |
| 0.500000 | 507579 | 5076 | 502503 | 1.52% | **0.50%** |
| 0.250000 | 255004 | 2551 | 252453 | 2.00% | **0.98%** |

The refund is 1.01% of net in both cases — the 100 bps slippage reserve coming
back, as in 13b. So the net spread is roughly HALF the gross, while still
climbing as the amount shrinks, which is the shape the cap sizing was built
for. Cap sizing stays on gross: that is what leaves the vault, and the per-tx
check runs before any refund exists.

Gross is also what the measurements in `xchain.mjs` record, and they reproduce
exactly — 0.255004 for 0.25 was measured days earlier and again live here, to
the base unit.

**A verification bug this surfaced.** `verify` sampled the payee's balance ONCE
and printed `DELIVERED 0.000000 ... SHORT — not filled yet, or short-filled`
for a payment still in flight; the solver's own eta was 22s and `verify` ran
immediately. The fill landed moments later.

One line cannot be both "wait" and "investigate a short fill" — those demand
opposite responses, and a single sample of an asynchronous process cannot tell
them apart. Same error as reading an RPC failure as a zero: an INCONCLUSIVE
observation reported as a finding. `verify` now POLLS until the delta appears
or the solver's own eta plus slack elapses, and then says which it ended on:
`exact`, `above the minimum`, `NOTHING YET — past the eta, so investigate`, or
`SHORT FILL — less than the minimum, which should not happen`. `pay` records the
submission time and the eta so the bound comes from the counterparty's promise
rather than a guess.

### 13d. The per-tx cap, tested at its edge on mainnet

Run via `scripts/intents-pay.mjs capedge`. An over-cap amount derived from a
LIVE dry quote, then bought as a real quote and signed exactly as a real
payment:

```
per-tx cap     : 0.510000 USDC
chose deliver  : 0.510000 USDC -> amountIn 0.517682 USDC
over cap by    : 0.007682 USDC
outcome: {"status":"BLOCKED","reason_code":"PER_TX_LIMIT"}
vault 0.245044 -> 0.245044   executed 0.762583 -> 0.762583
```

All seven assertions passed: BLOCKED, PER_TX_LIMIT, no tokens moved, budget not
charged, nothing left pending, nonce consumed, blocked request not stored.

**Why this is attributable to the cap and nothing else.** The Intents quote gate
runs BEFORE the pass-one cap loop (`lib.rs:1153`). A malformed quote, stale
deadline or bad signature would have been refused EARLIER, and the test would
have looked like a pass while proving nothing. So `capedge` shares
`buildSignedArgs` with `pay`: the quote signature, the agent signature, the
payee, the deposit-address binding and the deadline were all valid and
accepted. The ONLY defect was the amount.

That is the budget tree's central claim, enforced on mainnet against real money:
a payment that satisfies every authorisation check is still refused when it
exceeds its limit.

**The refusal is also free and safe.** The check precedes any charging and the
transfer, so nothing moved; the test cost gas and one nonce. The deposit address
was deliberately left unregistered, so even a cap check that failed to fire
could only have reached TRANSFER_FAILED, never SETTLED.

Two behaviours confirmed as designed rather than assumed:

- **the nonce is consumed by a blocked attempt.** Burned before dispatch on
  purpose, so any attempt reaching dispatch is single-use. A relayer cannot
  retry a refused payload.
- **a blocked request is not stored.** The contract returns it and emits an
  event instead, so rejected attempts cannot grow the vault's storage bill at
  an agent's will. `get_request` returning null afterwards is correct, not a
  lost record — and any dashboard must say so rather than render an empty
  "blocked" list and imply none ever happened.

### 13e. The MCP agent cannot complete a cross-chain payment on its own

Found by `scripts/mcp-dryrun.mjs` before any demo recording, not during one.

`vault_pay rail=intents` through the MCP server reaches the vault, passes every
budget check and both signature gates, and then **fails at the transfer** with
`The account … is not registered`. The reason is the one from §13: 1Click's
deposit address is a fresh implicit account needing a `storage_deposit` on the
TOKEN before it can receive.

The agent cannot make that call. Its key, read from chain state after creation:

```
ed25519:AsNRXo3bdCr3G4ahD26ne9dFkErVPtY6Bb1Mbiy26WAG
  receiver_id : float.test015.near
  method_names: ["request_payment"]
  allowance   : 0.500 NEAR
total keys on r1.float.test015.near: 1   (no full-access key)
```

`receiver_id` is the vault, so the key cannot call the token contract at all —
which is exactly the property that stops an agent calling `ft_transfer`
directly and bypassing every budget check. And `grep -rn storage_deposit
packages/mcp/src/` returns nothing, so MCP holds no other key to do it with.

**This is the agent/operator split working as designed, not a defect.** An
agent should not be able to pay a token contract for storage. But it means the
cross-chain rail requires an OPERATOR-side registration step, and nothing in
the agent-facing surface can supply it.

Today that step lives in `scripts/intents-pay.mjs::ensureRegistered`, which
uses the owner key. Consequences, stated plainly:

- `rail=near` works end to end through MCP. The payee is an ordinary NEAR
  account that is already registered, so no extra call is needed.
- `rail=intents` through MCP needs an operator component that watches for a
  quote and registers its deposit address — or a contract change letting the
  vault register from its own balance, since the vault does hold NEAR.

The roadmap item is the operator daemon, not a change to the key's permissions.
Widening the agent key to reach the token would hand it the vault's transfer
authority and make the whole budget tree advisory.

### 13f. The MCP path, end to end on mainnet — and the hierarchy observed

`node scripts/mcp-dryrun.mjs --pay 0.05 --rail near --to test015.near`, spoken
to the MCP server over stdio as a client, with no library imports:

```
agent key  : r1.float.test015.near
vault_pay 0.05 via near to test015.near
{ "request_id": "b990d950-…", "node_id": 2, "status": "SETTLED" }
```

So the full agent chain works: an AI client calls a tool, the MCP server signs
with a key that can do exactly one thing, the vault applies the budget tree,
and a NEP-141 transfer settles. Conservation exact — vault `0.245044 ->
0.195044`, owner `10.817454 -> 10.867454`.

**THE HIERARCHICAL CHARGE, observed rather than asserted.** Both earlier
payments came from node 0, so this is the first that could show it. Paying
0.05 from node 2:

| node | executed | available / cap | |
| --- | --- | --- | --- |
| 0 root | 0.050000 | 1.990000 / 2.040000 | ancestor, charged |
| 1 research | 0.050000 | 1.480000 / 1.530000 | ancestor, charged |
| 2 r1 | 0.050000 | 0.970000 / 1.020000 | the payer |
| 3 r2 | **0.000000** | 1.020000 / 1.020000 | **sibling, untouched** |

Every ancestor charged, the sibling not. That is what makes the tree a shared
POOL rather than four independent limits, and it is the property the product
exists to demonstrate.

It also sets up the contention the default tree is designed around: r1 and r2
may now each spend 0.97 and 1.02 — 1.99 between them — against research's
remaining 1.48. One of them will be refused by its PARENT's daily limit while
its own still shows room. `PARENT_DAILY_LIMIT` remains the one reason code with
no mainnet observation; demonstrating it needs ~1.5 USDC of payments and the
vault holds 0.195044.

**rail=near, not intents** — see §13e. The agent key cannot register a
cross-chain deposit address, by design.

# Mutation log

A passing test proves nothing until a mutation proves *which clause* carries
it. Each row below was produced by editing the named line, running the suite,
and reverting by editing the line back — never with `git restore`, which would
take the uncommitted implementation with it.

Protocol for every row:

1. State the predicted red tests **before** running. A disagreement is a bug
   in the prediction or in the test, and gets investigated before moving on.
2. Apply the mutation with the editor.
3. Run the affected tier:
   - unit: `cargo test -p vault`
   - sandbox (Linux/WSL): `bash scripts/build-wasm.sh && cargo test -p integration-tests`
     — the wasm must be REBUILT after a contract edit, or the mutation is not
     in the binary under test and the run is meaningless.
4. Revert by editing the line back; re-run and confirm green. That run doubles
   as proof the revert restored the right code.
5. If a mutation **survives**, write the missing test *while the mutation is
   still applied*, watch it go red, then revert. Writing it afterwards only
   describes the hole.

Baseline: **33 unit + 9 sandbox = 42 passed, 0 failed, 0 warnings.**

The sandbox tier must run under Linux or WSL: `near-workspaces` ships a
sandbox node only for linux-x86_64, linux-aarch64 and darwin-arm64. Build the
wasm with `scripts/build-wasm.sh` (which uses `cargo near build`, never plain
`cargo build` — see the note in the workspace `Cargo.toml`) and run with
`CARGO_TARGET_DIR` pointed at a Linux-native path.

---

## Executed

### M14 — collapse the ledger key's node dimension

The decisive one. This turns the contract into a single-pool vault; if the
suite stays green, the hierarchy is decorative.

- **Edit:** `contracts/vault/src/lib.rs`, both passes of `request_payment` —
  ledger key `(*id, token.clone(), day)` → `(ROOT_NODE, token.clone(), day)`.
- **Predicted:** `i3_parent_daily_binds_while_child_still_has_headroom`,
  `i1_reallocation_reopens_a_blocked_child`. 6 others unaffected.
- **Actual:** ✅ **2 failed, 6 passed** — exactly those two.
- **Note:** the failure surfaced one assertion earlier than predicted. Because
  only the hot path was mutated and not `get_node_budget`, the view still read
  per-node ledgers, so `i3` failed on the *research* exhaustion assertion
  (`left: U128(500000000)`, wanted `0`) rather than the r2-isolation one. Right
  tests, wrong assertion — which is the reason the prediction is written down
  first.

### M3 — ancestor check reduced to the leaf

Proves the ancestor **check** is load-bearing, independently of the ledger key.

- **Edit:** `request_payment` pass one, `for id in &chain` → `for id in &[node_id]`.
- **Predicted:** `i3_parent_daily_binds_while_child_still_has_headroom`,
  `i1_reallocation_reopens_a_blocked_child`. 6 others unaffected.
- **Actual:** ✅ **2 failed, 6 passed** — prediction matched exactly.

### M4 — ancestor *charge* reduced to the leaf

The sibling of M3. Not killable from the unit tier at all: with no callback,
`executed` never moves, so the charge is unobservable there. This is why the
sandbox tier had to exist before the mutation pass could be called complete.

- **Edit:** `request_payment` pass two, `for id in &chain` → `for id in &[node_id]`.
- **Predicted:** `i3_single_payment_charges_agent_team_and_root`,
  `forced_transfer_failure_releases_the_reservation_at_every_level`,
  `unregistered_recipient_releases_the_reservation`. The reason-code test is
  unaffected. (The two failure tests go red because the callback releases from
  a three-node `reserved_chain` and underflows on levels that were never
  charged.)
- **Actual:** ✅ **3 failed, 1 passed** — prediction matched exactly.


### M8 — callback books against `today()` instead of `reserved_day`

- **Edit:** `on_transfer_result`, `r.reserved_day` → `self.today()`.
- **Predicted:** `settlement_is_booked_to_the_reserved_day_not_the_callback_day`
  only. The other sandbox tests run at the production day length, where the two
  values coincide.
- **Actual:** ✅ **1 failed, 4 passed** — and via the predicted mechanism:
  `Smart contract panicked: LEDGER_INVARIANT: pending underflow`, because the
  release lands on a later, zeroed ledger.

### M1 — I1 boundary in `add_node`, `>` → `>=`

- **Edit:** `add_node`, `if new_sum > parent_cap` → `>=` (line-targeted: the
  same text appears twice, in `add_node` and `set_node_caps`).
- **Predicted:** `i1_sigma_children_equal_to_parent_is_allowed` only.
- **Actual:** ✅ **1 failed, 7 passed.**
- **Note:** the first attempt asserted the pattern occurred once, and the
  assert fired — so the edit never landed and the suite ran UNMUTATED. Without
  the count assertion that run's 8 greens would have been recorded as "M1
  survives". Stating the expected count before editing is what caught it.

### M2a — containment against CHILDREN, direction slip

- **Edit:** `set_node_caps`, `if l.daily_cap.0 < node.child_sum_for(..)` → `>`.
- **Predicted:** `i1_lowering_parent_below_existing_children_is_rejected` only.
- **Actual:** ✅ **1 failed, 7 passed.**

### M2b — containment against the PARENT: **SURVIVED**, hole closed

- **Edit:** `set_node_caps`, the against-parent guard made unreachable
  (`if false && new_sum > parent_cap`).
- **Predicted:** survives — no test raised a child's cap above its parent's
  headroom in strict mode.
- **Actual:** 🔴 **0 failed, 8 passed. The mutation survived.**
- **Why the gap existed:** the neighbouring test
  `i1_lowering_parent_below_existing_children_is_rejected` lowers the ROOT,
  which has no parent, so it is carried entirely by the against-CHILDREN
  guard. The upward direction was asserted nowhere, while a code comment
  claimed containment was checked "in both directions". This is exactly the
  passing-negative-test trap: a test named for one clause being carried by
  another.
- **Closed by:** `i1_raising_a_child_above_the_parents_headroom_is_rejected`
  plus its allowed row `i1_raising_a_child_exactly_into_the_parents_headroom_is_allowed`,
  both written WHILE M2b was still applied and watched going red, then the
  mutation reverted. Re-run after revert: 10 passed.

### M11 — `available()` `saturating_sub` → `-`

- **Edit:** `available()`, `daily_cap.saturating_sub(used)` → `daily_cap - used`.
- **Predicted:** `available_saturates_when_a_lowered_cap_is_already_exceeded` only.
- **Actual:** ✅ **1 failed, 9 passed** — `attempt to subtract with overflow`.
- **Note:** that test runs in DEBUG, where `-` panics. In a release build
  without `overflow-checks` it would WRAP instead, silently turning an
  exhausted budget into an enormous one. So the workspace's
  `overflow-checks = true` is load-bearing, and the compound case (drop both)
  is not covered by any single-edit mutation.


### M15 — drop `method_names` from the provisioned agent key

The key restriction IS the security claim, so this is the mutation that can
falsify the README's central sentence.

- **Edit:** `create_agent_account`, `AGENT_ALLOWED_METHOD.to_string()` →
  `String::new()` (empty = every method permitted).
- **Predicted:** the two `MethodNameMismatch` probes in
  `provisioned_agent_key_can_only_call_request_payment_on_this_vault`.
- **Actual, first run:** 🔴 caught **only by the off-chain key-shape
  assertion**, not by any behavioural probe. Which meant the behavioural
  clause — "the key cannot call owner methods" — was unproven.
- **Root cause, and the real finding:** the clause-2 probes attached 1
  yoctoNEAR, because owner methods require it. NEAR validates the deposit rule
  BEFORE the method-name rule, so those calls were rejected by
  `DepositWithFunctionCall` and the `method_names` restriction was never
  reached. The assertion passed for the wrong reason. Two overlapping guards
  means each needs a probe the other cannot mask.
- **Fix:** every negative probe now names the NEAR error variant that must
  carry it (`rejected_because(..)`), and the method-name and receiver probes
  attach NO deposit so the deposit rule cannot fire first:
  - `set_node_caps` / `freeze_node`, no deposit → `MethodNameMismatch`
  - `ft_transfer` on the token, no deposit → `ReceiverMismatch`
  - `request_payment` WITH a deposit → `DepositWithFunctionCall` (the only
    probe that should be carried by the deposit rule, using the one method the
    key is allowed to call so nothing else can reject it first)
- **Re-verified:** M15 re-applied with the key-shape assertion temporarily
  blinded, so only behaviour could catch it. It did —
  `set_node_caps (no deposit): the call was NOT rejected at all`. Both the
  shape check and the behavioural probe are now independently load-bearing.
  Both reverted; 18 passed.

### Not a mutation: the key allowance was measured, not guessed

`create_agent_account` first hardcoded a 0.05 NEAR key allowance and 0.1 NEAR
funding. The provisioned key was **dead on arrival**:
`NotEnoughBalance { balance: 0.2 NEAR, cost: 1.0009 NEAR }`. NEAR reserves the
FULL prepaid gas against the signer up front and refunds the unused part after,
so a 300 Tgas call needs ~1 NEAR of headroom even though it burns a fraction of
that. An allowance sized to expected BURN rather than to PREPAID gas yields a
key that cannot transact at all. The allowance is now an owner-chosen parameter
with a measured floor (`MIN_AGENT_KEY_ALLOWANCE`), and the agent's own calls in
the tests are gas-bounded rather than `max_gas`.


### M6 / M7 / M12 / M13 — the remaining unit-tier guards

Run as a batch by a driver that compares the exact SET of failing test names
against the prediction, not just the count. A matching count with different
names would mean the prediction was wrong and something else broke.

| # | Edit | Predicted red | Actual |
| --- | --- | --- | --- |
| M6 | cooldown `now < last + cd` → `<=` | `i4_cooldown_blocks_one_second_early_and_passes_at_the_boundary` | ✅ exact set match |
| M7 | per-tx `amount > per_tx_cap` → `>=` | `i5_per_tx_boundary_exact_then_one_over`, `i3_parent_daily_binds_while_child_still_has_headroom`, `i1_reallocation_reopens_a_blocked_child` | ✅ exact set match |
| M12 | freeze check `&chain` → `&[node_id]` | `freeze_on_an_ancestor_blocks_the_leaf_without_propagating` | ✅ exact set match |
| M13 | `effective_recipients` returns inherited ∪ own | `i7_child_allowlist_overrides_rather_than_unions` | ✅ exact set match |

M7 was predicted at **three** tests rather than one, because the shared `tree()`
fixture gives `r1` a per-tx cap of 500 and two existing tests pay exactly 500.
Predicting one and seeing three would have looked like an unexplained extra
failure; predicting the set made it a match.

M6's zero-cooldown sibling (`i4_zero_cooldown_permits_two_payments_at_the_same_timestamp`)
is correctly unaffected, because the `cooldown_sec > 0` guard short-circuits
before the comparator.


### M20 — `clock_mode()` lies under `--features test-clock`

The deploy-script guard is only worth something if a test-clock build actually
announces itself. Made testable without a testnet by asserting the marker in
the exact binary the script is meant to reject.

- **Edit:** the `test-clock` `clock_mode()`, `"TEST-CLOCK-DO-NOT-DEPLOY"` →
  `"production"`.
- **Predicted:** `the_test_clock_build_announces_itself` only.
- **Actual:** ✅ **1 failed, 6 passed.**
- The production side is pinned separately by
  `production_build_reports_production_clock_and_a_real_day`, which runs under
  `cargo test -p vault --no-default-features`. Both sides of the marker are
  asserted, so neither can drift into agreeing with the other.
- **Not verified:** `scripts/deploy-testnet.sh` itself has only been
  syntax-checked (`bash -n`). Its end-to-end behaviour needs a testnet account
  and has NOT been exercised. What is proven is the premise the guard rests on.

---

## Queued (the tests exist; the mutation has not been run yet)

Do not record these as proven until each has a real result in the table above.

*(none outstanding — every mutation with an existing test has been run.)*

| # | Edit | Predicted red |
| --- | --- | --- |

## Blocked on the sandbox tier (`contracts/integration-tests`)

These cannot be run at all from the unit tier, because a unit test cannot
schedule a promise and the callback never executes there.

| # | Edit | Predicted red |
| --- | --- | --- |
| M9 | drop the `pending.checked_sub` release in the failure branch | forced-failure + unregistered-recipient tests |
| M21 | plain `cargo build --target wasm32-unknown-unknown` instead of `cargo near build` | `reason_code_panics_reach_the_receipt_outcome`. **This one already fired for real:** the tier was initially built the plain way, every panic arrived as `WebAssembly trap: unreachable`, and the contract's stable reason codes were silently gone. |
| M22 | `TEST_DAY_NS` as the default day length in `setup()` | `concurrency_parent_cap_is_exact_*` (via the one-day-bucket assertion). **Also fired for real:** a 100 ms day made `current_day()` a moving target and would have let 16 concurrent payments draw on two separate daily budgets. |
| M10 | remove the `status != TransferPending` idempotency gate | forced-failure test (figures double) |
| M17 | mock's `ft_transfer` returns instead of panicking when armed | forced-failure test (differential control) |
| M18 | drop the receiver-registration check in the mock | `unregistered_recipient_releases_the_reservation` |

## Expected to survive

| # | Edit | Why it survives |
| --- | --- | --- |
| M5 | merge the two passes into one check-and-charge loop | A panic reverts the whole receipt on NEAR, so a combined loop is safe *today*. The split exists to remove the dependency on that property. A surviving mutation here is a documented design note, not a test to fudge. |

## Chain Signatures rail (`contracts/integration-tests/tests/chain_signatures.rs`)

| # | Edit | Predicted | Actual |
| --- | --- | --- | --- |
| M23 | build the ERC-20 calldata with a hardcoded destination instead of the authorized payee | **predicted SURVIVE** | **SURVIVED.** 17/17 green while the vault signed a transfer to `0x…dead` no matter who was authorized. |
| M24 | build the calldata with a fixed amount instead of the authorized amount | `the_signed_payload_changes_with_the_authorized_amount` | as predicted |
| M14 (re-run) | collapse the ledger's node dimension to a single pool | the whole hierarchy suite | **7 tests across 3 binaries**, now including `base_route_signs_and_converts_pending_to_executed` |
| M9 (re-run) | drop the `pending.checked_sub` release in the shared `resolve_reservation` | the reservation tests | 5 sandbox tests, confirming the extracted resolver still carries the invariant for BOTH rails |

### M23 is the one worth reading

It is the worst bug this rail can have — the budget tree passes, the payee
allowlist passes, and the signature pays an attacker — and the suite could not
see it. Every test used a single payee, so `..._changes_with_the_authorized_amount`
varied the wrong axis and the hardcoded destination never showed up.

The missing test (`the_signed_payload_changes_with_the_authorized_payee`) was
written while M23 was still applied and confirmed red before the mutation was
reverted. Without that step it would have been 8 greens recorded as "M23
survives, probably fine".

This is also the argument for building the transaction on-chain at all. Had the
contract accepted a caller-supplied payload hash, M23 would not have been a
mutation — it would have been the feature.

### What the Chain Signatures tests do NOT establish

The signer is a mock. These tests prove the vault asks for a signature over a
transaction it built from the values it authorized, and that a refusal releases
the reservation. They do not prove the signature is cryptographically valid,
that the transaction is well-formed to a Base node, or that it would be
accepted on-chain. That needs a real `v1.signer` and a real relay, and until
then `SIGNED` is deliberately a different status from `SETTLED`.

The RLP encoder is pinned against the canonical RLP spec vectors in
`contracts/vault/src/evm.rs` (`dog`, `""`, `[]`, `["cat","dog"]`, the 55/56-byte
boundary, and integer-zero-as-empty-string) rather than against itself — an
encoder that is self-consistently wrong would otherwise look correct.

## The mock had the signer's interface wrong, in three ways

Before the first live call, `v1.signer-prod.testnet`'s embedded ABI was read off
chain and one `sign` call was made directly from a funded account. Three
mismatches surfaced that the mock could not have shown, because a mock agrees
with whatever the caller sends:

| | What the mock assumed | What the real signer does |
| --- | --- | --- |
| Deposit | none attached | `sign` is **payable** — a deposit-free call is rejected. 1 yocto accepted. |
| Args | `{payload: [u8;32], path, key_version}` | `{payload_v2: {Ecdsa: hex}, path, domain_id}`. The old shape survives only via a **deprecated** alias. |
| Response | flat strings | nested: `{big_r:{affine_point}, s:{scalar}, recovery_id, scheme}` |
| Gas | 200 Tgas guessed | `config` reports a 15 Tgas requirement; 100 completed a real signature |

| # | Edit | Predicted | Actual |
| --- | --- | --- | --- |
| M25 | drop the 1-yocto deposit on the `sign` call | 4 Base tests | as predicted — **but only after the mock was corrected.** Against the original non-payable mock this mutation SURVIVED silently, and the failure would first have appeared on live testnet. |

The mock is now `#[payable]` and asserts a deposit, mirrors the real field
names, and returns the real nested response shape. That is what makes the
sandbox tier able to fail for the reason the live network would.

Domain 0 was also confirmed to be CaitSith/secp256k1 on the live contract.
Domain 1 is Frost/Ed25519 and would have produced a signature no EVM chain can
verify — a wrong default that would have looked fine in every test.

## Live run, 2026-10-26 (v2.floatvault-12329.testnet)

Against the REAL signer, not the mock:

- Happy path: `r1` paid 60 USDC to a Base address. The signer logged
  `predecessor=v2.floatvault-12329.testnet` — the VAULT asked, not the agent —
  with `path: "base-1"`, `domain_id: 0`, and a 32-byte payload the vault
  computed. Result `status: SETTLED, reason_code: SIGNED`.
- Blocked: `r2` asked for 60 with its OWN cap fully intact (available
  100000000, executed 0) and was refused `PARENT_DAILY_BUDGET`. Grepping the
  blocked transaction's receipts for `v1.signer` returns **0** — the signer was
  never reached — and `pending` is 0 at every level, so no reservation leaked.
- The agent key was confirmed on-chain as
  `only do ["request_payment"] function calls on v2.floatvault-12329.testnet`,
  which is M15 against the real network rather than the sandbox.
- The live call used args generated by the MCP's own `buildRoute`, so the wire
  format the product emits is what was exercised.

Still NOT established by any of this: that the signature is valid for Base, or
that the transaction would be accepted there. Nothing was relayed.

## Gas ceiling (`contracts/integration-tests/tests/gas_ceiling.rs`)

| # | Edit | Predicted | Actual |
| --- | --- | --- | --- |
| M26 | `wrapping_mul` instead of `checked_mul` on `gas_limit * max_fee_per_gas` | overflow test | **SURVIVED.** See below. |
| M27 | remove the ceiling check entirely | the ceiling tests | 4 of 7 red |
| M28 | remove the sweep's age floor (`aged = true`) | `sweep_leaves_a_young_reservation_alone` | as predicted |

### M26 survived because the TEST was weak, not the guard

The first overflow test used the obvious inputs — `gas_limit = u64::MAX`,
`max_fee_per_gas = u128::MAX`. That product wraps to `2^128 - 2^64 + 1`, which
is astronomically ABOVE the ceiling, so the request was still refused and the
test still passed. It was refusing for the wrong reason and proving nothing
about overflow at all.

The input that actually exercises it is `2^63 * 2^65 = 2^128`, which wraps to
exactly **zero** — the one shape where a wrapping multiply reads as "free" and
the guard waves through the most expensive transaction the vault can build.
The test now asserts its own premise (`wrapping_mul(gas, fee) == 0`) before
making the call, so it cannot silently drift back to inputs that do not wrap
small, and it keeps the both-maxed pair as a second shape.

Rewritten while M26 was still applied and confirmed red before reverting.

The general lesson, which has now cost two mutations on this feature (M23 was
the same shape): *a passing test proves nothing about the clause you think it
covers until a mutation shows which assertion carries it.* Picking the
laziest extreme value is not the same as picking the adversarial one.

## M28 — the ancestor check ignores pending reservations

The mutation that matters most for the concurrency claim, because it IS the
failure mode the pitch says Float avoids.

```rust
// real
if amount.0 > available(lim.daily_cap.0, &led) {
// mutant — count only settled spend, ignore in-flight reservations
if amount.0 > lim.daily_cap.0.saturating_sub(led.executed) {
```

A reservation that has been taken but not yet settled stops counting against
the pool. Each individual draw looks affordable against `executed` alone, so
the eleventh 10-USDC draw is admitted into a 100-USDC pool.

Caught by all 8 `i4_contention_seed_*` tests:

```
seed 0 step 10: pool OVERDRAWN — committed 110000000 > cap 100000000
```

Every seed fails at step 10, which is the first step where an unsettled
reservation could matter. That it is the SAME step across independently
shuffled interleavings is the point: the overdraw is a property of the
accounting rule, not of one unlucky ordering.

**A note on how this mutation was nearly recorded as passing.** The first
attempt wrote `led.executed.0`, which does not compile — `executed` is already
`u128`. The test command was filtered through a grep for "test result|
OVERDRAWN", the build error matched neither, and the run therefore printed
nothing at all. Nothing looks exactly like a clean pass. The mutation was only
caught because an empty result from a command that should always print
*something* is itself the anomaly worth checking.


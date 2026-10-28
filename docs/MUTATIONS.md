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

Baseline, measured 2026-10-28: **100 unit (production layout) / 98 unit
(test-clock) + 24 sandbox.** Both unit runs are REQUIRED and neither subsumes
the other: the production and test-clock state layouts differ by 8 bytes
(`day_len_ns_override`), so the migration's real-bytes tests can only run
without the feature and are skipped with it.

    cargo test -p vault                        100 passed
    cargo test --features test-clock -p vault   98 passed

The sandbox 24 are 2 concurrency + 1 keys + 7 sandbox + 8 virtual_agent +
4 migration + 2 panic_reason_codes (those last two need
scripts/m21-plain-vs-cargo-near.sh; they skip LOUDLY rather than silently if
its artifacts are absent).
(The earlier "33 unit + 9 sandbox" line predates the virtual-agent rail and the
removal of the MPC/Base rail's `chain_signatures.rs`.)

The sandbox tier must run under Linux or WSL: `near-workspaces` ships a
sandbox node only for linux-x86_64, linux-aarch64 and darwin-arm64. Build the
wasm with `scripts/build-wasm.sh` (which uses `cargo near build`, never plain
`cargo build` — see the note in the workspace `Cargo.toml`) and run with
`CARGO_TARGET_DIR` pointed at a Linux-native path.

`scripts/wsl-sandbox.sh` wraps all of that, callable from Windows:

```sh
wsl -d Ubuntu -- bash /mnt/c/.../scripts/wsl-sandbox.sh all          # build + whole tier
wsl -d Ubuntu -- bash /mnt/c/.../scripts/wsl-sandbox.sh check        # compile only
wsl -d Ubuntu -- bash /mnt/c/.../scripts/wsl-sandbox.sh one  <file>  # one test file
wsl -d Ubuntu -- bash /mnt/c/.../scripts/wsl-sandbox.sh mut  <file>  # REBUILD + run (mutations)
```

Invoke it from PowerShell, not git-bash: git-bash rewrites the `/mnt/c/...`
argument into a Windows path and `bash` then cannot find the script.

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
- **Now verified (2026-10-28):** `scripts/deploy-testnet.sh` has been run
  end-to-end against testnet, deploying to a fresh `v4.floatv4.testnet` with
  `OWNER=floatv4.testnet`. The `clock_mode` guard executed and printed both
  sides (`expected='production' actual='production'`). Superseded the earlier
  note that only `bash -n` had been done.
  - One portability fix was required: cargo-near generates the ABI by
    compiling the crate NATIVELY as a cdylib, and on Windows MSVC that link
    fails with ~52 unresolved near-sdk host-function externs (`panic_utf8`,
    `promise_batch_create`, …) because `link.exe`, unlike `ld`, refuses to emit
    a DLL with undefined symbols. The ABI step is now opt-out via `NO_ABI=1`;
    the wasm build still runs THROUGH cargo-near, so `--cfg near` is preserved.
    Confirmed rather than assumed: the resulting wasm was byte-identical
    (sha256 `23a44704…`) to the repo's checked-in build, `grep -c panic_utf8`
    = 1, and a live call returned a readable
    `Smart contract panicked: INSUFFICIENT_GAS: …` rather than a bare
    `unreachable` trap. On Linux/WSL the ABI step succeeds and no flag is
    needed — which is itself the evidence that the ABI step, and nothing else,
    was the Windows failure.

---

### M25 / M26 / M27 — the virtual-agent rail (`tests/virtual_agent.rs`)

Run against the sandbox tier on 2026-10-28, after it gained the signed path.
Until then the virtual-agent surface had **zero** references in any sandbox
test: the symbols were in the wasm and unreachable from a real runtime, so
`env::ed25519_verify` had only ever been exercised against near-sdk's *mock*.

Baseline for these rows: **95 unit + 18 sandbox** at the time they were run
(8 of the 18 being `virtual_agent.rs`). The tier is 20 now — `panic_reason_codes.rs`
was added afterwards by the M21 row below.

| # | Edit | Predicted red | Actual |
| --- | --- | --- | --- |
| M25 | `dispatch_payment` gas floor, `prepaid_gas() < floor` → `<=` | `the_gas_floor_admits_its_own_boundary_and_refuses_below_it` only; every other test attaches `max_gas()` | ✅ **1 failed, 7 passed** — exact match, on the predicted assertion (`exactly 50 Tgas must dispatch`) |
| M26 | nonce freshness, `nonce <= last` → `nonce < last` (permits exactly one replay) | `a_replayed_signature_is_refused_by_the_contract`, `rebinding_a_revoked_key_does_not_reset_its_nonce` | ✅ **2 failed, 6 passed** — exact match, both `left: "DUPLICATE_REQUEST"` / `right: "NONCE_NOT_FRESH"` |
| M27 | `if !env::ed25519_verify(&sig, &msg, &pk32)` → `if false` | `a_relayer_cannot_rewrite_any_signed_field`, `an_unbound_key_cannot_spend` | ✅ **2 failed, 6 passed** — exact match, `left: "SETTLED"` / `right: "BAD_AGENT_SIGNATURE"` |

Three things these rows establish that the unit tier cannot:

- **M27 matters most.** It proves the HOST `env::ed25519_verify` is
  load-bearing under `neard` — and because `tests/virtual_agent.rs` re-derives
  the borsh encoding by hand rather than importing `VirtualAgentBinding`, that
  the encoder genuinely detects forgery instead of agreeing with itself. The
  unit tier signs via `near_sdk::borsh::to_vec` on the real struct, so it
  agrees by construction and could never catch an encoding mistake.
- **M26 shows why the reason code, not just "blocked", must be asserted.**
  With the nonce guard weakened the replay was still refused — by the
  duplicate-`request_id` check behind it. A test asserting only
  `status == "BLOCKED"` would have **survived** M26 while the replay guard was
  broken. Layered defence, bad oracle.
- **M25 is not hypothetical.** This exact `<` → `<=` slip was introduced into
  the working tree while the comparator's own doc comment was being corrected,
  and was caught by the unit-tier boundary test. The floor is now pinned from
  both sides in both tiers, and against live testnet numbers (50 Tgas settles,
  49 panics).

Protocol note: in all three rows the wasm hash was printed before the run and
differed from baseline (`596c6791` → `03c64d2a`, `ec4c9a66`, `e3622f4e`). A
mutation run that forgets `scripts/build-wasm.sh` tests the PREVIOUS binary and
reads as a survival, so `scripts/wsl-sandbox.sh mut <file>` pairs the rebuild
and the run and cannot drift apart.

### M29 — the gas floor must PANIC, not return `blocked` (unit tier)

Run on 2026-10-28 alongside the comment fix that scoped the nonce-burn
guarantee. M25 pins the floor's *direction*; this pins its *mechanism*, which
is a separate property and the one with a griefing vector behind it.

Baseline for this row: **95 unit.**

| # | Edit | Predicted red | Actual |
| --- | --- | --- | --- |
| M29 | `dispatch_payment` gas floor, `fail(ReasonCode::InsufficientGas, …)` → `return blocked(&request_id, node_id, ReasonCode::InsufficientGas)` | `an_under_gassed_signed_payload_panics_rather_than_consuming_its_nonce` only; `a_signed_payload_at_exactly_the_gas_floor_dispatches` is insensitive to it | ✅ **1 failed, 1 passed** (`cargo test -p vault gas`) — exact match, `test did not panic as expected`, and the boundary test stayed green as predicted |

Why the mechanism is load-bearing: `request_payment_signed` burns the nonce
*before* calling `dispatch_payment`. A panic reverts that insert along with the
rest of the receipt, so an under-gassed payload stays replayable — which is
what stops a malicious relayer from destroying an agent's signed payloads by
deliberately under-gassing them. Returning `blocked` instead commits the burn
and opens exactly that vector, while every assertion about the payment being
*rejected* keeps passing. The reason code is identical either way, so an
oracle that checks only `INSUFFICIENT_GAS` survives this mutation — same
lesson as M26, one layer further in.

**What this row does NOT establish.** The revert is invisible to the unit
tier: an unwinding panic does not roll back the in-memory `self`, and the
insert precedes the floor check, so this process's counter advances either
way. The test can only assert that the path panics rather than returning. The
revert itself rests on the live testnet run of 2026-10-28 against
`v4.floatv4.testnet` — 49 Tgas panicked with `INSUFFICIENT_GAS` and
`get_virtual_agent_nonce` was unchanged afterwards, so the payload remained
replayable. Making that directly observable needs a real receipt; queued
below.

---

### M30 — drop `#[private]` from `migrate`: **EXECUTED**, gap closed

`a8f8c14` added `migrate` and recorded `#[private]` as deliberately **not
covered**: "near-sdk emits that check into the wasm export, so a native unit
test never crosses it and a should_panic test fails rather than passes. It needs
the sandbox tier, which has no Windows binary — a known gap, not a passing
test." The diagnosis was exactly right. The premise is no longer true:
`scripts/wsl-sandbox.sh` runs the tier under WSL.

- **Edit:** `contracts/vault/src/lib.rs`, remove `#[private]` from `migrate`.
- **Predicted:** `a_stranger_cannot_call_migrate` and
  `even_the_owner_cannot_call_migrate` red; the self-call control and the
  `get_base_config` row unaffected.
- **Actual:** ✅ **2 failed, 2 passed** — exact match.

**What the mutation revealed, which is the reason the test asserts a specific
message.** With `#[private]` gone, the stranger's call still fails — with
`Smart contract panicked: Cannot deserialize the contract state.` It is stopped
only by the legacy layout failing to parse, not by access control. A test that
merely asserted "a stranger cannot call migrate" would have **survived M30**
while the access control was gone.

And that masking is not safe in the one case that matters. `migrate` exists to
run against state that IS the legacy layout — so on a pre-migration vault the
deserialize **succeeds**, and without `#[private]` any account could call
`migrate` and overwrite state through the shadow struct. The only thing that
makes the mutation look harmless in a test is that the fixture vault is already
migrated. Same shape as M26: layered defence, bad oracle.

Covered by `contracts/integration-tests/tests/migration.rs` (4 tests), which
pairs the two rejection tests with a self-call control. The control is load
bearing: it shows `Contract::call` satisfies predecessor == current and fails on
deserialize instead, which is what proves the private check — rather than some
unrelated failure — is what rejects the stranger.

One process note. The first run of these tests reported **4 failed, all
`MethodResolveError(MethodNotFound)` for `migrate`** — because `wsl-sandbox.sh
one` does not rebuild, and `res/vault_test_clock.wasm` predated `a8f8c14`. The
tests were correct and the binary was stale. This is the failure the protocol's
step 3 warns about, met from the other direction: not "the mutation is missing
from the binary" but "the FEATURE is missing from the binary". Use `mut`, which
pairs the rebuild with the run.

---

### M21 — plain `cargo build` instead of `cargo near build`: **EXECUTED**, claim upheld

Previously listed as blocked on the sandbox tier, and the subject of a direct
contradiction in this repo: the workspace `Cargo.toml` and this file said a
plain build destroys panic reason codes, while commit `c732cbe` reported that
"both artifacts import the same 40 `env` host functions" and removed the
warning as unsupported. Settled by measurement.

- **Edit:** none to the source. The *build command* is the mutation. Both
  artifacts produced by `scripts/m21-plain-vs-cargo-near.sh` from identical
  source, toolchain (rustc 1.99.1), profile (`--release`) and features
  (`test-clock`), in one WSL environment.
- **Predicted:** the plain artifact loses the message. Written as a
  *differential* assertion rather than an absolute one — the test asserts only
  that the two artifacts behave DIFFERENTLY and prints which way, so a pass
  could not encode the claim under test as its own premise.
- **Actual:** ✅ **claim upheld.** Same source, same panic (`add_node` with an
  empty label → `fail(ReasonCode::InvalidConfig, ..)`), one sandbox:

  | build | receipt |
  | --- | --- |
  | `cargo near build` | `Smart contract panicked: INVALID_CONFIG: label must be 1..=48 chars` |
  | plain `cargo build` | `WebAssembly trap: An `unreachable` opcode was executed.` |

- **Pinned by:** `contracts/integration-tests/tests/panic_reason_codes.rs`,
  which deploys both into one sandbox. It skips when the artifacts are absent,
  since `build-wasm.sh` deliberately produces only the correct one.

**Why `c732cbe` reached the opposite conclusion, and the lesson.** Its claim is
not reproducible: the real import counts are **38 (plain) vs 40 (cargo-near)**,
with `panic_utf8` and `sha256` missing from the plain build — measured with
`scripts/wasm-imports.mjs`, which parses the import section. Any correct
comparison of these two artifacts shows a difference, so whatever was compared,
it was not these two. Note the sizes differ almost 2:1 (624,090 vs 290,110
bytes), which is a cheap sanity check that two artifacts are not the same thing.

The second lesson is where the mechanism lives. Grepping **near-sdk** for the
cfg finds only a `compile_error!` gate and a doc line — no implementation
switch — which reads convincingly as "the claim is unfounded." But `near-sdk`
re-exports `panic_str` from **`near-sdk-env` 0.1.7**, which gates
`use near_sys as sys` on `all(near, target_arch = "wasm32")` and branches:

```rust
pub fn panic_str(message: &str) -> ! {
    execute_target_specific! {
        host:  { unsafe { sys::panic_utf8(..) } },   // only with --cfg near
        local: { eprintln!("{message}"); panic!() }  // otherwise
    }
}
```

Without `--cfg near` the `local` branch compiles: `eprintln!` goes nowhere on
wasm and `panic!()` lowers to an `unreachable` opcode. `sha256` is substituted
the same way. Those are the "pure-Rust fallbacks" near-sdk's docs call "not for
on-chain use" — they are simply in a different crate than the one you would
grep. **A negative result from reading one crate is not a refutation when the
symbol is re-exported from another.**

Third: `grep -c panic_utf8 <wasm>` is not a test for "is it imported". It also
matches the name section and string data, so it can report a function that is
not imported — and on a stripped binary can look identical for the wrong
reason. Use the import section.

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
| ~~M21~~ | plain `cargo build` instead of `cargo near build` | **EXECUTED 2026-10-28 — see the M21 section above.** No longer blocked. |
| M22 | `TEST_DAY_NS` as the default day length in `setup()` | `concurrency_parent_cap_is_exact_*` (via the one-day-bucket assertion). **Also fired for real:** a 100 ms day made `current_day()` a moving target and would have let 16 concurrent payments draw on two separate daily budgets. |
| M10 | remove the `status != TransferPending` idempotency gate | forced-failure test (figures double) |
| M17 | mock's `ft_transfer` returns instead of panicking when armed | forced-failure test (differential control) |
| M18 | drop the receiver-registration check in the mock | `unregistered_recipient_releases_the_reservation` |
| M29 (re-run) | the M29 edit, `fail(InsufficientGas, …)` → `return blocked(…)` | **The test does not exist yet — write it before claiming this row.** The unit tier can only prove the path panics; only a real receipt shows the nonce burn reverting with it. Shape: submit a signed payload below the floor, assert the receipt failed with `INSUFFICIENT_GAS`, assert `get_virtual_agent_nonce` is unchanged, then assert the SAME payload still settles at adequate gas. Under the mutation the burn commits, so the retry comes back `NONCE_NOT_FRESH`. Until then the atomic revert rests on the manual testnet run recorded in M29. |

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


### M31 — `XCHAIN_HEADROOM` 0.02 → 0.01

The cross-chain cap headroom, dropped below the worst measured spread (1.52%
at 0.50). Covers `packages/create-float/test/xchain.test.mjs`.

- **Edit:** `packages/create-float/bin/xchain.mjs`, `XCHAIN_HEADROOM = 0.01`.
- **Predicted:** 3 of the 5 new tests red — "a derived cap covers what a live
  quote actually charged", "xchainCap rounds UP", "the headroom exceeds the
  worst measured spread". The smallest-size and round-trip rows PASS, because
  0.50 still clears at 1% (cap 0.51 vs charged 0.507579) and the round-trip
  holds for any positive headroom.
- **Actual:** ✅ **3 failed, 6 passed** — exact match, including which rows
  survived. The live-charge row failed at **10**, not at 0.50:
  `cap for 10 is 10100000 but delivering it was charged 10105478`.
- **Re-run after a correction to the subject.** The first version of this
  change applied `xchainCap` to the WRONG BRANCH of `DEFAULT_TREE` — testnet
  instead of mainnet, because `MAINNET ? … : …` gives mainnet the SMALL tree.
  The fixtures were widened to the mainnet scale (0.5/1/1.5/2 alongside
  10/50/60/100) and M31 re-run: still 3 failed, 6 passed. Worth recording that
  the mutation was re-run rather than assumed to still hold — the fixture set
  changed underneath it, and a row count carried over from before the change
  would have been evidence about a suite that no longer existed.

Worth recording for the shape rather than the row. The fixtures are charges
from live 1Click dry quotes, not `desired * 1.02`, for the same reason
`binding.test.mjs` pins bytes emitted by the Rust struct: a fixture derived
from the thing under test only proves self-consistency. Had `MEASURED` been
computed from the constant, every row would have stayed green at 1%, 0.5% or
0% headroom — the suite would have asserted nothing at all while looking like
coverage.

The property row (`headroom > worst measured spread`) exists for the opposite
drift: someone re-measures a worse spread, updates the fixtures, and does not
revisit the constant. That row notices; the per-row assertions would all still
pass against their own updated numbers.

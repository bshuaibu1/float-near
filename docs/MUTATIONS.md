# Mutation log

A passing test proves nothing until a mutation proves *which clause* carries
it. Each row below was produced by editing the named line, running the suite,
and reverting by editing the line back — never with `git restore`, which would
take the uncommitted implementation with it.

Protocol for every row:

1. State the predicted red tests **before** running. A disagreement is a bug
   in the prediction or in the test, and gets investigated before moving on.
2. Apply the mutation with the editor.
3. Run `AWS_LC_SYS_PREBUILT_NASM=1 cargo test -p vault`.
4. Revert by editing the line back; re-run and confirm green. That run doubles
   as proof the revert restored the right code.
5. If a mutation **survives**, write the missing test *while the mutation is
   still applied*, watch it go red, then revert. Writing it afterwards only
   describes the hole.

Baseline: **8 passed, 0 failed, 0 warnings.**

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

---

## Queued (the tests exist; the mutation has not been run yet)

Do not record these as proven until each has a real result in the table above.

| # | Edit | Predicted red |
| --- | --- | --- |
| M1 | `add_node` I1 check `new_sum > parent_cap` → `>=` | `i1_sigma_children_equal_to_parent_is_allowed` |
| M2 | delete the parent-side re-check in `set_node_caps` | `i1_lowering_parent_below_existing_children_is_rejected` |
| M4 | `request_payment` pass two, `&chain` → `&[node_id]` | needs the sandbox tier (I3 charge is observable only as `pending` at every level) |
| M11 | `available()` `saturating_sub` → `-` | `available_saturates_when_a_lowered_cap_is_already_exceeded` |
| M20 | `clock_mode()` → `"production"` under `--features test-clock` | `scripts/deploy-testnet.sh` guard |

## Blocked on the sandbox tier (`contracts/integration-tests`)

These cannot be run at all from the unit tier, because a unit test cannot
schedule a promise and the callback never executes there.

| # | Edit | Predicted red |
| --- | --- | --- |
| M8 | callback `req.reserved_day` → `self.today()` | day-boundary test |
| M9 | drop the `pending.checked_sub` release in the failure branch | forced-failure + unregistered-recipient tests |
| M10 | remove the `status != TransferPending` idempotency gate | forced-failure test (figures double) |
| M12 | freeze check `&chain` → leaf only | freeze-subtree test |
| M13 | `effective_recipients` returns inherited ∪ own | allowlist-override test |
| M15 | drop `method_names` from the provisioned access key | function-call-key reachability test |
| M17–M19 | harness guards: mock `set_fail_next`, receiver registration, `TEST_DAY_NS` | the tests that depend on each |

## Expected to survive

| # | Edit | Why it survives |
| --- | --- | --- |
| M5 | merge the two passes into one check-and-charge loop | A panic reverts the whole receipt on NEAR, so a combined loop is safe *today*. The split exists to remove the dependency on that property. A surviving mutation here is a documented design note, not a test to fudge. |

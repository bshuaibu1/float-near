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

It also has a live limitation. The nonce is part of the SIGNED payload, and the
caller supplies it. With a hardcoded 0 only the first such transaction can ever
land; the rest are rejected as nonce-too-low **after their NEAR reservation has
already been consumed**. Even reading the real nonce first does not fix the
concurrent case, because two payments would be signed for the same nonce.
Operator mode has no such problem — it reads its own nonce at send time, after
authorization.

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

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

There is currently **no** owner method to release a stuck reservation inside
the same day. That is a known gap, not a defended design decision.

## 5. What the contract does NOT prove about Base

A successful `sign` promise proves the vault obtained a signature over a
transaction it built itself. It does **not** prove:

- that the signature is valid for Base,
- that the transaction is well-formed to a Base node,
- that it was relayed, or included, or that USDC moved.

Relaying is off-chain and the contract cannot observe it. This is why `SIGNED`
is a deliberately distinct reason code from `SETTLED`, and why the dashboard
reports the rail as `base` rather than `near`. Nothing in this repo has been
relayed to Base.

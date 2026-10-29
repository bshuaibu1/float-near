# Decision: ship UX first, move to global contracts when funded

Status: **accepted**, 2026-10-29.
Supersedes nothing. Depends on `GLOBAL-CONTRACTS-NEP-591.md` for the mechanics.

## The decision

Build the onboarding UX now against the current per-vault deployment model.
Move to NEP-591 global contracts once there is capital to fund user vaults.
The two are independent: nothing in the UX work has to be redone, because the
only thing global contracts change is **who pays for the code bytes and how
much** — not the contract's API, its state layout, or the wizard's steps.

## Why this order, when the economics favour global contracts so heavily

Because the 2.80 NEAR per vault is only a blocker once there are users to pay
for, and there are none until the UX exists. Today the step count is what
stops people, not the deposit. A 10-step flow at 0.04 NEAR converts no better
than a 10-step flow at 3.00 NEAR.

The reverse order would also mean burning 28 NEAR before knowing whether
anyone wants the product.

## The numbers, measured — not estimated

Read from `float.test015.near` on 2026-10-29. A real vault: 4 nodes, 3
payments, 1 agent account bound, quote signer registered.

| | bytes | stake at 1e19/byte |
| --- | --- | --- |
| total `storage_usage` | 284,576 | 2.84576 NEAR |
| of which contract code | 280,249 | 2.80249 NEAR |
| **non-code state** | **4,327** | **0.04327 NEAR** |

Under a global contract the code bytes disappear from the account and are
replaced by a 32-byte pointer:

| | per vault |
| --- | --- |
| stake today | **2.84576 NEAR** |
| stake with global contract | **0.04359 NEAR** |
| saved | **2.80217 NEAR** |

One-time deployer cost: 280,249 bytes x 1e20 (the 10x global rate) =
**28.0249 NEAR, burned**, not locked, not recoverable.

### Break-even is exactly 10 vaults

`28.0249 / 2.80217 = 10.0`. Below ten users the per-vault model is cheaper.
Above it, the saving compounds without limit.

### What a funding round buys

Assuming ~0.05 NEAR all-in per vault (0.0436 stake + ~0.007 account-creation
gas), and 0.60 NEAR if each user also gets a real agent sub-account
(`create_agent_account` is 0.55 — 0.5 key allowance + 0.05 storage, and global
contracts do NOT reduce it, since an agent account holds no code):

| funding | vaults today (3 NEAR each) | vaults w/ global, no agent acct | w/ global + 1 agent acct |
| --- | --- | --- | --- |
| 100 NEAR | 33 | ~1,439 | ~119 |
| 500 NEAR | 166 | ~9,439 | ~786 |
| 1,000 NEAR | 333 | ~19,439 | ~1,619 |

**~58x more users per NEAR** on the vault-only line.

### Most of it is float, not spend

The storage stake is a refundable **lock**, released when the account is
deleted. The genuinely burned costs are the 28.0249 one-off and ~0.007 of gas
per account created. So the table above is mostly a working-capital
requirement, and `float-exit` returning a user's stake returns it to us too.

The 0.55 agent-account cost is the expensive line and it is **not** addressed
by global contracts. Virtual agents cost ~0.001 NEAR and need no sub-account;
the only reason the MCP path needs a real one is that MCP signs
`request_payment` with a function-call key. Making MCP able to sign
`request_payment_signed` as a virtual agent — with a relayer submitting —
would remove 0.55 from every user. That is a bigger saving per user than
global contracts and should be costed alongside it.

## "Can someone hack the global contract?"

Depends entirely on which of the two modes is used, and the difference is the
whole security question.

### `CodeHash` — immutable, and the answer is no

The contract is identified by the **hash of its wasm**. There is no admin, no
owner, and no upgrade path. Nobody can change the code at a given hash —
including us. Substituting different code would require a SHA-256 preimage or
collision.

### `AccountId` — updatable, and this is the risk being asked about

The deployer account can replace the wasm, and **every referencing vault runs
the new code immediately, with no action by its owner**. Whoever controls that
deployer key controls the logic of every vault built on it, and could deploy
code that drains all of them at once.

That is a genuine single point of failure and the reason to use `CodeHash`,
or to put an `AccountId` deployment behind a DAO or multisig with a timelock.

### What global contracts do NOT change

- **Code is shared; state is not.** Each vault keeps its own storage, its own
  owner, its own budget tree. There is no cross-vault contamination path.
- **A bug in shared code affects everyone** — but that is already true. Every
  vault today runs a byte-identical copy of the same wasm, so a bug is equally
  universal. Global contracts change the blast radius of a *key compromise*,
  not of a *bug*.
- **The owner's authority is unchanged.** `float.test015.near` has exactly one
  access key and it is FULL ACCESS. Its holder can already deploy arbitrary
  code onto the vault — that is how `get_node` was fixed on 2026-10-29. So
  "the code can be replaced by whoever holds the owner key" is a property of
  the system today, not something global contracts introduce.

### The residual risk worth naming

Phishing: someone deploys a malicious global contract and persuades a user to
point at it. The mitigation is that the wizard pins a known hash and the
dashboard shows which hash a vault references, so a mismatch is visible.

## The cost `CodeHash` imposes, which we have already felt

With `CodeHash`, upgrades are **opt-in per vault**: each owner must sign a
`UseGlobalContract` switching to the new hash.

This is not hypothetical. On 2026-10-29 we shipped `get_node` with an orphaned
`#[private]` that made it uncallable as a view, and fixed every user at once
with a single redeploy. Under `CodeHash` that fix would have reached only the
vaults whose owners actively migrated — and most never would.

So the real trade is:

| | `CodeHash` | `AccountId` |
| --- | --- | --- |
| can the deployer change your code? | **no** | yes, silently |
| can we ship a fix to everyone? | no — opt-in only | yes |
| single point of failure | none | the deployer key |

A defensible middle path, for when this is actually built: deploy under
`CodeHash`, keep a signed version registry the wizard reads, and give the
dashboard a one-click "upgrade available" that produces the owner-signed
`UseGlobalContract`. Fixes stay opt-in, but opting in costs one click rather
than a migration guide.

## What we do now instead

In priority order, none of which is invalidated by a later migration:

1. **`ft_transfer_call` one-shot setup.** Collapses the two manual token steps
   (`storage_deposit` + `ft_transfer`) into one user-signed call carrying a
   `msg`. Removes the worst part of the current flow with no new
   infrastructure. See §13 — a factory contract cannot do this, because
   `ft_transfer` must be signed by the token holder.
2. **MCP auto-config.** Write the client config instead of printing env vars.
3. **Prefilled handoff links** rather than printed CLI commands, for the
   things only a human can do.
4. **Operator daemon** for cross-chain deposit-address registration (§13e).

## Revisit when

- there are ≥10 live vaults (break-even), **or**
- a funding round closes, **or**
- the contract's size changes materially — the 28 NEAR burn scales with the
  wasm, and every redeploy under `AccountId` burns again.

# Global Contracts (NEP-591) and a Float V2 deployment model

**Status: roadmap note, nothing implemented.** No code in this repo uses global
contracts. This records what the protocol offers, what it would cost *with this
vault's measured size*, and which claims are verified against what.

Every figure below is either measured from this repo on 2026-10-28 or taken
from the NEP. Where a number came from neither, it is marked as unverified
rather than stated.

## 1. The problem it addresses

Each Float vault today deploys its own copy of the compiled wasm to its own
sub-account. NEAR charges storage staking for that code — a refundable *lock*,
not a fee, at `1e19` yocto per byte (1 NEAR per 100 kB; see
`packages/create-float/bin/create-float.mjs:388`).

Measured, not estimated:

| artifact | bytes | KiB |
| --- | --- | --- |
| production build (`--no-default-features`) | 280,249 | 273.7 |
| sandbox build (`--features test-clock`) | 291,041 | 284.2 |
| `v4.floatv4.testnet` on-chain, code + state | — | 290.9 |

So the code stake is **~2.80 NEAR per vault**, and `create-float`'s default ask
is 3.00 NEAR once gas and node state are included.

Worth keeping straight, because it is the honest framing and the wizard already
makes it: this is **locked, not spent**. `a8f2ab5` reworked the install plan for
exactly this reason — ~4.08 of the old 4.10 ask was refundable and only ~0.02
was burned. The friction is capital lockup and the UX of asking for it, not a
fee. Calling it a "cost" overstates it; calling it nothing understates the
onboarding barrier.

*(An earlier draft of this note put the contract at 260 KB and the stake at
~2.60 NEAR. Both are low — the measured production artifact is 273.7 KiB. It
also attached a USD figure; that depends on NEAR's price, dates immediately,
and is omitted here.)*

## 2. What NEP-591 is

**Verified:** NEP-591 "Global Contracts" is **Final**. It adds two actions:

- `DeployGlobalContractAction` — publishes the wasm to the network once.
- `UseGlobalContractAction` — an account references that wasm instead of
  deploying its own copy.

Two deployment modes, and the choice is a trust decision:

| mode | reference | upgrade behaviour |
| --- | --- | --- |
| `CodeHash` | the wasm's hash | **Immutable.** Users opt in to a new version by switching to a new hash. |
| `AccountId` | the deployer's account | **Updatable.** The deployer replaces the wasm and every referencing account is upgraded immediately. |

`AccountId` mode hands the deployer the ability to change the code running
every user's vault, with no opt-in. For a product whose pitch is the
*sovereign* vault, that is a material change to the trust model and not merely
an ergonomic choice. See §5.

## 3. It is already available in our toolchain

**Verified by measurement, which is the part worth knowing.** This vault's own
wasm already imports all four host functions — read out of the import section
with `scripts/wasm-imports.mjs`, not grepped:

```
promise_batch_action_deploy_global_contract
promise_batch_action_deploy_global_contract_by_account_id
promise_batch_action_use_global_contract
promise_batch_action_use_global_contract_by_account_id
```

near-sdk 5.29.1 exposes the Rust side (`env.rs:1984`, `:2008`), including
`current_global_contract_id()`, and the two modes appear as the enum this file's
table describes (`env.rs:237-238`):

```rust
AccountContract::Global(hash)          => GlobalContractId::CodeHash(hash),
AccountContract::GlobalByAccount(acct) => GlobalContractId::AccountId(acct),
```

And `v4.floatv4.testnet` deployed successfully to testnet carrying those
imports. An unknown host import is rejected at deploy time, so that deploy is
itself evidence the testnet runtime recognises them.

No SDK upgrade, no toolchain change. The blocker for V2 is design and cost, not
availability.

## 4. The economics: burn, not stake — and it is 10x

**Verified from the NEP, and this is the number the first draft of this note
omitted.** The deployer does not *stake* for a global contract, it **burns**:
the tokens are gone, not locked. And `global_contract_storage_amount_per_byte`
is set to **10x the normal storage staking cost**, to pay for distributing the
code network-wide.

Applied to our measured 280,249-byte build:

| | amount | recoverable? |
| --- | --- | --- |
| per-vault code stake today | **2.80 NEAR** | refundable on account deletion |
| one-off global deploy | **28.02 NEAR** | **permanently burned** |

A "10 vaults and it pays for itself" reading is the wrong comparison, and worth
stating plainly because it is the easy mistake:

- The 2.80 NEAR per vault is **locked and returned**. Over 100 vaults that is
  280 NEAR of user capital tied up — and eventually released.
- The 28.02 NEAR is **destroyed**, once, by us.

So this does not "save" 280 NEAR; it converts a large refundable user-side lock
into a small permanent developer-side burn. That is a genuinely good trade for
onboarding, and it is a real expense on our side rather than an accounting
shuffle. Each new wasm version published under `CodeHash` is another full burn.

**Unverified:** what a user pays for `UseGlobalContractAction` itself. They
certainly still stake for their own account and their own budget-tree state —
which this vault has, since nodes, ledgers and requests are per-vault — so
"zero onboarding cost" is too strong. The right claim is that the *code* stake
goes away; the state stake does not. Measure before quoting a number.

## 5. If this becomes V2

The sequencing that follows from the above, not a commitment:

1. **Resolve the mode question first, because it is a trust decision.**
   `AccountId` gives frictionless upgrades and the power to change every user's
   vault code without consent. `CodeHash` preserves today's guarantee and makes
   upgrades opt-in. This vault's existing posture — `propose_owner` /
   `accept_ownership` two-step, an escape hatch not gated on `paused` — is
   consistently "the operator cannot act unilaterally on user funds."
   `AccountId` mode would cut against that.
2. **Measure the user-side cost** of `UseGlobalContractAction` on testnet before
   any claim about onboarding cost appears in product copy.
3. **Decide who holds the burn.** 28.02 NEAR per published version is a real
   budget line, and `CodeHash` means every release repeats it.
4. **State migration does not get easier.** Global contracts change where *code*
   lives, not how *state* is laid out. Everything in `MUTATIONS.md` M21 and the
   `migrate` work still applies: a field added to or removed from
   `#[near(contract_state)] struct Vault` is still a borsh layout change, and
   each referencing account still needs its own migration. Shared code arguably
   makes this *harder*, since an `AccountId`-mode update changes the code under
   every vault at once while their states migrate independently.

## Sources

- NEP-591, Global Contracts (status: Final) —
  https://github.com/near/NEPs/blob/master/neps/nep-0591.md
- Measurements: this repo at `099f86e`, `scripts/wasm-imports.mjs`,
  near-sdk 5.29.1 source, and `v4.floatv4.testnet` on testnet, 2026-10-28.

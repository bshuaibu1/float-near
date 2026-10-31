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

### What a user pays for `UseGlobalContractAction` — MEASURED 2026-10-31

~~Unverified.~~ Settled on testnet by `scripts/measure-global-contract.sh`.
Four equally funded accounts, two sizes 105x apart, differential:

| | storage_usage | staked | `view_code` returns |
| --- | --- | --- | --- |
| A deploy 49 B, normally | 231 | 0.00231 | 49 bytes |
| B **use** the 49 B global | **214** | **0.00214** | 49 bytes |
| C deploy 5,122 B, normally | 5,304 | 0.05304 | 5,122 bytes |
| D **use** the 5,122 B global | **214** | **0.00214** | 5,122 bytes |

- **C − A = 5,073 bytes**, exactly the padding. The control: a normal deploy
  charges the user for every byte of code.
- **D − B = 0 bytes.** A global reference is **size-independent**. The user
  pays for a 214-byte pointer whether the code is 49 bytes or 5 KB.

`view_code` is the guard that makes this a result rather than a coincidence: an
account with **no** contract would also report small storage, so "small
storage" alone would have been a false positive. B and D return the full 49 and
5,122 bytes, so they really are running the global code.

Applied to the current 299,016-byte build:

| | amount |
| --- | --- |
| code stake today | 2.99016 NEAR |
| stake referencing a global | **0.00214 NEAR** |
| saved per vault | 2.98802 NEAR |
| one-time global publish | 29.90160 NEAR, burned |
| break-even | **~10 vaults** |

Break-even lands on ten whatever the contract size, and that is structural
rather than a coincidence: the global publish rate **is** ten times the
per-account rate, so `10·S / S` is always ten.

**"Zero onboarding cost" is still too strong, for a second reason the first
draft did not have.** A vault stakes for its own state (nodes, ledgers,
requests — all per-vault), *and* it needs **free** balance for its agents to
transact at all: measured at **0.100919 NEAR per in-flight 100 TGas call**
(`SPIKE-self-fc-key-2026-10-31.md`). A vault funded at its stake alone cannot
make a payment. Realistically ~0.15–0.25 NEAR per usable vault, not ~0.05.

### Two things the first real run of the measurement script fixed

1. **The CLI form was wrong and would have stopped it at step one.**
   `deploy-as-global use-file <wasm> as-global-hash` takes the signer as its own
   argument; the script used `sign-as "$PARENT"` and near-cli-rs 0.30.1 answers
   `error: unexpected argument 'floatv4.testnet' found`. Consistent with this
   section having been marked UNVERIFIED — the script had never been run.
2. **It could not finish on its own.** It printed the two code hashes and asked
   the operator to re-run the B and D deploys by hand. The hashes are
   sha256-base58 of the wasm, so `scripts/wasm-hash.mjs` now computes them —
   verified by matching the CLI's own report for tiny byte for byte before
   trusting it on padded.

`scripts/measure-global-contract.sh` is the experiment, ready to run. It is
**differential on purpose**, because the V2 claim is not "referencing is cheap"
but "referencing does not scale with code size":

- publishes a 49-byte module and a 5,122-byte one (identical but for a wasm
  custom section, so size is the only variable) as global contracts;
- deploys each normally to one fresh account, and references each from another;
- compares `storage used` across the four.

The control is what makes it readable: the two normal deploys must differ by
the padding, which demonstrates a normal deploy charges per code byte. Then if
the two *referencing* accounts show the same storage, the user's cost is
size-independent and the vault's 273.7 KiB code stake genuinely disappears. If
instead they differ by the padding too, §4's premise is wrong and this section
needs rewriting rather than ticking.

The instrument is 49 bytes rather than the real vault deliberately: a global
deploy of 280,249 bytes at the 10x rate is ~28 NEAR burned, and an action's
cost does not depend on what the code does.

Not yet run here — issuing `DeployGlobalContractAction` was blocked by this
environment's command-approval layer, which could not classify
`near contract deploy-as-global`. Nothing about the protocol or the toolchain
blocks it. Until it runs, treat every onboarding-cost number in this file as
arithmetic from the NEP, not as measurement.

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

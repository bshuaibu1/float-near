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

**MEASURED 2026-11-01 by `scripts/measure-global-burn.sh`.** This used to read
"verified from the NEP", which was the weakest link in a figure that decides a
~30 NEAR expense per release: mainnet's protocol config exposes
`global_contract_host_fns: true` and `storage_amount_per_byte: 1e19` but **no
global-contract rate at all**, so there was nothing to check the NEP against.

Two fresh sizes published on testnet, 258 and 1,282 bytes, differentially — the
subtraction cancels the unknown fixed action cost, which a single deploy cannot
separate from the per-byte rate:

```
  258-byte global: cost 0.025861 NEAR   storage 182 -> 182
 1282-byte global: cost 0.128268 NEAR   storage 182 -> 182
  differential 0.102408 NEAR over 1,024 bytes
  => 100,007,681,299,900,000 yocto/byte  =  10.001x
```

The 0.001 excess is the two transactions' gas fees sitting inside the
differential. **The 10x holds.**

And `storage_usage` grew **0 bytes** across both publishes. That is what
separates a burn from a stake — a stake raises it. So the tokens really are
destroyed, not locked; also previously NEP-sourced, now measured.

**CONFIRMED ON MAINNET, same day**, by `scripts/confirm-global-rate-mainnet.sh`
— the testnet figure was taken at protocol 88 while mainnet runs 86, and ~30
NEAR per release is too much to rest on an assumption that a protocol parameter
matches across versions. One 258-byte publish from `test015.near`:

```
  observed drop   0.025861 NEAR      predicted 0.025800 if 10x, 0.002580 if 1x
  storage_usage   182 -> 182         unchanged => burn, not stake
  VERDICT         10x CONFIRMED on mainnet
```

The prediction was printed **before** the deploy, deliberately: a burn is
irreversible, so there is no second run, and a figure interpreted afterwards can
be talked into agreeing with whatever appeared.

The two chains agree to six decimals — testnet's 258-byte publish also cost
**0.025861** — which is about as direct a demonstration as one gets that this is
one protocol parameter and not two.

So: **publishing the 299,620-byte vault burns 29.962 NEAR, per version**, on the
chain it would actually be published to.

> A trap in reading that single mainnet point, worth recording because the first
> version of the script fell into it. The script printed an "implied rate" of
> `drop / bytes` = 1.0023e20 and scaled it to **30.03 NEAR**. A single
> measurement folds the FIXED action cost into the per-byte rate: at 258 bytes
> the fixed part is 0.000061 of 0.025861, which inflates the rate by 0.23%, and
> multiplying that back over 299,620 bytes becomes a 0.07 NEAR error. Harmless
> in direction — it overstates — and still wrong, and precisely what the
> differential method exists to avoid. **Never scale a single-point rate.**

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

**"Zero onboarding cost" is still too strong**, because a vault stakes for its
own state — nodes, ledgers, requests, all per-vault. Measured 2026-11-01 by
`scripts/measure-vault-state.mjs`, on a live vault by differential (a fresh
flat vault would have cost 3.35 NEAR to deploy and this testnet pool holds ~2.7
NEAR, mostly locked):

| component | bytes | NEAR | notes |
| --- | --- | --- | --- |
| global reference | 214 | 0.00214 | independent of code size |
| flat base: config + prefixes + root node | 2,341 | 0.02341 | |
| each extra node | 192 | 0.00192 | one token limit, no recipients |
| each payment record | 287 | 0.00287 | **reclaimable** via `purge_settled` |

So a flat vault plus 50 payments is **0.169 NEAR**, and plus 100 is **0.313** —
against today's flat `STATE_HEADROOM` of 0.35, which turns out to cover the base
plus ~113 unpurged payments. The 0.35 was chosen for safety and lands close to a
sensible number; what changes is that it is now a number with a derivation.

~~A vault needs free balance for its agents to transact: 0.100919 NEAR per
in-flight 100 TGas call.~~ **Obsolete as of 2026-11-01.** With a bound NEP-611
gas key the vault pays **0.000000** gas — validated on mainnet, where the
agent's gas key burned 0.000925 and the vault's balance moved by exactly its
storage growth and nothing else. The gas now lives in the agent's gas key, which
the user funds per agent (~0.06, withdrawable), so the vault needs **storage
only**. See `docs/SELF-SUBMIT-PATH.md`.

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

The experiment that settled this (since removed; see `scripts/README.md`) was
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

## 7. Can the burn be reduced? Measured 2026-11-01: essentially no.

The burn is linear in bytes — 1e20 yocto each — so 10 KB cut is exactly 1 NEAR
saved per version. `scripts/wasm-sections.mjs` prices the artifact:

```
  code        260,617  87.0%   26.06 NEAR
  data         35,441  11.8%    3.54
  everything else      < 1.2%   0.36
  custom sections:  0 bytes
```

**Zero custom sections**: cargo-near already strips names, debug info and
producer metadata, so there are no free bytes. And the data section's text is
mostly *not ours* — `io::ErrorKind` names in a contract with no filesystem,
serde_json parse errors, digit lookup tables — with our own prose totalling
3,981 bytes (0.40 NEAR). Shortening error messages is not where the money is.

### wasm-opt is already applied, and `-Oz` buys 0.5%

The expectation going in was 5–15%, i.e. 1.5–4.5 NEAR. **Wrong by an order of
magnitude.** Measured with wasm-opt 116 against the shipped artifact:

| variant | bytes | delta | saving |
| --- | --- | --- | --- |
| shipped | 299,620 | — | — |
| `-O` again | 299,523 | −97 (−0.03%) | 0.010 |
| `-Oz` | 298,027 | −1,593 (−0.53%) | **0.159** |
| `-Oz` ×3 | 297,965 | −1,655 | 0.166 |

The `-O` row is the control, and it is what explains the rest: re-running `-O`
moves 97 of 299,620 bytes, so the artifact **had already been through
wasm-opt**. cargo-near runs `wasm-opt -O` as a post-step by default — its
`--no-wasmopt` help text calls it "required for correctness of build on
rustc >= 1.82" — and no build path here disables it. With `opt-level = "z"` and
`lto` on the Rust side too, the size work was done before anyone asked.

0.16 NEAR in exchange for a non-default toolchain step, a new code hash, and a
full re-validation. Not worth it.

### The lever that is NOT the artifact

`overflow-checks = true` contributes the arithmetic panic strings and their
checking code. It is a deliberate safety property of a contract that moves
money. It stays.

What actually controls the cost is **release cadence**, because under
`CodeHash` the burn is per *version*:

| | NEAR |
| --- | --- |
| a 10% size cut, per version | 3.00 |
| `wasm-opt -Oz`, per version | 0.16 |
| **one avoided release** | **29.96** |

One avoided release is worth 188x what `-Oz` saves, and more than a 100% size
reduction could. The burn also amortises across users *and time*: a publish
serves every vault ever created on that hash, and `CodeHash` means none of them
is ever forced off it. 29.96 NEAR is 0.30/user at 100 users and 0.03 at 1,000.

So the plan is: get the artifact right **before** the first publish — the one
moment size work is free of a double burn — then treat each release as a ~30
NEAR line item and batch accordingly.

## Sources

- NEP-591, Global Contracts (status: Final) —
  https://github.com/near/NEPs/blob/master/neps/nep-0591.md
- Measurements: this repo at `099f86e`, `scripts/wasm-imports.mjs`,
  near-sdk 5.29.1 source, and `v4.floatv4.testnet` on testnet, 2026-10-28.

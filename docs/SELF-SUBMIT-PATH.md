# The self-submit path: an agent keyed on the vault

**Status: implemented, unit-tested, sandbox-tested-but-UNRUN, NOT DEPLOYED.**

`request_payment` now resolves the spending node from `env::signer_account_pk()`
when the predecessor is the vault itself. That is what lets an agent hold a key
**on the vault** — a NEP-611 gas key, or a plain function-call key — restricted
to `request_payment`, and submit its own transactions.

## Why

| path | per agent | stranded? | contends for vault NEAR? | relayer? |
| --- | --- | --- | --- | --- |
| agent sub-account | 0.55 NEAR | **yes** — 10.7752 already stuck across 18 agents | no | no |
| virtual agent + relayer | ~0 | no | no | **yes** |
| **self-submit (this)** | a gas-key balance, **withdrawable** | **no** | **no** | **no** |

All four protocol facts this rests on were measured on **mainnet** 2026-10-31
(`SPIKE-gas-keys-2026-10-31.md`): a function-call key whose `receiver_id` is its
own account is accepted; the gas key's own balance pays while the account's does
not move by a yocto; the float is recoverable via `withdraw-from-gas-key`; and
two keys do not contend — 2/2 executed in one block with the account unable to
cover a single reservation.

## The change

```rust
let caller = env::predecessor_account_id();
let node_id = if caller == env::current_account_id() {
    let pk = env::signer_account_pk();
    *self.pubkey_to_node.get(&pk).unwrap_or_else(|| {
        fail(ReasonCode::NotVirtualAgent, "signing key is not bound to a node")
    })
} else {
    *self.account_to_node.get(&caller)
        .unwrap_or_else(|| fail(ReasonCode::NotAgent, "caller is not bound to a node"))
};
```

Four decisions worth the words:

**It is purely additive, and needs no fallback.** `assert_bindable` refuses the
owner and the vault — *"agent must not be the owner or the vault"* — so
`account_to_node` can **never** contain the vault. Before this, a self-submitted
call hit `account_to_node.get(vault)` → `None` → `NOT_AGENT`, unconditionally.
There is no prior behaviour to preserve and nothing this branch can shadow.
Pinned by `the_vault_can_never_be_bound_as_an_agent_account`, so a future change
to `assert_bindable` breaks loudly instead of silently creating two resolutions.

**Nothing internal reaches it.** `request_payment` is called from nowhere inside
the contract: `approve_payment` and `request_payment_signed` both call
`dispatch_payment` directly, and the callbacks are `#[private]`. So the only way
the predecessor can be the vault is a transaction signed by a key on it — which
only a full-access key holder can install. Audited by grep before the code was
written, not after.

**It reuses `pubkey_to_node`, the map `bind_virtual_agent` writes.** A new map on
`Vault` would change its borsh layout and therefore require a migration (project
memory, `vault-state-layout-and-migration`). The capability is identical either
way: this path needs the owner to **both** bind the pubkey **and** install the
key on the vault, and either action alone does nothing. No unprivileged actor
gains anything, so there is no capability delta to pay a migration for.

**The unbound case panics rather than returning BLOCKED**, matching
`request_payment_signed` and for its stated reason: there is no node to
attribute a `blocked` event to.

## Tests

**17 unit tests**, vault suite 136 → **153** (and 151 on the test-clock build).
Covering what was asked: bind, unbound, wrong key, per-tx and daily caps, the
recipient allowlist, freeze (own node and ancestor), pause, the approval gate
holding then releasing, above-caps refused rather than held, unbind closing the
path, cooldown shared with the node, and both paths contending for one parent
pool.

**Three mutations, all caught:**

| mutation | caught by |
| --- | --- |
| refusal code `NotVirtualAgent` → `NotAgent` | 2 tests — the two codes are genuinely distinguishable, which is what the comment claims |
| resolve to a fixed node instead of the lookup | **11 tests** — the per-key resolution is thoroughly load-bearing |
| invert the branch condition | essentially the whole suite |

**10 sandbox tests written, and NOT RUN.** `contracts/integration-tests/tests/self_submit.rs`.
They exist because the unit tier cannot see the thing that matters most here:
`signer_account_pk` in the test VM is whatever `VMContextBuilder` was handed, so
the unit tests prove the contract's logic and prove nothing about whether a real
node will let a key on the vault call `request_payment` at all — the access-key
check, the predecessor and the signer key are protocol-side.

They cannot run here: `near-workspaces` needs a Linux `neard` and its build
script refuses Windows outright —

```
panicked at near-workspaces-0.23.0\build.rs:7:33:
Could not install sandbox: UnsupportedPlatformError("only linux-x86_64, linux-aarch64, and darwin-arm64 are supported")
```

WSL here is a viable Ubuntu 24.04 x86_64 with 888 GB free and working network,
but carries no rust toolchain, and the `rustup` installer was refused by the
permission layer. Ubuntu's apt `rustc` is 1.75 against this repo's pinned
1.99.1, so there is no clean substitute.

**Treat that file as a specification, not as evidence.** To run it:

```bash
bash .demo/wsl-rust-setup.sh      # installs rust in WSL (needs permission)
CARGO_TARGET_DIR=$HOME/float-target cargo test -p integration-tests --test self_submit
```

The file does parse — verified with `rustfmt`, which needs no dependencies — so
the failure mode is unrun, not unbuildable.

## What this changed outside the contract

- **The contract grew 299,016 → 299,620 bytes.** `env::signer_account_pk` is a
  host function this contract had never used, so the env import count went
  **40 → 41**. Both the count and the import's name are now asserted, because a
  bare count would not say *which* import moved.
- **`packages/create-float/res/vault.wasm` was rebuilt**, so it no longer matches
  the bytes deployed on mainnet. The PR body's claim that the two are
  byte-identical was true and is now stale.
- **SKILL.md gained the five entry-point failures** — `NOT_AGENT`,
  `NOT_VIRTUAL_AGENT`, `BAD_AGENT_SIGNATURE`, `NONCE_NOT_FRESH`,
  `AGENT_SIGNATURE_EXPIRED`. All five were undocumented, because the guard that
  checks SKILL.md against the contract scanned `dispatch_payment` only, on the
  reasoning that every refusal comes from a `blocked(..)` inside it. These are
  panics raised by the entry points *before* dispatch, so they fell outside.
  The guard now scans both entry points too, and it found three codes I did not
  know were missing.

## Not done, deliberately

- **No mainnet deploy and no npm publish** — both were excluded.
- **No sub-account recovery work** — excluded, and it is work on the path this
  replaces.
- **No MCP/adapter support.** `vault_pay` still signs as an agent account. A
  self-submitting agent needs a key on the vault and a signer configured as the
  vault, which is a packaging change, not a contract one.

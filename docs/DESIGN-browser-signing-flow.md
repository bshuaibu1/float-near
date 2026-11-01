# Browser signing flow for NEAR Float

## THE DECIDING MEASUREMENT: wallets block `DeployContract` (2026-11-01)

A real wallet was finally asked to sign the direct-creation transaction. Meteor,
testnet:

> **Contract deployment blocked.** This app is trying to put contract code on
> your account, which could give it control of your account. Meteor blocks this
> for apps.

Approve greyed out, no override. Two findings, and the second reverses a
decision made earlier in this document.

**SIZE WAS NEVER THE PROBLEM.** The wallet parsed and rendered the 294 KB
transaction cleanly — amount, From, To, fees, all correct. Every concern about
`max_transaction_size` and wallets choking on large payloads was misplaced.

**ACTION TYPE IS.** `DeployContract` from a dApp is refused by policy — and the
policy is blanket: our deploy targeted a NEW sub-account
(`float.work12.testnet`, shown in the wallet's own To field), not the signer's
account, and it was blocked anyway. Their wording, "on your account", is
imprecise for this case; blocking the action type regardless of receiver is the
conservative and defensible choice on their side.

**So the FACTORY is required after all**, for a better reason than the one it
was designed for. It was built to dodge NEP-591 serialisation risk, then
discarded when parent-init made direct creation possible
(`validate-one-tx-create-testnet.mjs`, 9/9 on chain). The real justification is
this: with a factory the browser signs ONE PLAIN `FunctionCall`, which no wallet
objects to, and the deploy happens inside the contract where no wallet policy
reaches.

Two ways to feed the factory, both browser-compatible:

| | needs the 30 NEAR burn? | cost per vault |
| --- | --- | --- |
| factory holds the code, uses `deploy_contract` | **no** | ~3.37 (each vault stores its own copy) |
| factory uses `use_global_contract` | yes | **~0.13** |

The first unblocks the browser flow today. The second is the cheap end state.
They are not exclusive — the factory can start with one and switch to the other
by changing one call, since `set_code_hash` already exists.

STILL UNKNOWN: whether other wallets apply the same policy. If MyNearWallet
allows `DeployContract`, that is a wallet-specific exception, not a reason to
ship a flow that works in some wallets only.

## STATUS: the contract half is VERIFIED on testnet (2026-11-01)

`scripts/validate-factory-testnet.mjs` — **12/12**:

```
C  the vault ACCOUNT was created by the batch
C  it RUNS the global contract (view_code)   33 bytes, magic 0061736d
C  a keyless global-referencing account costs 132 B = 0.001320
D  a failing batch leaves NO account, and the caller is refunded
     caller spent 0.001331 of a 0.010000 deposit — gas only
E  the DEPLOYED bytes enforce DEPOSIT_TOO_SMALL and PAUSED
```

So the design's load-bearing claim holds: **a contract can issue
`CreateAccount + Transfer + UseGlobalContract + new()` in one batch**, which is
what lets the browser sign a single ordinary `FunctionCall` and avoid the
unanswerable question of whether a given wallet serialises a NEP-591 action.

The run also found a bug no unit test could: see
`[[payable-and-assert-one-yocto-must-pair]]`. Ten tests passed identically
before and after the fix, because the `#[payable]` check lives in the generated
`extern "C"` wrapper that unit tests bypass. Every owner method — including the
kill switch — was unreachable.

Still unverified: the REAL vault behind the factory (the parent-init exemption
and a configured vault coming out), which needs the 299,620-byte artifact
published globally at ~30 NEAR. `REAL_VAULT=1` is the gate.


Reuses the link-session pattern already shipped in the Solana Float
(`~/Documents/New project`), with one structural difference that is not a detail.

## What the Solana version does, and why it needs a backend

Measured by reading the code, not from memory:

| | |
| --- | --- |
| wallet | Phantom via `@phantom/react-sdk`, with Google/Apple embedded options |
| handoff | CLI `POST /v1/link-sessions` → `{token, linkUrl, claimSecret}`, opens `app.usefloat.xyz/link?token=…` |
| callback | **polling**, not a local listener — CLI polls `GET /v1/link-sessions/{token}` every 2s |
| TTL | 15 minutes |
| what is signed | **a message**: `Float link session: ${token}` |
| verification | `nacl.sign.detached.verify` server-side |
| then | the **server provisions** the agent wallet and treasury via Dynamic |
| auth after | `ownerControlKey` bearer token in `localStorage` |

Key files: `float-dashboard/app/link/page.tsx`,
`packages/float-api/src/server.ts` (3229–3390 create/complete, 9876–9929
verify), `packages/agent-wallet-cli/src/index.ts` (683–851).

**The backend is load-bearing there because Solana Float is custodial.** The
signed artifact is a *message* that proves identity; only the server can act on
it, because only the server holds the wallet. Polling an API is the only way the
CLI can learn the outcome.

## Why NEAR Float does not need one

NEAR Float's pitch is the opposite: a vault the user owns, whose owner key never
leaves their wallet. So the browser cannot sign a message — it must sign a
**transaction**. And that inverts the infrastructure question, in our favour:

> The signed artifact's effect is **public on-chain state**. The chain is the
> callback.

So the CLI does not need a server to learn the outcome. It polls the NEAR RPC
for the vault account and checks its `code_hash`. No API, no database, no local
`127.0.0.1` listener, and the signing page can be **fully static**.

That also fixes a failure mode a local listener would have: a coding agent often
runs in a container, a devcontainer, WSL, or on a remote box, where the browser
is not on the same network namespace. A `127.0.0.1` callback breaks there.
Polling the chain works regardless of where either half runs.

### What is reused verbatim

- the link/token/poll **shape**, including a nonce in the URL and a TTL
- polling cadence (~2s) and the CLI spinner UX
- the "here are your addresses, here are your next steps" completion screen

### What changes

| | Solana Float | NEAR Float |
| --- | --- | --- |
| browser signs | a message | **a transaction** |
| who creates the vault | the server (Dynamic) | **the user's own wallet** |
| callback | poll the API | **poll the chain** |
| backend required | yes | **no** |
| stored after | `ownerControlKey` in localStorage | nothing secret — just the vault id |

The token in the URL stops being an auth credential and becomes a *correlation
id*: it ties the browser tab to the CLI invocation for display and idempotency.
It is not a bearer token and does not need to be secret, which removes the
`claimSecret` hashing machinery entirely.

## The transaction

`create-float` already builds this with a local key. The browser version is the
same actions, signed by a wallet instead:

```
signer   alice.near
receiver float.alice.near
actions  CreateAccount
         Transfer(~0.1 NEAR)          <- measured: 0.00214 ref + 0.02341 base + headroom
         UseGlobalContract(codeHash)  <- 0.00214, replaces a 2.996 code stake
         FunctionCall(new, {owner: alice.near, ...})
```

One transaction, one wallet confirmation, and the vault is live with a flat tree
and no agents — which is the default the product wants.

## RESOLVED: the factory is the design, and it is unblocked today

Three checks, all run before choosing:

**1. `near-api-js` 7.4.0 has the actions** —
`node_modules/near-api-js/lib/index.d.ts`:

```ts
declare function useGlobalContract(contractIdentifier:
  { accountId: string } | { codeHash: string | Uint8Array }): Action;
declare function deployGlobalContract(code: Uint8Array,
  deployMode: 'codeHash' | 'accountId'): Action;
```

**2. `near-sdk` 5.29.1 can do it from INSIDE a contract**, which is what a
factory needs — `near-sdk-5.29.1/src/promise.rs:553`:

```rust
/// Uses low-level [`crate::env::promise_batch_action_use_global_contract`]
///     .use_global_contract(code_hash);
```

**3. The host functions are already linked into our wasm.** Read out of the
import section, with positive controls first so that an absence would mean
something:

```
total function imports: 41
  control  panic_utf8 / sha256 / promise_batch_create     PRESENT
  global   ..._deploy_global_contract                     PRESENT
  global   ..._deploy_global_contract_by_account_id       PRESENT
  global   ..._use_global_contract                        PRESENT
  global   ..._use_global_contract_by_account_id          PRESENT
```

> I briefly recorded the opposite and it was wrong. `wasm-imports.mjs` is a pure
> module with no CLI — "no argv, no process.exit, that is the point of the file"
> — so invoking it as `node wasm-imports.mjs <wasm>` prints **nothing**, and my
> `|| echo "(no global imports)"` turned that silence into a negative result I
> then used to contradict this repo's own doc. Zero matches and "the command
> cannot match" are the same output, again. The controls above exist so the next
> reading of this cannot have the same defect.

So a factory contract can be written against the current SDK and toolchain with
no upgrade, and the wallet question below becomes irrelevant to onboarding.

## The question the factory avoids: can a wallet sign `UseGlobalContract`?

Checked, and the answer is "probably, but unprovable from here". From
`near/wallet-selector`, `packages/core/src/lib/wallet/transactions.types.ts`:

```ts
export interface Transaction {
  signerId: string; receiverId: string; actions: Array<Action>;
}
export type Action = NAJAction;   // from "@near-js/transactions"
```

So the public type is an **alias for near-api-js's union** and therefore accepts
`UseGlobalContract`. But the same file also exports an `InternalAction` union of
exactly the eight legacy types — `CreateAccount | DeployContract | FunctionCall
| Transfer | Stake | AddKey | DeleteKey | DeleteAccount` — with no comment
explaining why both exist and no conversion function visible in that file.

Types accepting an action says nothing about a given wallet **serialising** it
at runtime. Meteor, Sender and MyNearWallet each build the transaction
themselves, and an eight-case switch anywhere in that path fails closed. That is
only settled by a real signature attempt against a real wallet.

Which is the argument for the factory: it makes the question moot rather than
answering it.

### The design that does not depend on the answer: a factory

Have the browser sign **one plain `FunctionCall`** — which every wallet has
supported since day one — to a factory contract that does the rest in a promise
batch:

```
signer   alice.near
receiver float.near            (the factory)
action   FunctionCall(create_vault, {label, token, decimals}) + deposit ~0.1 NEAR

factory then batches: CreateAccount(alice.float.near)
                      Transfer
                      UseGlobalContract(codeHash)
                      FunctionCall(new, {owner: predecessor})
```

Three consequences worth stating plainly:

1. **Universal wallet support.** A single `FunctionCall` with a deposit is the
   most boring transaction on NEAR.
2. **Naming changes** from `float.alice.near` to `alice.float.near`, because a
   sub-account can only be created by its parent. `float.alice.near` requires
   `alice.near`'s own key to sign `CreateAccount`; `alice.float.near` requires
   the factory's.
3. **Sovereignty is unaffected.** NEAR parents have **no** authority over
   sub-accounts after creation — no key, no upgrade right, nothing. A
   factory-created vault is exactly as user-owned as a self-created one. This is
   worth being explicit about because "our contract is the parent of your vault"
   sounds like a trust concession and is not one.

It also puts the global-contract `codeHash` in factory config, so pointing new
vaults at a new version is a factory call rather than a client release — while
existing vaults stay on their hash untouched, which is the `CodeHash` property
we chose deliberately.

Cost: a new contract to write, test and audit, and it becomes consensus-critical
for onboarding.

## Owner actions after setup

The same page serves every later owner action, because `OwnerPayload` in
`packages/mcp/src/payloads.ts` is already one-to-one with a `FunctionCall`:

```ts
export interface OwnerPayload {
  receiverId: string; methodName: string; args: Record<string, unknown>;
  gasTgas: number; depositYocto: string;
  summary: string;        // what the human is being asked to approve
  warnings: string[];     // non-empty only when destructive
}
```

So `vault_plan_create_agent`, `vault_plan_set_caps` and the rest already emit
exactly what the page needs. The agent produces a plan, the human signs it in a
wallet, and the agent never holds an owner key. `summary` and `warnings` are
already written for human display — they become the page's confirmation copy.

## Flow

```
agent/CLI                     browser (static page)            NEAR
─────────────────────────────────────────────────────────────────────────────
ask for owner account id
  (public, not a secret)
derive alice.float.near
build intent + nonce
print ONE link ───────────────> /create?owner=…&label=…&token=…&n=…
                                connect wallet
                                show summary + total cost
                                sign ONE FunctionCall ────────> factory batches:
                                                                CreateAccount
                                                                UseGlobalContract
                                                                new()
poll RPC for alice.float.near <──────────────────────────────── account exists,
  until code_hash == pinned                                     code_hash matches
write .float/adapter.env
"vault live, holds 0 USDC,
 nothing can spend until
 you create an agent"
```

The CLI needs the owner's account id up front to know what to poll for. That is
a public identifier the user already knows, so asking for it costs nothing and
removes the entire backend.

## Hosting and domains (decided 2026-11-01)

The Solana Float is being **retired**. `usefloat.xyz` becomes the marketing
page; `app.usefloat.xyz` serves everything else, including the signing page at
`app.usefloat.xyz/create`.

Retirement removes most of the collision risk `deploy-vps.sh` was written
against — but **not yet**. `float-dashboard` / `float-admin` / `float-api` are
live under pm2 out of `/srv/float` until they are actually turned off, so until
then the script's refusal to touch a pm2 process it did not create still earns
its keep. `pm2 restart float-api` would restart the Solana product.

**Serve the page from the VPS; do not make it depend on the VPS.** The signing
page is static, so `app.usefloat.xyz` is a convenience, not a dependency: a user
onboarding during an outage still gets a vault, because the CLI polls the chain
rather than our API. The moment a link-session API sits in that path, every
onboarding inherits our uptime. That is a real guarantee to give away for
convenience we do not need.

## Does any of this need a database? Mostly no.

The question is worth answering precisely, because the Solana version needed a
substantial one and the reason does not carry over.

**Why Solana Float needed a store.** It is custodial. The server provisions the
agent wallet and treasury via Dynamic, so it *must* persist owner records,
control keys, agent-wallet records and policy — there is nowhere else for them
to live. `ownerControlKey` exists because the server, not the user, holds the
authority. Link sessions need storing for the same reason: the signed artifact
is a message only the server can act on.

**None of that is true here.** The vault contract *is* the database:

| state | where it lives | DB needed? |
| --- | --- | --- |
| owner, tree, caps, recipients, thresholds | on-chain, `get_config` / `get_tree` | no |
| today's budget and spend | on-chain, `get_node_budget` | no |
| payment history | on-chain request ledger | no, with a caveat below |
| agent authority | a key bound on the vault | no |
| agent's own key | the user's `.float/adapter.env` | not ours to hold |
| link sessions | not needed — the chain is the callback | no |
| who is logged in | the connected wallet | **no** |

That last row is the one worth dwelling on. **A non-custodial dashboard needs no
login system at all.** Vault state is public, so reads need no auth; and writes
are signed by the user's wallet, so they need no server-side session. No JWT, no
bearer token, no user table, no password reset, no session expiry — none of it,
because we never hold anything on the user's behalf. The `ownerControlKey` in
localStorage has no NEAR equivalent and should not be invented.

### The two things that genuinely want storage

**1. History beyond `purge_settled`.** Measured today: purging 20 requests freed
5,758 bytes, and that storage refund is why an owner would do it. So on-chain
history is deliberately *deletable*, and a dashboard that wants a permanent
ledger needs its own copy.

**2. Cross-vault queries.** The RPC answers "what is in this vault". It cannot
answer "total spend across all vaults this month" without reading each one.

Both are **indexer** problems, not system-of-record problems, and the
distinction decides the architecture:

> Anything we store must be a **derived cache that can be deleted and rebuilt
> from the chain.** The moment a database holds state that is not recoverable
> from on-chain data, we have reintroduced custody — a thing users must trust us
> to keep, and a single point of failure for a product whose pitch is that there
> is none.

Practically: no database for v1. When history or analytics justify one, add a
read-only indexer (Postgres fed by a NEAR indexer or a polling worker), and keep
the rule that deleting it loses nothing but speed.

### The one real gap: finding a user's vault

With the factory, vaults are sub-accounts of `float.near` — and **NEAR has no
RPC to enumerate an account's sub-accounts.** So "show me my vault" needs either
a deterministic name or a registry.

Deterministic is better and costs nothing: `alice.near` →
`alice.float.near`. The dashboard computes it and reads it; no lookup, no index,
no DB. It only breaks if one owner wants several vaults, at which point the
factory can keep a small on-chain `owner -> Vec<vault>` map — on-chain, so it
stays rebuildable and trust-free, and at a measured 192 bytes per map-ish entry
it is immaterial.

## Decisions this needs

1. **Factory or direct multi-action?** Decides the vault naming scheme and
   whether a new contract is in scope. Blocked on verifying wallet-selector's
   action union — that check should happen first because it may decide it for us.
2. **Which wallet library.** `@near-wallet-selector` is the default, but its
   action union is the open question above.
3. **Hosting.** A static page needs no backend, so GitHub Pages or Vercel is
   enough. Worth confirming nothing creeps in that needs state.

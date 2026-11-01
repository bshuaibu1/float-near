# Browser signing flow for NEAR Float

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

## Decisions this needs

1. **Factory or direct multi-action?** Decides the vault naming scheme and
   whether a new contract is in scope. Blocked on verifying wallet-selector's
   action union — that check should happen first because it may decide it for us.
2. **Which wallet library.** `@near-wallet-selector` is the default, but its
   action union is the open question above.
3. **Hosting.** A static page needs no backend, so GitHub Pages or Vercel is
   enough. Worth confirming nothing creeps in that needs state.

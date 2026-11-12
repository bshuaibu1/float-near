<!-- STAMP commit=pending date=2026-11-12 -->
# How Float works — the parts, the boundaries, and what is missing

`STATE.md` says what is true *right now*. `DECISIONS.md` says what was settled and what was
rejected. **This file says how the pieces fit**, so a question like "where does the vault's code
come from?" or "what can an agent key actually do?" has one answer instead of being re-derived
from 290KB of `docs/`.

Written 2026-11-12, late — most of this was learned by tripping over it. `scripts/map-surfaces.mjs`
derives the reachability half of this map from source on every `verify-all` run, so the "what is
missing" section below cannot silently become a lie.

---

## 1. The one idea

**A budget tree an AI agent cannot talk its way out of.**

The owner deploys a vault contract. The agent gets a NEAR key that is restricted *at the protocol
level* — not by a policy check the agent might argue with:

```rust
add_gas_key_allowance_function_call(
    public_key,
    AGENT_GAS_KEY_NONCES,
    Allowance::Unlimited,       // the BALANCE is the cap, not the allowance
    env::current_account_id(),  // receiver: this vault, and nothing else anywhere
    AGENT_ALLOWED_METHOD,       // method:   request_payment, and nothing else
)
```

That pair — **one receiver, one method** — is the entire security story. The agent cannot call the
token contract, cannot raise its own limit, cannot freeze, withdraw, or reach any owner function.
Not "is prevented from"; *cannot name them in a transaction*.

Budgets are **hierarchical**: a payment charges every ancestor, which is why a sibling draining a
shared pool returns `PARENT_DAILY_BUDGET` and not `DAILY_BUDGET`. The node is in the ledger key
(`ledgers: LookupMap<(NodeId, AccountId, u64), DailyLedger>`), which is the thing the incumbent
does not have.

---

## 2. The parts

```
                         ┌──────────────────────────────┐
   the human's wallet ──▶│  web/index.html              │  signs ONE FunctionCall
   (Meteor / Intear)     │  usefloat.xyz                │  → create_vault_with_code
                         └──────────────┬───────────────┘
                                        │ carries the vault wasm as an argument
                                        ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  factory contract        usefloat.near  │  fac.floatv4.testnet          │
  │  11 public methods — derives the vault id, deploys, binds the agent key │
  └─────────────────────────────────┬───────────────────────────────────────┘
                                    │ DeployContract + new() + AddKey, one batch
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  vault contract      <label>.usefloat.near                              │
  │  47 public methods — the budget tree, the ledgers, the ONE payable door │
  └───────▲──────────────────▲─────────────────────▲───────────────────▲────┘
          │                  │                     │                   │
     request_payment    owner methods          view calls          view calls
          │              (1 yocto)                 │                   │
  ┌───────┴──────┐  ┌────────┴────────┐  ┌─────────┴────────┐  ┌───────┴──────┐
  │ @floatonnear │  │ the human's     │  │ @floatonnear/    │  │ create-float │
  │ /mcp  0.8.1  │  │ wallet, again   │  │ float-adapter    │  │ CLIs  0.7.0  │
  │              │  │                 │  │ 0.2.1            │  │              │
  │ the agent    │  │ approves every  │  │ HTTP, read-only  │  │ create-float │
  │ lives here   │  │ vault_plan_*    │  │ + signLink out   │  │ float-agent  │
  │ 27 tools     │  │ payload         │  └────────┬─────────┘  │ float-topup  │
  └──────────────┘  └─────────────────┘           │            │ float-exit   │
                                                  ▼            │ float-retire │
                                         ┌─────────────────┐   └──────────────┘
                                         │ float-dashboard │
                                         │ app.usefloat.xyz│  multi-tenant,
                                         │ (private pkg)   │  routes by ?owner=
                                         └─────────────────┘
```

### What each part is *for*

| Part | Published as | Its job | What it must never do |
|---|---|---|---|
| `contracts/vault` | — (bytes shipped in the CLI package) | The product. Budget tree, ledgers, refusal codes | — |
| `contracts/factory` | deployed, not published | Make a vault from one browser signature | Hold user funds |
| `web/index.html` | `usefloat.xyz` | Onboard a stranger with no CLI | Ask for a key or seed phrase |
| `packages/mcp` | `@floatonnear/mcp` | Where the agent lives. 27 tools | Sign a policy change |
| `packages/create-float` | `@floatonnear/create-float` | Operator CLIs — the jobs a wallet cannot do | Be run on someone's behalf |
| `packages/float-adapter` | `@floatonnear/float-adapter` | Read-only HTTP over a vault | Hold `FLOAT_API_TOKEN` in public |
| `apps/dashboard` | private | Look at a vault in a browser | Resolve to the operator's vault |

---

## 3. The three lanes — the part that matters most

This is the MCP's whole shape, and describing it wrongly to a user is the most likely way to
mislead them:

27 tools, and **exactly one of them signs a transaction against the chain**:

| Lane | Tools | Signs on-chain? | Needs a key? |
|---|---|---|---|
| **READ** | 5 — `vault_tree`, `vault_budget`, `vault_config`, `vault_roles`, `vault_request` | no | no |
| **PAY** | **1** — `vault_pay` | **yes** | the restricted agent key |
| **PLAN** | 14 — every `vault_plan_*` | **no — returns an unsigned payload** | no |
| *(the rest)* | 7 — `vault_create`, `vault_await_create`, `vault_add_role`, `vault_gas`, `vault_history`, `vault_pending_approval`, `vault_teardown_report` | no | no |

The last row is not a fourth lane; it is the tools that are neither a pure view call nor a policy
payload. `vault_create` returns a URL for the human to approve, `vault_add_role` writes only to the
local keyring, the others read and then compute. **None of them signs**, which is the property that
matters.

That property is structural, not a convention to be maintained. Verified 2026-11-12 — the whole
MCP source contains **one** `KeyPairSigner`, in `sign.ts`, reached from **one** call site, and the
method name is not a parameter:

```ts
return account.callFunction({ contractId: a.vault, methodName: ALLOWED_METHOD, … })
```

So a new tool cannot acquire the ability to sign by accident; it would have to import `sign.ts` and
`ALLOWED_METHOD` is still the only method it could name.

**A `vault_plan_*` call is not a change.** It returns a payload the human approves in their own
wallet. An agent reporting "I've set your cap to 50" when it called `vault_plan_set_caps` is
lying, and the server instructions say so explicitly because this is an easy mistake to make.

### Why policy changes cannot be automated away

Two independent reasons, both measured here:

1. **Owner methods take 1 yoctoNEAR** (`assert_one_yocto` + `#[payable]`, which must pair — a
   method with the assert and not the attribute is permanently unreachable, and the factory's kill
   switch was, with 10/10 unit tests green either side).
2. **Wallets ignore `signerId`.** Meteor, Intear and the NEAR CLI connector all *silently sign as
   the connected account* and return success. They do not refuse — they substitute. So any flow
   that needs a signature whose `signer_id` is the vault is a CLI job, permanently.

---

## 4. Where the vault's code comes from — traced 2026-11-12

Worth writing down because the obvious reading of it is wrong.

```
contracts/vault/src          cargo near build (never plain cargo build)
        │
        ▼
packages/create-float/res/vault.wasm        ← the canonical artifact
        │   298,839 bytes, sha256 dc7a3fb6…, b58 Fqep3KLe…
        │   guarded by a provenance digest at `prepack` (see DECISIONS.md 2026-11-07)
        │
        ├──▶ copied to the host, served as usefloat.xyz/vault.wasm   ✅ verified identical
        │
        ▼
the browser fetches ./vault.wasm and passes the BYTES to create_vault_with_code
```

**Verified today:** the live site serves the canonical artifact byte-for-byte. The deployment is
correct.

**But nothing on-chain pins it.** `create_vault_with_code` takes the code as an *argument* and
never consults `self.code_hash`. The factory's `code_hash` is read in exactly one place —
`use_global_contract`, on the `create_vault` path that no client uses. So:

- `get_config` reports `code_hash: E2ys5n3K…` on mainnet and `Dk4ELbJu…` on testnet, and **neither
  is the code any vault actually runs** (`Fqep3KLe…`). It reads like a pin and is not one.
- Correctness today rests on the host serving the right file, with no integrity check in the page
  and no assertion on-chain.

I asserted the opposite earlier in this project — inferred that the factory pinned the build from
reading its config, without tracing the call path. That is the same mistake as the time I claimed
the factory could not create a vault at all. **Reading a config field is not tracing a call path.**

The available hardening is small and the field already exists: hash `code` in
`create_vault_with_code` and compare it to `self.code_hash`. Not done — it needs a factory
redeploy, and it is 2 days to the deadline. Recorded rather than silently left out.

---

## 5. Trust boundaries — what each credential can do

| Credential | Can | Cannot |
|---|---|---|
| **Agent gas key** | `request_payment` on its own vault | Everything else, at the protocol level |
| **Owner full-access key** | Every owner method; signs as the vault | — |
| **Dashboard visitor** | View any vault by account id | Anything — every read is a keyless view call |
| **Adapter** | Read; emit `signLink`s | Sign |

The dashboard asks "whose vault?" for **identity, not authentication** — there is no authority
there to grant. It asks instead of defaulting because falling through to the adapter's configured
vault once showed a mainnet owner the operator's *testnet* demo tree as if it were theirs.

### Money that cannot be recovered

The sharp edges, each paid for once:

- **`DeleteKey` on a funded gas key BURNS the balance and reports success.** 0.08322 NEAR,
  measured, transaction green. `near-sys` has no withdraw host function at any version, so a
  contract can *never* empty its own gas keys. Recovery is `withdrawFromGasKey`, signed by the
  vault — a CLI job, permanently. This is what `float-retire` exists to make the easy path.
- **A function-call key cannot sign `DeleteAccount`.** 11.3 NEAR is stranded forever across 19
  agent accounts. Anything that funds an account an FC key controls is a permanent loss.
- **A gas key's balance sits outside the account's `amount`**, so any UI showing `amount`
  understates the refund. Recoverable = `amount` + Σ(gas keys) + 0.00125.
- **Teardown order is the safety property**: withdraw FTs → `storage_unregister` →
  `purge_settled` → stub → delete. A delete never returns tokens.

---

## 6. What is missing

### Six shipped contract capabilities with no interface

Built, tested, deployed, unreachable. `map-surfaces.mjs` tracks these in `KNOWN_GAPS` so the check
stays green on what is known and fails loudly on anything new:

| Method | Why it matters |
|---|---|
| `propose_owner` + `accept_ownership` | Two-step ownership transfer. `vault_config` already **reports** `pending_owner`, so the product can display a transfer in flight that it gives you no way to start or accept |
| `remove_node` | `vault_plan_add_node` exists and nothing removes one — a budget tree can only ever grow |
| `sweep_stuck_pending` | Recovers stuck in-flight payments. Unreached, so a stuck reservation holds budget until someone runs near-cli by hand |
| `set_max_daily_near` + `get_near_budget` | A NEAR-denominated cap beside the per-token ones, with its read side |

### Gaps that are not contract methods

- **No on-chain pin on the vault build** — §4.
- **No README, no pitch, no demo script.** Deliberately deferred by the user; the deadline is
  2026-11-14 23:59 UTC.
- **`npm publish` pending** for mcp 0.8.1 and create-float 0.7.0 (needs 2FA).
- **`integration-tests` cannot build on Windows** — `near-workspaces` has no Windows sandbox
  binary. A red `cargo check --workspace` here is the environment, not the diff; scope to
  `-p vault -p mock-ft`.

### How this list stays honest

`node scripts/map-surfaces.mjs` enumerates every `pub fn` in both contracts and cross-references
the MCP, the CLIs, the adapter and the page. A method reachable by nothing is either a feature with
no interface or needs an entry in `NOT_A_FEATURE` *with the reason*. 16 are excluded that way —
callbacks, internal helpers, operator-only levers — each with its reason in the script.

It is check 35 of `node scripts/verify-all.mjs`, which is **the gate** (not `npm test`). Every
check there asserts an exit code **and** a must-appear pattern **and** a must-not-appear pattern,
because a check that cannot run prints nothing and exits 0.

The script's own failure message is the principle this file was written to serve:

> Each is a shipped, tested, deployed capability a user cannot use. Either give it an interface, or
> add it to `NOT_A_FEATURE` with the reason it does not need one. "We will get to it" is how
> `float-retire` stayed missing until someone asked how to shut down an agent.

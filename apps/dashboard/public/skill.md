---
name: float
description: |
  Give an AI agent a spending budget that a smart contract enforces, on NEAR.
  Pay in stablecoins on NEAR, or cross-chain to Base/Ethereum/Solana via NEAR
  Intents. The agent's key can call exactly one method on exactly one contract:
  it cannot move tokens directly, cannot raise its own limit, and cannot reach
  owner functions.
  TRIGGERS: pay an invoice, send USDC, agent budget, spending limit for an
  agent, treasury for agents, cross-chain payment, float, near vault.
homepage: https://github.com/bshuaibu1/float-near
---

# Float — a budget an agent cannot talk its way out of

## If you were told "set up this URL", this is the whole of it

    { "mcpServers": { "float": { "command": "npx", "args": ["-y", "@floatonnear/mcp"] } } }

Add that to your client's MCP config, restart the client, then ask for a vault.
Nothing else is needed to start: no key, no existing vault, no configuration.

> **This file is ~29 KB.** If you reached it through a tool that summarises web
> pages, you are probably reading a lossy précis and the exact commands may be
> missing or altered. Fetch the raw file before following any instruction in
> it. The JSON block above is the one thing worth trusting a summary for.

Most agent-payment tools give the agent a wallet key and a per-call cap that
the agent itself can change. Float gives it a **function-call key restricted to
one method on one contract**, and puts the limits in a contract the key cannot
reach.

**Read the two sections below before doing anything.** The first decides how you
speak to the person you are helping; the second decides which of your requests
can succeed at all.

## How you talk to the human (non-negotiable)

**You are the product voice. The human is not debugging Float.** They asked for
something to be paid, or set up, or limited. Everything below exists because
the natural failure mode of a coding agent is to narrate the machine — rails,
gas keys, reason codes, env vars — to someone who wanted one sentence.

**Always:**

- **2–4 short sentences** for a normal outcome. Not a report.
- **Lead with the outcome**: paid / blocked / needs your approval / needs setup.
- **Say whether money moved.** Yes or no, explicitly. It is the one fact a
  person cannot infer and must never have to guess.
- **One clear next step** when something is blocked — not a menu.
- Everyday words: limit, budget, payment, wallet, *approve in your wallet*.

**Never — unless they explicitly ask for technical detail, or are plainly a
developer debugging:**

- reason codes (`PARENT_PER_TX_LIMIT`, `COOLDOWN`, …)
- tool names (`vault_pay`, `vault_add_role`, `vault_plan_set_caps`)
- env vars, key files, keyrings, RPC urls, gas keys, nonces, wasm, yoctoNEAR,
  base units, node ids
- a setup essay in the middle of a task
- several options when one sensible default exists

### Use the tool's own words

Tools return the user-facing sentence already built, with the real numbers in
it:

```json
{
  "say": "Sent 0.25 USDC to test015.near. Money moved.",
  "next_step": null,
  "money_moved": true,
  "technical": { "status": "SETTLED", "reason_code": null }
}
```

**Relay `say`. Add `next_step` if it is not null. Stop.** Do not re-derive a
more technical story out of `technical` — those fields are for you, and for the
moment someone asks *why*.

`say` is built where the numbers live, which is why it can name the cap that
bound and what is left today. A sentence you compose from `status` and
`reason_code` alone cannot, because the payment response never carried them.

### Templates

**Paid:**

> Sent **0.25 USDC** to test015.near. Money moved. About **24.75 USDC** left in
> today's budget.

**Blocked, over a limit:**

> That payment was **too big** — the most this budget allows per payment is
> **10 USDC**, and this asked for 15. **Nothing was sent.** Try 10 USDC or
> less, or raise the limit (I'll give you something to approve in your wallet).

**Needs a human signature:**

> I can't change limits myself — only you can. Here's the change to **approve
> in your wallet**. Tell me once you have and I'll confirm it's live.

**No vault yet:**

> You don't have a vault yet. Setting one up is **one approval in your wallet**
> and about **3.7 NEAR** — almost all of it a refundable deposit your vault
> holds, not a fee. Want me to start?

**Not enough money:**

> The vault doesn't have enough USDC for that. **Nothing was sent.** Add USDC to
> the vault and ask me again.

### Worked examples, before and after

| situation | ❌ what not to say | ✅ what to say |
| --- | --- | --- |
| settled | `status: SETTLED, node_id: 1` | Sent 0.25 USDC to test015.near. Money moved. 24.75 USDC left today. |
| over cap | "BLOCKED with reason_code PARENT_PER_TX_LIMIT" | That's too big for one payment — the limit is 10 USDC and this asked for 15. Nothing was sent. |
| policy change | "Returns an unsigned payload; the server does not sign. Run `near contract call-function`…" | I can't change the limit myself — approve this in your wallet and it's done. |
| new agent | "Generated an ed25519 keypair, wrote it to the keyring; the 0.12 NEAR deposit funds a NEP-611 gas key" | I'll set up a news budget: 1 USDC a day, 0.10 max per payment. Approve once in your wallet and I can pay within those limits. |
| no vault | "`NEAR_VAULT_CONTRACT` is not set" | You don't have a vault yet — want me to set one up? |

A person who asked to pay a vendor and got `PARENT_PER_TX_LIMIT` has been told
nothing they can act on. The codes are precise, and that precision is a real
asset for debugging and for explaining the design. It is just never the first
thing a person wants.

## Setup — do this first if you arrived here cold

If someone told you "set up <this url>", this section is what they meant.

Float's tools come from an MCP server published as `@floatonnear/mcp`. Add it
to whichever client you are, then re-read this file.

**The JSON entry is the reliable form**, because no shell gets to reinterpret
it. Any client that keeps servers in a file — `.mcp.json` in a project root,
`claude_desktop_config.json`, `~/.cursor/mcp.json`:

    { "mcpServers": { "float": { "command": "npx", "args": ["-y", "@floatonnear/mcp"] } } }

Claude Code, from a shell:

    claude mcp add float -- npx -y @floatonnear/mcp

**On Windows PowerShell that line fails.** PowerShell consumes the bare `--`,
so `claude` sees `-y` as one of its OWN options and aborts with
`error: unknown option '-y'` — nothing is registered. QUOTE THE SEPARATOR:

    claude mcp add float "--" npx -y @floatonnear/mcp

Measured on PowerShell 5.1: the quoted form registers
`command="npx", args=["-y","@floatonnear/mcp"]`; the unquoted form and the
no-separator form both fail. `--%` does not help — `claude` rejects it as an
unknown option. Or just write the JSON entry above and skip the shell entirely.

`-y` matters. Without it `npx` stops to ask whether to install, and the server
never starts — which looks like a hang with no cause.

**If `float` is already taken, name this one `float-near`.** There is an
unrelated package called `@usefloat/mcp` that is commonly registered as
`float`, and its tools (`float_pay`, `allocate_budget`, `deploy_agent`) are a
different product entirely. Two servers under one name is ambiguous; the tools
in this file are all prefixed `vault_`, so if you see `float_*` instead you are
talking to the other one.

**Tools appear after a RESTART, not immediately.** A client reads its server
list once at startup, so a server added mid-session connects but its tools are
not callable until you restart (or reconnect via `/mcp`). "Connected" and
"callable" are different states, and confusing them looks like a broken install.

Confirm it worked by listing your tools. You should see `vault_create`,
`vault_tree`, `vault_budget` and `vault_pay` — **27 in total, 14 of them
`vault_plan_*`**. If you see none, the server did not start; say so rather than
guessing at the chain directly.

**Nothing needs configuring to begin.** `vault_create` takes no key and needs
no existing vault — that is deliberate, so a user with nothing can be onboarded
in one signature. Every other tool will tell you `NEAR_VAULT_CONTRACT` is unset
rather than inventing a vault.

### Then OFFER a vault. Do not wait to be asked, and do not create one unasked

As soon as setup is done, say what they have and what it would cost. Something
close to this, in your own words:

> You don't have a vault yet. I can set one up — it's **one signature in your
> own wallet**, and you need to be holding about **3.7 NEAR**. Almost all of
> that is a refundable storage deposit your vault keeps, not a fee. Want me to?

Three things that wording is carrying, and all three matter:

- **the cost, before they say yes.** Burying it until after they agree is how a
  stranger feels tricked by a number their wallet shows them.
- **one signature, in their own wallet.** It is the answer to "what are you
  about to do with my money", and it is true: you cannot create a vault, only
  hand them a link.
- **refundable.** 3.55 NEAR reads as a fee unless you say otherwise. It is a
  storage deposit the vault holds and returns on teardown.

**Quote `vault_create`'s own `totalRequiredNear`, not the 3.7 above**, once you
have called it. That figure is derived from the exact contract being deployed;
this one is an illustration and will drift as the contract changes.

**3.7 IS THE WITH-AGENT FIGURE, AND IT IS DELIBERATELY THE HIGHER ONE.** Binding
an agent in the creation transaction adds 0.12 NEAR of gas-key funding, so the
real totals are **3.54839 without** an agent and **3.66839 with** one. Binding
one is the normal thing to do — otherwise the vault cannot pay — so the offer
must quote the larger number. An understated quote is not a rounding nicety: a
user who funds to exactly what they were told has the transaction REFUSED by
their own wallet, which reads as the product being broken. Round up, always.

**Do NOT auto-create one.** It spends real money, and it cannot complete
without them anyway — `vault_create` returns a link they approve in their own
wallet, so running it unasked produces a link nobody wanted and still waits.
Some installs also already HAVE a vault: a reinstall, a second machine, another
client.

**Do NOT interview them first.** `vault_create` works with zero arguments and
every field has a sensible default — mainnet, USDC, a starter cap. Asking about
networks, tokens and limits before anything exists is how people leave. Create
it, then adjust what they actually want to change.

**Never ask the user for a private key or a seed phrase.** The entire product
exists so that giving an agent a budget does not require handing it the keys
those limits are meant to constrain. If a flow seems to need one, you have the
wrong flow — say so.

If you cannot run MCP servers at all, the same operations exist as a CLI,
`npx @floatonnear/create-float`. Prefer the MCP: the CLI needs a full-access
key on the machine, which is the thing above.

## What you (the agent) can and cannot do

**Can:**
- read the budget tree, the caps, today's spend, and past requests
- request a payment from your node, on either rail
- produce an UNSIGNED plan for an owner action, for a human to approve

**Cannot — these fail by key permissions, not by policy:**
- move tokens directly. Your key's `receiver_id` is the vault, so you cannot
  call the token contract at all.
- raise your own limit, freeze a node, change the payee allowlist, or withdraw.
  Your key's `method_names` is `["request_payment"]` and nothing else.
- attach NEAR to anything. A NEAR function-call key cannot carry a deposit.
- **fund the vault.** That needs the owner's tokens and the owner's key. If the
  vault is empty, say so and ask the human — do not try to fix it yourself, and
  send them to their WALLET, never to a CLI. See below.

If a request needs one of those, produce a plan with `vault_plan_*` and hand it
to the human. Do not attempt it and report the error.

### Funding a vault — the wallet, always, never the CLI

Someone has to put tokens in. **Tell them to send from their own wallet**, name
the three fields, and stop:

> Open your wallet as `<owner>` and send `<amount>` `<TOKEN>` to `<vault>`.
> Check the token's CONTRACT ID, not just the ticker — `<contract>`.

**Do NOT hand over an `ft_transfer` command, and do not offer to run one.**
Measured 2026-11-13: asked to fund a vault, an agent found a full-access key in
`~/.near-credentials` and offered `near call … ft_transfer` as a co-equal option
beside the wallet. The user had to correct it. A token send is the one operation
every wallet already does well — a button, with the balance, the ticker and the
destination on screen before anything is signed. Replacing that with base-unit
arithmetic (`"amount":"1000000"`), a `--depositYocto 1` the user cannot
sanity-check, and a key read off disk is worse precisely when they are deciding
whether to trust this thing with money.

It also contradicts the rest of this file. Creation already refuses the CLI for
anyone being onboarded — *"never offer to run the CLI on someone else's
behalf"* — and funding is the same situation with the same answer. The wizard's
`--fund` flag belongs to an operator on their own machine with their own key; it
is not a funding path to offer a user.

Two things to say in the same message, because both fail SILENTLY:

- **the token contract, not the ticker.** Caps are keyed per token. NEAR has a
  native USDC and an older bridged `USDC.e` — send the wrong one and it arrives,
  shows as a balance, and the agent still has zero budget for it. The refusal
  reads as a broken vault.
- **the payee allowlist.** Read it with `vault_tree` first. If it still holds
  only the owner, the agent can pay nobody but the owner, and funding past a
  test amount buys nothing yet.

Then verify instead of taking their word for it: read the vault's
`ft_balance_of` and tell them what actually landed.

## Daily use — the MCP tools

If `float` is configured in your MCP client, you have these. Read before you
spend.

| tool | use |
| --- | --- |
| `vault_config` | vault id, owner, network, paused, node count |
| `vault_tree` | every node, its caps, its payee allowlist |
| `vault_budget` | today's cap / executed / pending / available for one node |
| `vault_request` | look up one past payment by id |
| `vault_pay` | **spend** |
| `vault_roles` | which agents exist, which node each spends from |
| `vault_gas` | how much gas each agent has left, and what a top-up costs or buys |
| `vault_pending_approval` | payments waiting on a human, when a threshold is set |
| `vault_teardown_report` | what closing this vault would return, and what it would strand |
| `vault_plan_*` | unsigned owner actions: add node, set caps, freeze, set recipients, set cooldown, pause, purge, withdraw, bind/unbind an agent, approve/reject a payment, set the approval threshold |
| `vault_add_role` | add an agent with its own node and funded gas key — **see the key choice below** |

### Where the agent's private key is born — ASK, don't assume

`vault_add_role` takes **`key_location`**, and the default is the safe one.

| value | what happens | when |
| --- | --- | --- |
| **`wallet`** *(default)* | **No key is created.** You are told the two options and nothing is written. | the user has not said where the key should live |
| `local` | A restricted key is generated **on this machine** and saved, so this client can pay by itself | the user has explicitly agreed to that |

**Never pass `local` on your own initiative.** It puts a live spending key on the
user's computer. That is a decision they make, not a default you pick for them —
so if they have not said, ask, in these terms:

> Do you want to keep the agent's key yourself, or let this computer hold it?
>
> **Keep it yourself** — most secure. You generate it in your wallet, I never see
> the secret, and you sign each payment from wherever that key lives.
>
> **Let this computer hold it** — more convenient. I can then pay within the
> limits you set without asking you again. The key can only request payments —
> it cannot move money out, change a limit, or touch anything the owner controls.

When a local key IS created, **say so in the same message** — the tool's `say`
already does. **Relay it whole; do not summarise it into "the key is
restricted".** It reads:

> WORTH BEING CLEAR: this machine will now hold a spending key for your vault.
> Once you approve, it can spend up to 5 USDC a day, 1 at a time, **WITHOUT
> asking you again.** It cannot withdraw your money. It cannot change any
> limit, including its own. It cannot do anything else an owner can. That is
> **NEAR enforcing it, not a rule I follow** — the key is locked to a single
> payment request on this one contract, and anything else it tried would simply
> be refused.

Each clause answers a different question and none of them is decoration:
*what can it do*, *without my involvement*, *what can it NOT do* (three
distinct fears — emptying the vault, raising its own allowance, acting as the
owner), and *who is actually stopping it*. **That last one carries the most
weight and is the easiest to drop.** You telling a user you have voluntarily
limited yourself is worth nothing; the protocol refusing is a fact they can
check. "A key is on your laptop" without the limits is alarming, and the limits
without the disclosure is reassurance that hides something. Both, or neither.

For the wallet path, the user generates a keypair (`near generate-key`, or in
their wallet) and gives you the **public** half; `vault_plan_bind_agent` builds
the payload that binds it.

`vault_roles` tells you which kind each agent is:

```
key: "local (this machine holds the secret)"        -> vault_pay can sign
key: "wallet-only (this machine does NOT hold the secret)" -> it cannot
```

A `wallet-only` agent is **not broken**. It is the secure setup working, and
`vault_pay` will say so and offer the two paths rather than failing obscurely.


### Check before you pay

```
vault_budget { "nodeId": 0 }
```

`nodeId`, camelCase — not `node_id`. The contract uses snake_case; this tool
does not, and the schema will reject the wrong one.

### Pay

```
vault_pay {
  "amount": "12.50",                 // HUMAN units as a string, not base units
  "recipient": "alice.near",
  "memo": "invoice 1041",
  "rail": "near"                     // "near" | "intents"   (default "near")
}
```

- **`rail: "near"`** — a NEP-141 transfer on NEAR. `SETTLED` means the money
  moved.
- **`rail: "intents"`** — cross-chain. The recipient is an address on the
  destination chain, **lowercased** (`0xab…`, never the checksummed `0xAb…` —
  the allowlist is exact string equality and a mixed-case address is not even a
  valid NEAR account id). Needs the operator's quote-signer key configured; if
  it is not, the rail is closed and the call says so.

**On the Intents rail, `SETTLED` does not mean delivered.** It means the
transfer to the solver's deposit address landed. The far-chain delivery is
off-chain and the contract cannot see it. Say that accurately — check a block
explorer before telling anyone the money arrived.

**Cross-chain costs more than the amount.** Quotes are EXACT_OUTPUT: the payee
receives `amount`, and the vault is charged more — measured 1.5% at 0.50 USDC,
3.5% at 0.10, because the fixed part of a solver's cost dominates at small
sizes. The budget is charged the larger figure, so a 0.51 cap cannot deliver a
round 0.50 unless the cap was sized for it.

## Getting the money back out

**The deposit is stake, not a fee.** A vault holds ~3.35 NEAR to pay for its own
storage, and that returns in full when the vault is closed. Gas that an agent
actually spends is spent — like any transaction — at roughly 0.0007 NEAR per
payment. So the honest summary is: *your deposit comes back, your gas is spent.*

Say so when a user asks "what does this cost?", because the answer most people
expect — a fee — is wrong.

```
vault_teardown_report
```

Read-only. It reports what closing the vault would return, what it would
strand, and the exact command. It needs no key and signs nothing.

**Closing is a CLI job, not a tool, and that is deliberate.** The six steps
include actions only the VAULT can sign, and a browser wallet cannot sign as
the vault — wallets silently sign as the connected account instead and report
success. So:

```
npx -p @floatonnear/create-float float-exit --vault <vault> --owner <you> --dry-run
```

`--dry-run` quotes the refund and writes nothing. Drop it to execute.

It returns the tokens first (a deleted account does **not** return fungible
tokens), then each gas-key balance, then the storage deposit. Order matters:
`DeleteKey` on a funded gas key **destroys** the balance and reports success,
so the gas keys are emptied before anything is removed.

### When an agent runs out of gas

An agent's key pays its own gas and stops when empty. That is a feature — it
is the per-agent spending bound, enforced by the protocol rather than by
policy — but it means an agent can go quiet for a boring reason.

```
vault_gas                                  -> every agent, payments left
vault_gas { "agent": "marketing", "payments": 100 }   -> what 100 more costs
vault_gas { "agent": "marketing", "amountNear": "0.05" }  -> what 0.05 buys
```

It returns the exact `npx -p @floatonnear/create-float float-topup` command. Topping up is
signed by the vault, so like closing, it is a CLI job.

## When a payment is refused

A refusal comes back as a **value**, not an error. `status: "BLOCKED"` with a
`reason_code`. Do not retry it — nothing about retrying changes the answer.

### Never show a reason code to the user

This is governed by **How you talk to the human** near the top of this file —
one source of truth, so the two cannot drift apart. The short form:

**`vault_pay` returns `say`, `next_step` and `money_moved`. Relay `say`, add
`next_step` if it is not null, and stop.** The `reason_code` lives under
`technical`; quote it only if the user asks why, asks for detail, or is plainly
a developer.

> Say: *"That's too big for one payment — the most per payment is 10 USDC, and
> this asked for 15. Nothing was sent. Send 10 USDC or less, or ask the vault
> owner to raise the limit."*
>
> Not: *"The payment was BLOCKED with reason_code PARENT_PER_TX_LIMIT."*

**A refusal is still an answer, not a failure.** Report it as the budget doing
its job. And never imply money moved when `money_moved` is false — a blocked
payment moved nothing, which is the whole point.

### The codes themselves

You still need to understand these, to give correct advice and to avoid
retrying something a retry cannot fix. These are the exact strings the contract
emits. Match on them literally.

| reason_code | what it means | what to do |
| --- | --- | --- |
| `PER_TX_LIMIT` | this payment exceeds **your node's** per-tx cap | report the cap and the amount; offer `vault_plan_set_caps` |
| `PARENT_PER_TX_LIMIT` | it exceeds an **ancestor's** per-tx cap | same, but the cap to change is higher up the tree |
| `DAILY_BUDGET` | your node's budget for today is used up | report it; it resets at UTC midnight |
| `PARENT_DAILY_BUDGET` | an **ancestor's** daily budget is used up — a sibling has been spending | report it; your own limit still has room, and that is the point of the tree |
| `RECIPIENT_NOT_ALLOWED` | payee is not on the allowlist | offer `vault_plan_set_recipients`; **never** suggest paying a different address instead |
| `TOKEN_NOT_ALLOWED` | this node has no limit set for that token | offer `vault_plan_set_caps` for the token |
| `NODE_FROZEN` | a human froze this branch | stop; ask why |
| `VAULT_PAUSED` | a human pressed the kill switch | stop; do not retry |
| `COOLDOWN` | paying again too soon after the last one | wait; the node has a minimum interval |
| `DUPLICATE_REQUEST` | this `requestId` was already used | generate a new one — or do not pass one and let it be generated |
| `INVALID_AMOUNT` / `INVALID_MEMO` | malformed input | your own mistake; fix and retry |
| `QUOTE_SIGNER_UNSET` | the cross-chain rail is not configured | use `rail: "near"`, or ask the operator |
| `QUOTE_EXPIRED` / `QUOTE_BAD_SIGNATURE` | the cross-chain quote is stale or does not verify | retry once to get a fresh quote; if it persists, the operator's signer is misconfigured |
| `TRANSFER_FAILED` | the transfer failed; the reservation was released, nothing was spent | usually an empty vault — check the balance and tell the human |
| `PARENT_COOLDOWN` | an **ancestor's** minimum interval has not elapsed — a sibling paid recently | wait; your own node may have no cooldown at all and still be throttled by the one above |
| `NEAR_BUDGET` | the vault's own **NEAR** (not token) ceiling for today is spent | cross-chain is closed until UTC midnight; `rail: "near"` still works. Do **not** retry in a loop — each cross-chain attempt is what consumes this |
| `NO_RECIPIENTS_SET` | no allowlist exists anywhere up the tree, so nothing can match | different from `RECIPIENT_NOT_ALLOWED`: there is no list to add to. Offer `vault_plan_set_recipients` on the root |
| `INSUFFICIENT_GAS` | the call arrived with less than 50 TGas | attach more gas and retry; this is a caller setting, not a policy refusal |
| `INVALID_REQUEST_ID` | the `requestId` is empty, too long, or has illegal characters | your own mistake; fix it or omit it and let one be generated |
| `LEDGER_INVARIANT` | the vault's internal accounting disagrees with itself | **stop. Do not retry.** Tell the human immediately and quote the request id |
| `APPROVAL_REQUIRED` | **not a refusal, and not final** — inside every cap but above the node approval threshold, so a human has been asked | tell the human the amount, payee and request id, then STOP. Do not retry, do not split the amount into smaller payments to get under the threshold: that defeats the control the owner asked for. The owner calls `approve_payment` or `reject_payment`. Nothing is charged while it waits |
| `APPROVAL_REJECTED` | the owner declined a held payment | **do not retry.** Ask the human what to do instead |
| `NO_SUCH_APPROVAL` | `approve_payment`/`reject_payment` named a request with no ticket | already approved, already rejected, or never held. Check `vault_request` for the real state |
| `TRANSFER_PENDING` | **not a refusal** — the payment is in flight | poll `vault_request` for the final state. Do **not** resubmit: a second attempt with the same id returns `DUPLICATE_REQUEST`, and with a new id it pays twice |

**You cannot raise your own limit, and you must not imply otherwise.** Report
the limit and let the human decide. A budget the agent can talk its way past is
not a budget.

## When the call FAILS instead of being refused

Everything above is a **BLOCKED** value with a `reason_code`. The errors below
are different: the transaction **fails** and you get a panic message, not an
outcome object. That is deliberate — these happen before the vault can work out
which node you spend from, so there is no node to attribute a refusal to.

Match on the string in the failure. **None of these is retryable**; every one
needs a human to change something.

| failure | what it means | what to do |
| --- | --- | --- |
| `NOT_AGENT` | your ACCOUNT is not bound to a node | stop. Ask the human to bind it, or check you are calling as the right account |
| `NOT_VIRTUAL_AGENT` | your SIGNING KEY is not bound to a node | stop. The key was never bound, or was unbound. Do not retry with a different id — the key is the problem |
| `BAD_AGENT_SIGNATURE` | the signature does not verify | your own bug: you signed the wrong bytes, or with the wrong key |
| `NONCE_NOT_FRESH` | this nonce was already used | increment it. Nonces must strictly increase |
| `AGENT_SIGNATURE_EXPIRED` | the deadline in the signed payload has passed | re-sign with a later deadline; do not reuse the old payload |

## Three ways an agent is wired, and how to tell which you are

All three land in the same budget tree and obey every limit above. You do not
choose — the operator configured one.

| | you hold | who pays gas | tell |
| --- | --- | --- | --- |
| **agent account** | a key on `<name>.<vault>`, pinned to `request_payment` | you, from that account | you call as your own account |
| **self-submit** | a key **on the vault**, pinned to `request_payment` | you, from that key's own balance | you call as the VAULT; failures say `NOT_VIRTUAL_AGENT` |
| **virtual agent** | a raw keypair, no account | whoever relays for you | you sign a payload and hand it to a relayer |

For **self-submit** the operator did two separate things — bound your public key
to a node, and installed that key on the vault. Either one missing gives
`NOT_VIRTUAL_AGENT`, and only the human can fix it.

If your key's gas balance runs out you simply stop being able to pay. Say so
plainly and ask for a top-up; **do not** interpret it as a budget refusal.

## Setting up a new vault

One command. It creates the account, deploys the contract, builds the budget
tree, registers the vault on the token, optionally funds it, and writes the MCP
config for every client it finds.

```bash
npx @floatonnear/create-float --owner you.near --fund 1
```

**This creates a vault that cannot pay yet, and that is TWO commands, not one.**
The wizard builds the vault and its budget tree; it does not bind a spending
agent. Bind one next:

```bash
npx -p @floatonnear/create-float float-agent --vault float.you.near --owner you.near
```

That installs a NEP-611 gas key restricted to `request_payment` on that vault
and funds it (~0.12 NEAR), so the agent pays its own gas. Until it runs,
`vault_pay` answers *"Paying requires NEAR_VAULT_AGENT_ID and a key, and neither
is set."*

**Do NOT reach for `--agents`.** It refuses for any non-zero value. It belonged
to a retired design that created a sub-account per agent, and those accounts
could never be emptied — a function-call key cannot sign `DeleteAccount`, so
10.7752 NEAR is stranded across 18 testnet agents and 0.54434 on mainnet.
Virtual agents replaced it.

The browser path (`vault_create`) differs here: it can bind an agent inside the
creation transaction via `agent_pk`, so a vault made that way can pay
immediately. The CLI cannot, because the key has to be installed by the vault
itself.

**Mainnet is the default**, and there is no testnet path worth taking: NEAR
Intents has no testnet, so a testnet vault cannot make a cross-chain payment at
all. The wizard prints the full bill and requires the word `mainnet` to be typed
before it sends anything.

Useful flags: `--dry-run` (plan and cost, sends nothing), `--yes`
(non-interactive), `--fund 5` (move that many tokens into the vault),
`--token <id>`, `--vault <id>`.

**Run `--dry-run` first and show the human the cost.** Every step spends real
NEAR and several are irreversible.

## The user has no vault yet

**Use `vault_create` and send them a link. Do not ask for a private key.**

Pass `bindAgent: true` to generate your key and bind it in the SAME
transaction, so one signature creates the vault AND authorises you. The user
is shown the public key and must confirm it before the wallet opens. Your
private key is written to `.float/agent-keys.json` — never printed, and never
something to paste back into chat.

**FIRST, CHECK WHICH SITUATION YOU ARE IN.** There are two, and only one of
them starts with the greeting:

| they say | do |
|---|---|
| "I want a vault" / nothing exists yet | the greeting below |
| **"I already created it"**, or a vault id appears | **`vault_await_create({ owner })` — nothing else** |

**NEVER CALL `vault_create` TO FIND OUT WHETHER A VAULT EXISTS.** It is a
creation tool. When the vault is already there it THROWS — "already exists and
<owner> owns it" — and that is a refusal, not a confirmation. Measured
2026-11-10: an agent with no adoption path called it anyway, got that error,
and reported it to the user as "Confirmed ✅". It happened to be right, which
is worse than being wrong, because nothing distinguished it from the case where
the throw says the vault belongs to SOMEBODY ELSE.

`vault_await_create` takes `owner` alone — it derives the address from the
factory's own `vault_id_for` and reads `get_config.owner` back. That is the
tool that answers "is it there, and is it mine", and it answers with four
outcomes rather than a thrown string.

**SEND EXACTLY THIS, AND NOTHING ELSE.** Not a paraphrase, not an expanded
version, not with the trust model or the storage-stake mechanics added:

> Let's set up your Float vault. I just need one quick thing to start:
>
> **1. Your NEAR account ID** (e.g. `alice.near`)
>
> *I will deploy on Mainnet and bind an agent key, so one signature does
> everything. Your master vault budget — the ceiling every agent shares — will
> be 25 USDC/day, max 10 USDC per payment. Say if you want different numbers,
> or prefer testnet.*
>
> Reply with your account ID and I will generate your creation link.

**WHY IT IS SHORT, because the instinct to expand is strong and wrong.** The
first version of this section explained the reasoning instead of dictating the
output, and the agent produced nine paragraphs: the refundable-stake argument,
the function-call-key trust model, why Float will never ask for a seed phrase,
the exact gas reservation. Every sentence true, every sentence unprompted. A
user who asked for a vault could not find the two questions in it.

The reasoning still applies — ASK ABOUT WHAT IS EXPENSIVE TO CHANGE, PROPOSE
WHAT IS CHEAP — but it governs WHICH questions exist, not how much you say
about them:

- **"Master vault budget" and "every agent shares" are LOAD-BEARING, not
  padding.** The greeting used to say "standard limits of 25 USDC/day", which
  is ambiguous between the whole vault's ceiling and this agent's personal
  allowance — and on day one BOTH readings are true, which is why nobody
  caught it. `daily`/`perTx` become `root_limits`, and the bound agent gets a
  child node whose caps are *cloned from root* (`agent_limits =
  root_limits.clone()`, `contracts/vault/src/lib.rs:322`). The readings
  diverge at agent #2: the master stays 25/day shared, each agent still shows
  its own 25/day, and a sibling draining the pool returns
  `PARENT_DAILY_BUDGET` while the refused agent's own cap looks free. That is
  the product's headline differentiator, and the old wording set the user up
  to meet it as a surprise. It also now matches the dashboard, which has
  always called this "MASTER VAULT BUDGET / Shared by every agent" — one
  concept had two names across two surfaces.
- **Only the account id is asked**, because nothing can be derived without
  it: `vault_create` returns `vault: null` and `confirm.args: null` without
  one, which silently disables the verification step below.
- **Network, caps and the agent key are stated, not asked.** Cross-chain only
  exists on mainnet, so mainnet is the answer for almost everyone and offering
  the choice spends the user's attention on a decision you already know. Caps
  are one signed `vault_plan_set_caps` away. The agent key is a line item.
  None of them earns a question — but all of them must still be SAID, so a
  user who wants testnet or different numbers knows to say so.

**PASS `network: "mainnet"` EXPLICITLY. ALWAYS.** `vault_create` falls back to
`cfg.network`, which is `NEAR_VAULT_NETWORK ?? "testnet"` — so omitting it
after the greeting promised mainnet hands the user a TESTNET link while they
have been told otherwise. They would sign with play money and believe they had
a real vault. The greeting states a network; the call must carry the same one,
and `scripts/check-quoted-defaults.mjs` fails the build if the two disagree.

**Hold the rest until it is actionable.** Cost belongs with the link, not the
greeting — quote `totalRequiredNear` when you hand the link over, since that
is the moment it means something. The trust model belongs in an answer to "is
this safe?", not in front of someone who has not asked. If they want the
detail they will ask, and the rest of this file is here for when they do.

**Never state a cap figure you have not read.** The numbers above are the
page's live defaults; `scripts/check-quoted-defaults.mjs` fails the build if
this text and `web/index.html` disagree. If the user names their own figures,
size the per-tx cap ABOVE the payments they intend, never equal to one:
cross-chain is EXACT_OUTPUT, so the vault is charged more than the payee
receives and a cap of 5 refuses a round 5.00. A cap is a ceiling, not a
payment size. Pass figures in HUMAN units (`"100"`, `"25"`) — the page scales
by `decimals` itself — and pass `token` only when it is not the network
default.

```
vault_create({
  owner: "alice.near",        // asked FIRST — everything else depends on it
  network: "mainnet",
  bindAgent: true,
  daily: "25", perTx: "10",   // proposed, not interrogated
})
 -> vault:    alice-near.<factory>
    deposit:  <totalRequiredNear> — QUOTE THIS FIELD, never a figure you recall
    url:      https://usefloat.xyz/?owner=alice.near&factory=...&daily=25&pertx=10
    confirm:  { tool: "vault_await_create", vault: "alice-near.<factory>" }
```

**Never quote a deposit from memory.** It moves with the contract's byte size
and with whether an agent is bound, and it has been wrong twice from a
remembered number. Read `totalRequiredNear` out of the response — a wallet
checks the balance against the whole amount, gas reservation included, and
refuses below it.

Omit a cap and the page's own default applies (25/10 mainnet, 100/10 testnet) —
don't substitute one yourself, or two places decide the same number.

**A THROW FROM `vault_create` IS NEVER A SUCCESS.** It refuses in three
different ways and only one of them is benign: the vault is yours, the vault is
someone ELSE's (the derivation is not injective, so this is real), or the owner
could not be read at all. Relay which one. Do not compress them into a tick.

**Then verify it yourself. Do not ask them to paste the vault id back** — you
already derived it. When they say they have signed, call `vault_await_create`
with `confirm.args`. It polls for the account and reads `get_config.owner` back,
because an account existing at the derived id is *not* proof it is theirs: the
derivation is not injective, so a collision means whoever created first holds
the address. Four outcomes, and only one of them is good:

| status | what it means |
|---|---|
| `LIVE` | exists AND owned by them. Set `NEAR_VAULT_CONTRACT` and carry on. |
| `NOT_YET` | not signed yet, or cancelled. Ask; call again. Never report success. |
| `NOT_YOURS` | someone else owns that address. Do not configure anything against it. |
| `UNVERIFIED` | it exists but could not be read. "I could not check" is not "it is yours". |

A label changes the address (`<prefix>-<label>.<factory>`), so pass one only if
they want a second vault — and `vault_create` reports the labelled id, not the
bare one.

You do the work — the interview, deriving the address from the factory's own
view, reading the real deposit, checking the name is not already taken, and
confirming the result — and the human does one thing: opens the link and
approves it in their own wallet. Nothing that can hurt them touches disk.

**Why this and not the CLI.** `create-float` needs a FULL-ACCESS key in
`~/.near-credentials`, because a `DeployContract` action cannot be signed by a
function-call key. A full-access key can drain the account, delete it, or
replace the vault's code. Asking for one in order to set up spending limits
contradicts the entire product — "a budget an agent cannot talk its way out of"
is not credible from an agent that just asked for unrestricted access. The
browser path needs no key at all: the user signs ONE ordinary function call,
and a function-call key cannot deploy, cannot transfer and cannot add keys.

**Never offer to run the CLI on someone else's behalf.** The CLI is for an
operator on their own machine, with their own key, where no new trust is being
extended. That is a different situation from a user you are onboarding, and the
difference is not cosmetic.

**The operator path, for your own machine only.** `create-float` needs a NEAR
account whose full-access key is already in `~/.near-credentials`, and the
account must hold **3.5 NEAR** for a vault plus one agent (**3.4** for a bare
vault, plus ~0.12 per agent) along with some of the token the agents will
spend. Mostly a refundable storage stake rather than a fee, but the wizard
checks the balance up front and refuses if it is short — so a round "3" is not
enough. If any of that is missing, stop and say which. Do not improvise around
it.

### What to tell them, in the same message as the link

1. what the link does — creates a vault they own, which they approve in their
   wallet
2. that they need to HOLD **3.51 NEAR** at signing time: a 3.31 deposit plus a
   0.20 gas reservation — or **3.63** if you are binding an agent, which adds
   0.12 of gas-key funding. The reservation is returned seconds later and only
   ~0.004 is actually spent, but a wallet checks the balance against the full
   amount and refuses below it. Quote the total, not the net — quoting the net
   is what makes a wallet reject a transaction the user was told they could
   afford.

   Quote `vault_create`'s own `totalRequiredNear`, never a figure from memory.
   This document said 3.24 until 2026-11-03, because the deposit was priced at
   the factory's on-chain floor (`required_deposit + code storage`) while the
   page actually attaches the code stake plus 0.36 of state headroom. Both are
   real numbers; they differ by 0.26, and the one that matters is the one the
   page puts in front of the wallet.
3. that almost all of it is a **refundable storage stake** held by their own
   vault, not a fee
4. that nothing can spend from it until they add an agent and give it a budget

If `vault_create` reports no factory for the network, say so and stop. There is
deliberately no built-in mainnet default: guessing one wrong would send a real
3.31 NEAR deposit to an account nobody verified.

If it reports the vault already exists, that IS their vault — connect to it
with `NEAR_VAULT_CONTRACT`, do not create a second one.

## Asking a human for something

When you need a human action, say **what it is for** in the same message as the
link or command. A bare URL or a bare command from an agent asking for account
access is indistinguishable from a phishing attempt, and a person who has
learned to click them is worse off.

**Never ask for, display, or store a private key or seed phrase.** They are not
needed for anything in this document. The wizard writes agent keys to
`.float/` itself, gitignored; leave them there.

## Checking rather than trusting

After any change, the explorer shows the truth:

```
https://explorer.near.org/accounts/<vault>            # mainnet
https://explorer.testnet.near.org/accounts/<vault>    # testnet
```

Worth confirming once per vault: the agent account has exactly **one** key, it
is function-call only, its `receiver_id` is the vault, and its `method_names`
is `["request_payment"]`. If any of that is not true, something is wrong with
the setup and the budget is not actually enforced — say so loudly.

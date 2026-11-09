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

Most agent-payment tools give the agent a wallet key and a per-call cap that
the agent itself can change. Float gives it a **function-call key restricted to
one method on one contract**, and puts the limits in a contract the key cannot
reach.

Read the next section before doing anything. It is the part that decides which
of your requests can succeed.

## Setup — do this first if you arrived here cold

If someone told you "set up <this url>", this section is what they meant.

Float's tools come from an MCP server published as `@floatonnear/mcp`. Add it
to whichever client you are, then re-read this file.

Claude Code:

    claude mcp add float -- npx -y @floatonnear/mcp

Any client that keeps servers in a JSON file — `.mcp.json` in a project root,
`claude_desktop_config.json`, `~/.cursor/mcp.json` — add this entry:

    { "mcpServers": { "float": { "command": "npx", "args": ["-y", "@floatonnear/mcp"] } } }

`-y` matters. Without it `npx` stops to ask whether to install, and the server
never starts — which looks like a hang with no cause.

Confirm it worked by listing your tools. You should see `vault_create`,
`vault_tree`, `vault_budget` and `vault_pay`, around twenty-three in total. If
you see none, the server did not start; say so rather than guessing at the
chain directly.

**Nothing needs configuring to begin.** `vault_create` takes no key and needs
no existing vault — that is deliberate, so a user with nothing can be onboarded
in one signature. Every other tool will tell you `NEAR_VAULT_CONTRACT` is unset
rather than inventing a vault.

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
  vault is empty, say so and ask the human — do not try to fix it yourself.

If a request needs one of those, produce a plan with `vault_plan_*` and hand it
to the human. Do not attempt it and report the error.

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
| `vault_add_role` | add an agent with its own node and funded gas key |

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
npx @floatonnear/float-exit --vault <vault> --owner <you> --dry-run
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

It returns the exact `npx @floatonnear/float-topup` command. Topping up is
signed by the vault, so like closing, it is a CLI job.

## When a payment is refused

A refusal comes back as a **value**, not an error. `status: "BLOCKED"` with a
`reason_code`. Do not retry it — nothing about retrying changes the answer.

These are the exact strings the contract emits. Match on them literally.

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
npx @floatonnear/create-float --owner you.near --agents 1 --fund 1
```

**`--agents` is not optional in practice.** No agent is created without it, and a
vault with no agent cannot pay — the MCP server will answer *"Paying requires
NEAR_VAULT_AGENT_ID and a key, and neither is set."*

**Mainnet is the default**, and there is no testnet path worth taking: NEAR
Intents has no testnet, so a testnet vault cannot make a cross-chain payment at
all. The wizard prints the full bill and requires the word `mainnet` to be typed
before it sends anything.

Useful flags: `--dry-run` (plan and cost, sends nothing), `--yes`
(non-interactive), `--fund 5` (move that many tokens into the vault),
`--agents 2`, `--token <id>`, `--vault <id>`.

**Run `--dry-run` first and show the human the cost.** Every step spends real
NEAR and several are irreversible.

## The user has no vault yet

**Use `vault_create` and send them a link. Do not ask for a private key.**

Pass `bindAgent: true` to generate your key and bind it in the SAME
transaction, so one signature creates the vault AND authorises you. The user
is shown the public key and must confirm it before the wallet opens. Your
private key is written to `.float/agent-keys.json` — never printed, and never
something to paste back into chat.

```
vault_create({ owner: "alice.near" })
 -> vault:    alice-near.<factory>
    deposit:  3.30679 NEAR + 0.20000 gas reservation
    url:      https://app.usefloat.xyz/?owner=alice.near&factory=...
```

You do the work — deriving the address from the factory's own view, reading the
real deposit, checking the name is not already taken — and the human does one
thing: opens the link and approves it in their own wallet. Nothing that can
hurt them touches disk.

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

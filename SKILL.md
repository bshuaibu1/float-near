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
| `vault_plan_*` | unsigned owner actions: add node, set caps, freeze, set recipients, set cooldown, pause, purge, create agent |

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

## Setting up a new vault

One command. It creates the account, deploys the contract, builds the budget
tree, registers the vault on the token, optionally funds it, and writes the MCP
config for every client it finds.

```bash
npx @floatonnear/create-float --owner you.near --fund 1
```

**Mainnet is the default**, and there is no testnet path worth taking: NEAR
Intents has no testnet, so a testnet vault cannot make a cross-chain payment at
all. The wizard prints the full bill and requires the word `mainnet` to be typed
before it sends anything.

Useful flags: `--dry-run` (plan and cost, sends nothing), `--yes`
(non-interactive), `--fund 5` (move that many tokens into the vault),
`--agents 2`, `--token <id>`, `--vault <id>`.

**Run `--dry-run` first and show the human the cost.** Every step spends real
NEAR and several are irreversible.

### What the human must do first — you cannot do these

1. have a NEAR account whose key is in `~/.near-credentials`
2. hold ~3 NEAR in it (mostly a **refundable** storage stake for the contract,
   not a fee)
3. hold some of the token the agents will spend

If any is missing, stop and say which. Do not improvise around it.

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

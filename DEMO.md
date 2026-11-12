<!-- STAMP commit=60a4dde date=2026-11-12 -->
# Float — 90-second demo

**The one thing to land:** the agent asks for money, the *contract* decides, and the refusal names
which rule stopped it. Everything else is supporting detail.

Verified live state as of 2026-11-12 (read from chain, see the bottom of this file).

---

## Before you start — 60 seconds of setup

```bash
cd C:\Users\BASHIR\Documents\near-vault
node scripts/drive-mcp.mjs vault_config          # must print network: "mainnet"
```

Expected:

```json
{ "vault_id": "test015-near.usefloat.near", "owner": "test015.near",
  "network": "mainnet", "paused": false, "node_count": 2 }
```

If `network` is not `mainnet`, or the vault reads as missing, **stop** — the client and the vault
disagree about the chain, and every read will lie about your money being gone. `.mcp.json` is the
file to fix.

**Restart your MCP client** so it picks up `.mcp.json`. The client starts its servers once; an edit
has no effect until a restart, which is why `drive-mcp.mjs` exists to check the config without one.

Have open: a terminal, the MCP client, and <https://nearblocks.io/address/test015-near.usefloat.near>.

---

## The script

### 0:00 — The claim (15s)

> "This is a NEAR contract that holds money and enforces a budget on-chain. The agent gets a key
> that can call exactly **one method** on **one contract**. It cannot move tokens, cannot raise its
> own limit, cannot reach any owner function. That's a protocol-level key restriction, not a policy
> check it can argue with."

Show the key, from the chain:

```bash
node scripts/show-agent-key.mjs
```

```
receiver_id  test015-near.usefloat.near
method_names ["request_payment"]
```

> "One receiver. One method. That's the whole security story."

### 0:15 — The budget tree (15s)

In the MCP client:

```
Show me the budget tree
```

> "Root has 25 USDC a day, 10 per payment. The agent sits underneath. A payment charges **every
> level** — so a vault-wide ceiling holds even when a child's own cap looks free."

### 0:30 — A payment that works (20s)

```
Pay 0.25 USDC to test015.near for demo credits
```

Expect `SETTLED` with a `request_id`. Then:

```
Show me today's budget for node 1
```

> "Executed went up by 0.25 and available came down by the same. That's the contract's own ledger,
> not a dashboard's guess — and the ROOT moved too, because a payment charges every level."

**Check the starting number before you present.** The cap resets 00:00 UTC, so if a payment has
already gone out today, executed starts above zero and the live figures below are the ones to read
from. Verified 2026-11-12: `0 -> 0.25` at node 1 **and** at root, charged chain `[0,1]`.

Refresh nearblocks — the USDC transfer is there.

### 0:50 — A payment that is refused (25s)

**This is the demo.** Everything before it is setup.

```
Pay 15 USDC to test015.near
```

The agent should answer in plain English, roughly:

> *"That's too big for one payment — a limit set higher up the budget caps each payment at 10 USDC,
> and this asked for 15. Nothing was sent. Send 10 USDC or less, or ask the vault owner to raise
> the per-payment limit."*

> "Refused. Not by me, not by a prompt, not by the agent choosing to behave — by the contract. And
> notice it tells you **which** limit stopped it and what to do instead, in a sentence you'd say to
> a colleague."

**If you want to show the engineering underneath** (and for a technical audience it is worth 10
seconds), the precise reason is still in the payload under `technical`:

```
"reason_code": "PARENT_PER_TX_LIMIT"
```

> "Underneath, the contract named the exact rule: the **parent's** per-payment limit, not this
> agent's. There are 41 of these codes, and that precision is why the refusal can be explained at
> all. The user just never has to read it."

Then prove nothing moved:

```
Show me today's budget for node 1
```

> "Executed did not move. The refusal cost nothing and moved nothing — and the request is not
> even stored: `get_request` returns null for a blocked payment, so nobody can inflate your
> storage bill by spamming refusals."

### 1:15 — The part that makes it a product (15s)

```
Raise my daily cap to 100 USDC
```

The agent returns an **unsigned payload** and a CLI line.

> "It can't do it. It built a payload for me to approve in my own wallet. The server holds only the
> restricted agent key, which cannot reach an owner method at all. So when an agent tells you it
> changed your limits — it didn't. It made a request."

### 1:30 — Close

> "The budget is a tree, enforced on-chain, with refusals specific enough to debug. The agent pays
> its own gas from a key that can do exactly one thing. And winding it down returns the tokens, the
> gas balances and the storage deposit — `float-exit --dry-run` tells you what you get back before
> you touch anything."

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| "account does not exist" about your vault | client and vault on different networks | `NEAR_VAULT_NETWORK=mainnet` in `.mcp.json`, restart |
| reads work, `vault_pay` says "Paying requires NEAR_VAULT_AGENT_ID and a key" | no agent key loaded | check `NEAR_VAULT_AGENT_KEYS` points at `.float/agent-keys.json` |
| `NO_RECIPIENTS_SET` | the node's allowlist is empty | pay `test015.near` — it is the allowlisted recipient |
| `TRANSFER_FAILED` instead of `SETTLED` | vault is out of USDC, or payee unregistered | the vault holds **0.750000 USDC**; keep the demo payment small |
| `DAILY_BUDGET` on the first payment | a previous demo already spent today's 25 | caps reset 00:00 UTC; use a smaller amount |

**Do not run `--agents`** on anything. It refuses, by design.

---

## Fallback if mainnet misbehaves

The refusal half of the demo needs **no money and no balance** — it is rejected before anything
moves. So if the vault is dry or a transfer fails, lead with the refusal and the unsigned-payload
step, and show the settled payment from history instead:

```
Show me the last few payments
```

That reads a real mainnet payment that already settled, from the chain.

---

## Live state this script assumes

Read 2026-11-12, mainnet:

| | |
|---|---|
| Factory | `usefloat.near` — initialised, not paused, `required_deposit` 0.1 |
| Vault | `test015-near.usefloat.near` — owner `test015.near`, not paused, 300,817 B, 3.3484 NEAR |
| Tree | node 0 `root` (25/10 USDC), node 1 `agent` (25/10, recipients inherit) |
| Agent key | `ed25519:E2PGijm4YqU445…` → node 1, 0.11892 NEAR, `request_payment` only |
| USDC | vault holds **0.750000** (0.25 spent proving the golden path); allowlist `test015.near`, registered on the token |
| Today | node 1 AND root: executed **0.25**, available **24.75** (day 20769) — resets 00:00 UTC |
| Gates | no cooldown, no approval threshold |

Re-check before presenting:

```bash
node scripts/drive-mcp.mjs vault_config
node scripts/drive-mcp.mjs vault_budget '{"nodeId":1}'
node scripts/show-agent-key.mjs
```

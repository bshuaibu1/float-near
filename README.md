# Float — a spending budget an AI agent cannot talk its way out of

**NEAR smart contract that holds your money and enforces a per-agent budget on-chain.** You give
an agent a key that can call exactly one method on exactly one contract. It cannot move tokens
directly, cannot raise its own limit, cannot reach any owner function, and never touches your
wallet. Those are NEAR protocol key restrictions, not policy checks the agent might argue with.

```
owner's wallet ──deposits──▶ vault contract ──enforces──▶ agent's restricted key
                             budget tree                  request_payment only
```

Live on **mainnet**: factory `usefloat.near`, create page <https://usefloat.xyz>.

---

## Quickstart (mainnet, ~5 minutes)

### 1. Install the MCP server

```json
{
  "mcpServers": {
    "float": {
      "command": "npx",
      "args": ["-y", "@floatonnear/mcp"],
      "env": {
        "NEAR_VAULT_NETWORK": "mainnet",
        "NEAR_VAULT_FACTORY": "usefloat.near",
        "NEAR_VAULT_CONTRACT": "<your-vault>",
        "NEAR_VAULT_TOKEN": "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "NEAR_VAULT_TOKEN_DECIMALS": "6",
        "NEAR_VAULT_AGENT_KEYS": ".float/agent-keys.json"
      }
    }
  }
}
```

> **The network must match your vault.** A mainnet vault read by a testnet client does not raise an
> error — it reports your vault as *missing*, which reads as a broken product. Every surface
> defaults to mainnet now, and `scripts/check-network-defaults.mjs` fails the build if they drift
> apart. Set `NEAR_VAULT_NETWORK=testnet` to move the whole stack together.
>
> **Do not set `NEAR_VAULT_RPC_URL`** unless you mean it. It overrides the endpoint for the network
> you configured, so a leftover testnet URL sends mainnet questions to testnet and the answers come
> back wrong rather than failing.

`NEAR_VAULT_CONTRACT` is unknown until step 2 — leave it empty on the first run. `vault_create`
needs no vault and no key.

### 2. Create a vault — the human signs once, in their own wallet

Ask the agent to create one, or open <https://usefloat.xyz> directly. Either way:

- Connect a wallet → review → **one** `FunctionCall` to the factory → done.
- The factory does the rest in one batch: creates the account, deploys the contract, installs your
  key as full-access on the vault, binds the agent's gas key, and initialises the budget tree.
- Costs ~3.4 NEAR, almost all of it **refundable storage stake**. The page quotes its own figure;
  the whole deposit is returned if the batch fails.
- Your vault address is **derived** from your account (`alice.near` → `alice-near.usefloat.near`),
  so nobody can squat it.

Then put that address in `NEAR_VAULT_CONTRACT` and restart your MCP client.

### 3. Fund it

Send USDC to the vault address. `vault_budget` shows the caps; the vault's token balance is what is
actually spendable.

### 4. Give an agent a budget

Via the agent — `vault_add_role` returns an **unsigned payload** you approve in your wallet:

```
"Add an agent called research with a 50 USDC daily cap and 10 per payment"
```

Or from the CLI, if you have a key on disk:

```bash
npx -p @floatonnear/create-float float-agent --vault <your-vault> --owner <you> --dry-run
```

> **`create-float` alone builds a vault that cannot pay.** The wizard creates the vault and its
> budget tree; binding a spending key is a second command, because the key has to be installed by
> the vault itself. The browser path above does both in one transaction. The wizard now tells you
> this and prints the exact command.

### 5. Pay, and get refused

```
"Pay 0.25 USDC to vendor.near for API credits"     → SETTLED
"Pay 500 USDC to vendor.near"                      → PER_TX_LIMIT, nothing moved
```

A refusal is a **recorded outcome with a reason code**, not an exception. The codes are specific on
purpose:

| Code | Means |
|---|---|
| `DAILY_BUDGET` | this agent's own cap is spent |
| `PARENT_DAILY_BUDGET` | a **sibling** drained the shared pool — this agent's own cap may still look free |
| `PER_TX_LIMIT` | one payment was too large; splitting it may still hit the daily cap |
| `NO_RECIPIENTS_SET` | the node pays nobody yet — an owner decision |

There are 41 of them. `PARENT_*` existing separately is the hierarchy being visible in the error.

---

## How policy changes work

**The agent proposes; the human signs.** Every `vault_plan_*` tool returns an unsigned payload and
a CLI line. The MCP server never signs a policy change — it holds only the restricted agent key,
which cannot reach an owner method at all.

So when an agent says "I've raised your cap", it is wrong. It built a payload. Nothing changed
until you approved it.

---

## The three doors

Which one you come through decides what you can do. This is not arbitrary: browser wallets ignore
`signerId` and silently sign as the connected account, so anything needing the **vault** as signer
can never be a browser action.

| | Create | Pay | Change policy | Sign as the vault |
|---|---|---|---|---|
| **Browser** `usefloat.xyz` | ✅ | ✗ | ✅ approve | ✗ ever |
| **MCP** (the agent) | ✅ link | ✅ | ✗ propose only | ✗ |
| **CLI** (key on disk) | ✅ | — | ✅ | ✅ |

Gas-key recovery and teardown are therefore **permanently CLI jobs**:

```bash
npx -p @floatonnear/create-float float-retire --retire <role> --vault <v> --owner <o>  # one agent
npx -p @floatonnear/create-float float-exit   --owner <o> --vault <v> --dry-run        # everything
```

`float-exit --dry-run` tells you exactly what comes back before anything happens. Run it first.

---

## Known limitations

- **Labelled vaults are not found by lookup.** The dashboard and `/v1/resolve` derive the
  *unlabelled* address (`alice-near.usefloat.near`). A vault created with `?label=ops` exists at
  `alice-near-ops.usefloat.near` and must be addressed explicitly.
- **`derive_prefix` is not injective.** `a.b.near` and `a-b.near` both derive `a-b-near`; first to
  create holds it. Unfixable while addresses stay human-readable.
- **Cross-chain quotes are EXACT_OUTPUT.** `amount` is what the payee *receives*; the vault is
  charged more (~1.5% at 0.50 USDC, ~3.5% at 0.10), and the budget is charged the larger figure.
  Small cross-chain payments are disproportionately expensive.
- **Refused payments are not stored on-chain** — storing them would let anyone inflate your storage
  bill. `vault_history` shows settled and failed payments and says so.
- **No mainnet global contract.** Each vault carries its own code (~2.99 NEAR of refundable stake).
- **Six contract capabilities have no interface yet** — ownership transfer, node removal, stuck-payment
  sweep, NEAR-denominated caps. Tracked in `FLOAT.md` §5 and enforced by the build.

## Docs

| | |
|---|---|
| `DEMO.md` | 90-second demo script, exact commands |
| `STATE.md` | what is true right now — **wins over any doc in `docs/`** |
| `ARCHITECTURE.md` | the parts and how they connect |
| `FLOAT.md` | every capability, and the lifecycle end to end |
| `DECISIONS.md` | settled calls, each with the rejected alternative |
| `SKILL.md` | what the agent itself is told |

## Development

```bash
node scripts/verify-all.mjs     # THE gate: 37 checks
```

Not `npm test`. Every check asserts an exit code **and** a must-appear pattern **and** a
must-not-appear pattern, because a check that cannot run prints nothing and exits 0.

Build the contract with `cargo near build`, never plain `cargo build` — a plain build swaps in
near-sdk's pure-Rust fallbacks, so every panic becomes "unreachable opcode" and reason codes vanish,
silently, with tests still passing.

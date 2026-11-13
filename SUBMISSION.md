<!-- STAMP commit=pending date=2026-11-13 -->
# NEAR Hackathon submission — ready to paste

**Deadline: 2026-11-14 23:59 UTC.** Form at <https://nearhackathon.com/>.

> **Every number in here was read off the chain or out of a test run, not remembered.** The
> hackathon's own process screens submissions with an AI first "to verify projects run as
> described", so an unverifiable claim is worse than no claim. If you edit a figure, re-check it.
>
> That applies to the character counts below too — I wrote 1,847 and 734 from estimate and both
> were wrong (1,947 and 719). Re-count rather than trust them:
> `node -e "console.log(require('fs').readFileSync(0,'utf8').trim().length)" < desc.txt`

---

## 1. Form fields

| Field | Value |
|---|---|
| Project name | **Float** |
| Team lead | *(you)* |
| Email | *(you)* |
| Team size | *(you — solo?)* |
| **Track** | **Agent Economy** |
| NEAR wallet address | `test015.near` |
| Repository link | `https://github.com/bshuaibu1/float-near` — **MUST BE PUBLIC FIRST** |
| Demo post link | *(the X post — draft in §3)* |
| Website | `https://usefloat.xyz` |
| Description | §2 below |

---

## 2. Project description

Paste as-is. **1,947 characters**, inside the 20–2,000 limit.

> Float gives an AI agent a spending budget that a smart contract enforces.
>
> The agent gets a NEAR key that can call exactly one method on exactly one contract. It cannot
> move tokens directly, cannot raise its own limit, cannot reach any owner function, and never
> touches your wallet. Those are protocol-level key restrictions, not policy checks the agent
> could talk its way around.
>
> Budgets are a tree. A payment charges every level above it, so a vault-wide ceiling holds even
> when one agent's own cap looks free. When that happens the contract answers
> PARENT_DAILY_BUDGET, not DAILY_BUDGET — it tells you which rule stopped the payment and at
> which level. There are 41 of these codes. The agent translates them into plain English for the
> user and never shows the code itself.
>
> Try it: open usefloat.xyz, connect a wallet, approve one transaction. The factory creates your
> vault, deploys the contract, binds an agent key, and registers the vault on the token so you can
> fund it — in that single signature. The address is derived from your account, so nobody can
> squat it. About 3.5 NEAR, almost all of it a refundable storage deposit your vault holds, not a
> fee.
>
> It is live on mainnet now. Factory: usefloat.near. A real payment of 0.25 USDC settled and
> charged both the agent's node and the root; a 15 USDC payment was refused PARENT_PER_TX_LIMIT
> and moved nothing. The agent pays its own gas from a NEP-611 gas key (0.000866 NEAR per
> payment), so the vault's only cost per payment is the one yoctoNEAR a NEP-141 transfer requires.
>
> The agent proposes policy changes; it cannot make them. Every limit change comes back as an
> unsigned payload the human approves in their own wallet.
>
> Winding down returns everything: tokens, the agent's gas balance, and the storage deposit.
> Measured on mainnet — 3.467992 NEAR of the 3.468390 quoted, the difference being gas.
>
> Install: `npx -y @floatonnear/mcp` (27 tools). CLI: `npx @floatonnear/create-float`.

### Shorter variant, if the form feels long (**719 characters**)

> Float gives an AI agent a spending budget that a smart contract enforces.
>
> The agent's key can call one method on one contract. It cannot move tokens, raise its own
> limit, reach owner functions, or touch your wallet — protocol-level key restrictions, not
> policy checks.
>
> Budgets are a tree: a payment charges every level, so a vault-wide ceiling holds even when one
> agent's cap looks free. The contract names which rule stopped a payment, and at which level —
> 41 distinct codes, translated into plain English for the user.
>
> Live on mainnet: factory usefloat.near. One wallet signature creates the vault, binds the agent
> and registers it on the token. Winding down returns the deposit in full.
>
> `npx -y @floatonnear/mcp`

---

## 3. Demo post for X

Must state it was built at NEAR HACKATHON, tag **@NEARProtocol**, use **#NEARHackathon**, and
attach a video or screenshots.

> Built **Float** at NEAR HACKATHON: a spending budget for AI agents that a smart contract
> enforces.
>
> The agent's key can call **one method on one contract**. It can't move tokens, can't raise its
> own limit, can't reach your wallet. Not a prompt — a protocol-level key restriction.
>
> Budgets are a tree, so a payment charges every level above it. Ask for too much and the
> contract tells you *which* limit stopped you and at which level.
>
> Live on mainnet. One signature creates the vault, binds the agent, and registers it so you can
> fund it. The deposit comes back in full when you wind it down.
>
> `npx -y @floatonnear/mcp`
> usefloat.xyz
>
> @NEARProtocol #NEARHackathon

**Attach:** a screen recording of the `DEMO.md` run — the refusal is the moment worth filming.
Under 3 minutes; 90 seconds is enough.

---

## 4. What a judge can verify without asking you

This is the section that earns the technical-implementation score, because all of it is checkable.

| Claim | How they check it |
|---|---|
| Factory live on mainnet | `near view usefloat.near get_config` → owner, network mainnet, not paused |
| A real vault exists | `near view test015-near.usefloat.near get_config` → `node_count: 2` |
| The agent key is restricted | the vault's access keys show `receiver_id` = the vault, `method_names` = `["request_payment"]` |
| Vault is registered on USDC | `storage_balance_of` is non-null — the factory does this in the creation transaction |
| Packages published | `@floatonnear/mcp`, `@floatonnear/create-float`, `@floatonnear/float-adapter` on npm |
| The create page works | <https://usefloat.xyz> returns the connect screen and serves the exact contract it deploys |
| It is tested | 361 MCP + 262 CLI + 165 vault + 36 factory tests; `node scripts/verify-all.mjs` runs 38 gated checks |

---

## 5. Pre-submission checklist

- [ ] **MAKE THE REPO PUBLIC.** Hard requirement — judges cannot review a private repo. Git
      history was scanned for secrets and is clean (`node scripts/scan-history-secrets.mjs`,
      3,393 blobs, with a planted-secret control proving the scanner works).
- [ ] Fund the vault with a little USDC so the demo video can show a payment settling.
- [ ] Record the demo (`DEMO.md`), post it on X with the tags, keep the link.
- [ ] Publish `mcp 0.10.2` so `npx -y @floatonnear/mcp` serves the current build.
- [ ] `ssh root@154.12.117.17 'sudo -u float git -C /srv/float-near-web pull --ff-only origin main'`
      so `usefloat.xyz/skill.md` matches the repo.
- [ ] Re-read §2 and delete anything you would not want checked.
- [ ] Submit at <https://nearhackathon.com/>.

---

## 6. Things deliberately NOT claimed

Left out because they are not true today, and the AI screener checks:

- **No users, no traction.** One mainnet vault, created by us.
- **Cross-chain works but is not demonstrated.** The NEAR Intents rail is implemented and
  quote-signed; no cross-chain payment has been made on mainnet. Quotes are EXACT_OUTPUT, so the
  vault is charged more than the payee receives (~1.5% at 0.50 USDC, ~3.5% at 0.10).
- **Six contract capabilities have no interface yet** — ownership transfer, node removal,
  stuck-payment sweep, NEAR-denominated caps. `FLOAT.md` §5 lists them and the build fails if a
  new one appears.
- **No on-chain pin on the vault build.** `create_vault_with_code` takes the code as an argument,
  so the page decides what a vault runs. Correct today (verified byte-identical), unpinned in
  principle. `DECISIONS.md` records why it was deferred.
- **The vault currently holds 0 USDC.** Fund it before filming.

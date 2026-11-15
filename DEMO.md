<!-- STAMP commit=9e40e30 date=2026-11-14 -->
# Float — the 90-second demo

> **For a judge reading this:** this is a *filming script*, not a verification
> doc. Every figure below describes the state **after** you run
> `STAGED-DEMO-SETUP.ps1` — a `demo` agent on 5 USDC/day with 2 USDC in the
> vault — so it will not match the live vault, which carries its own agents and
> balance. To check claims against the chain instead, use the
> "What a judge can verify without asking us" table in
> [`README.md`](README.md); every row there is a command you can run.

**The one thing to land:** the agent asks for money, the **contract** decides,
and the refusal names *which rule* stopped it.

Everything else — the tree, the gas keys, the teardown — is supporting detail.
If a viewer remembers only *"the AI asked and the chain said no"*, the video
worked.

> **Do not demo features.** A tour of 27 tools is forgettable. One agent being
> refused on-chain, in plain English, is not.

---

## Before you record — 2 minutes

**1. Run the staged setup.** It binds the `demo` agent (5 USDC/day, 1 per
payment) and puts 2 USDC in the vault. Both commands are in
`STAGED-DEMO-SETUP.ps1` — run them one at a time:

```powershell
cd C:\Users\BASHIR\Documents\near-vault
notepad STAGED-DEMO-SETUP.ps1
```

**2. Restart your MCP client** so the `float` server loads. The client starts
its servers once; a config edit has no effect until a restart.

**3. Verify the state you are about to film:**

```powershell
node scripts/drive-mcp.mjs vault_config
node scripts/drive-mcp.mjs vault_budget "{\"nodeId\":0}"
```

| | should read |
|---|---|
| vault | `test015-near.usefloat.near`, `network: "mainnet"`, `paused: false` |
| root | 25/day · **10 per payment** |
| `demo` agent | 5/day · **1 per payment** |
| vault balance | **2 USDC** |

Those two per-payment numbers *are* the script. **1** is the agent's own
ceiling; **10** is the vault's. You will hit the second one on camera.

If `network` is not `mainnet`, **stop** — the client and the vault disagree
about the chain, and every read will lie about your money being gone.

Have open: a terminal, the MCP client, and
<https://nearblocks.io/address/test015-near.usefloat.near>.

---

## The shot list

### 0:00–0:12 — the problem, said once

> *"If you give an AI agent money today, you give it a wallet key and you write
> the budget in a config file. The agent can read that budget. It can also just…
> not respect it."*

**On screen:** your face, or the README's first diagram. No code yet.

---

### 0:12–0:25 — the key cannot do what you fear

Run this live. It is the strongest 13 seconds in the video, because anyone
watching can check it themselves:

```powershell
near account list-keys test015-near.usefloat.near network-config mainnet
```

> *"That's the agent's key, on mainnet. One method — `request_payment` — on one
> contract. It cannot withdraw. It cannot change its own limit. That isn't my
> rule, it's NEAR's."*

**Highlight:** `method_names: ["request_payment"]`.

---

### 0:25–0:45 — it works (the setup)

In the MCP client:

```
Pay 0.25 USDC to test015.near for API credits
```

> *"Normal payment, inside the limits. The agent signs with its restricted key,
> the contract checks every cap, the money moves."*

**On screen:** the reply — *"Sent 0.25 USDC to test015.near. There's 4.75 USDC
left to spend today."*

**Let that sit for a beat**, and spend one line on it:

> *"Notice it talks like a product, not like a contract."*

---

### 0:45–1:10 — it refuses (the payoff)

```
Pay 15 USDC to test015.near
```

> *"Same agent. Same key. Nothing about the request is special — it's just too
> big."*

**On screen:** the refusal, roughly —

> *"That's too big for one payment — a limit higher up the budget caps each
> payment at 10 USDC, and this asked for 15. **Nothing was sent.**"*

Then the point, said slowly:

> *"It didn't crash. It was **refused**, by the contract — and it tells you which
> rule stopped it, and that the limit came from **above** this agent rather than
> from its own budget. There are 41 of those answers."*

**This is the moment the video exists for.** Don't rush it. If you have a spare
beat, re-run `vault_budget` and show the balance **did not move**.

---

### 1:10–1:25 — it cannot talk its way out

```
Raise your daily limit to 500 USDC
```

> *"And when I ask it to raise its own limit — it can't. It hands me something to
> approve in my own wallet. The agent proposes. I sign."*

**On screen:** the unsigned payload, and `money_moved: false`.

No money moves and nothing needs setting up, so this beat is free — and it closes
the loop the first line opened.

---

### 1:25–1:35 — close

> *"Float. A spending budget an AI agent cannot talk its way out of. Live on NEAR
> mainnet."*

**On screen:** `usefloat.xyz` · `npx -y @floatonnear/mcp`

---

## If something goes wrong mid-take

| It says | It means | Do this |
|---|---|---|
| *"this computer doesn't hold a signing key"* | the client didn't load the keyring | restart it; check `NEAR_VAULT_AGENT_KEYS` is an **absolute** path |
| *"I will not create a private key…"* | `vault_add_role` called without `key_location` | that is the secure default working, not a bug |
| vault reads as *missing* | network mismatch | set `NEAR_VAULT_NETWORK=mainnet` |
| the 0.25 payment is refused | the vault has no USDC | run step 1 of the staged setup |

**A refusal on camera is not a failure.** If an unplanned one happens, read it
out — that *is* the product. The only real failure is a payment that silently
appears to have worked.

---

## Posting it

Must say it was **built at NEAR HACKATHON**, tag **@NEARProtocol**, use
**#NEARHackathon**, and attach the video. The draft post is in `SUBMISSION.md` §3.

Under 3 minutes; 90 seconds is better. **The refusal is the thumbnail moment.**

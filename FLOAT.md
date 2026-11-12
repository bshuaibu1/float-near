<!-- STAMP commit=0efb58e date=2026-11-12 -->
# Float, end to end — everything it does, and the shape of actually using it

`ARCHITECTURE.md` is the map: the parts and how they connect. **This is the territory**: every
capability, and the process start to finish as a real person meets it.

Derived from source on 2026-11-12 — 47 vault methods, 11 factory methods, 27 MCP tools, 5 CLIs,
9 HTTP routes, 7 dashboard pages, 48 reason codes. Where a number appears here, it was counted,
not remembered.

---

# PART 1 — THE PROCESS, START TO FINISH

## The three doors

Float has three front doors, and which one you come through decides what you can do. This is the
single most important thing to understand about the product, and it is not arbitrary — it falls out
of one hard constraint: **wallets ignore `signerId`.** They silently sign as the connected account
and report success. So any action needing a signature *from the vault itself* can never be a
browser action, permanently.

| Door | Who it is for | Can create a vault | Can pay | Can change policy | Can sign AS the vault |
|---|---|---|---|---|---|
| **Browser** (`usefloat.xyz`) | A stranger with a wallet | ✅ | ✗ | ✅ (approves payloads) | ✗ *ever* |
| **MCP** (the agent) | The AI agent | ✅ (returns a link) | ✅ | ✗ (only *proposes*) | ✗ |
| **CLI** (`npx -p @floatonnear/create-float`) | The operator, with a key on disk | ✅ | — | ✅ | ✅ |

---

## ACT 1 — Creation

### The browser path (what a stranger actually does)

Seven screens, **one signature**:

```
 1  #connect      "Connect wallet"  → wallet picker (@hot-labs/near-connect)
 2  (wallet)      user approves sign-in
 3  #agent        ONLY if the link carried ?agent_pk= — shows the agent's public key
                  in 4-char chunks and asks the human to compare it against what their
                  agent displayed. "The key matches, continue" / "Create without agent"
 4  #plan         owner · vault address · network · caps · total NEAR
 5  (wallet)      ONE FunctionCall → factory.create_vault_with_code  (200 TGas)
 6  #signing      waiting
 7  #done         vault address, the NEAR_VAULT_CONTRACT line to paste, explorer link
```

Screen 3 is the interesting one. It exists because a link can carry a key, and a user who approves
without comparing would bind *somebody else's* agent to their own budget. So the page refuses to
treat the key as trusted input: it renders it in chunks and makes the human assert the match.

**What the one transaction contains** — the factory builds this batch, so the browser never has to
request a `DeployContract` (which wallets grey out):

```
1  CreateAccount                 the derived vault account
2  Transfer                       deposit minus the agent gas-key funding
3  DeployContract                 the ~294 KB vault wasm, from the `code` ARGUMENT
4  AddFullAccessKey               the owner's key → this is why the owner can later sign AS the vault
5  AddGasKeyAllowanceFunctionCall if agent_pk: restricted to request_payment on this vault only
6  TransferToGasKey               0.12 NEAR, the agent's own gas
7  FunctionCall  vault.new(...)   root node, limits, recipients   (30 TGas)
8  .then on_vault_created         refunds the WHOLE deposit if any of the above failed
```

Step 4 is load-bearing far beyond creation: it is the reason `float-exit` and `float-retire` can
recover gas-key balances later. Without it the money would be unreachable.

### The address is derived, not chosen

```
derive_prefix(owner)  =  owner with every "." replaced by "-"
vault_id              =  "{prefix}.{factory}"           →  alice.near      → alice-near.usefloat.near
with a label          =  "{prefix}-{label}.{factory}"   →  label "ops"     → alice-near-ops.usefloat.near
```

No registry, so nobody can squat your address — it is reserved by arithmetic. Three guards:

- **Label must be 1–16 of `[a-z0-9]`** — no dots or hyphens, so a label cannot escape its owner's namespace.
- **A label cannot equal the factory's own TLD.** Otherwise `alice.near` labelling itself `near` produces `alice-near-near`, colliding with what `alice.near.near` would derive. There is a test named for this.
- **64-character cap**, enforced by NEAR's own parser. The page checks before signing and says exactly how many characters over you are — because the deposit is ~3.4 NEAR and a transaction that can only fail still burns gas.

**Known residual risk, unfixed by choice:** `derive_prefix` is not injective. `a.b.near` and
`a-b.near` both collapse to `a-b-near`. First to create holds it. Unfixable while addresses stay
human-readable.

### What it costs

Never hardcoded — derived from the bytes being sent:

```
required_deposit          0.1 NEAR     (factory state, operator-set)
+ code stake              len(code) × 1e19 yocto      ~2.99 NEAR for 298,839 bytes
+ agent gas key           0.12 NEAR    (only if agent_pk present)
= ~3.4 NEAR total, and the page quotes its own figure
```

The **whole deposit is refunded** by `on_vault_created` if the batch fails. Gas is not.

### The CLI path, and a real asymmetry

`npx -p @floatonnear/create-float create-float` runs a 10-step interactive wizard — preflight,
naming, a printed bill, confirmation (typing the literal word `mainnet` on mainnet), account
creation, token registration, deploy, `new`, the budget tree, a key rotation, then it writes
`.float/adapter.env` and merges your MCP client config.

**But it cannot bind an agent.** `--agents` refuses for any non-zero value, deliberately and with a
printed explanation: `create_agent_account` was removed from the contract because the sub-accounts
it made could never be emptied (10.7752 NEAR is stranded across 18 testnet agents that way, plus
0.54434 on mainnet). Virtual agents replaced it — and the wizard was never wired to them.

So: **the browser path can produce a vault that can pay immediately; the CLI path produces one that
cannot, until you separately run `float-agent`.** That asymmetry is not written down anywhere a user
would look. It is in §5.

---

## ACT 2 — Giving an agent a budget

Two routes to the same end, differing in who signs:

**Via the agent (MCP).** `vault_add_role({role: "marketing", dailyCap: "50", perTxCap: "10"})`
generates a keypair, files it in the keyring under that role, and returns an **unsigned payload**.
The agent cannot do this itself — the human approves it. One `add_role` call then creates the node,
binds the key, and installs the funded gas key together.

**Via the operator (CLI).** `float-agent --vault v --owner o --node 0` sends three transactions:

```
1  bind_virtual_agent(node_id, public_key)     signed by OWNER   — the authority
2  addFunctionCallGasKey(…request_payment…)    signed by VAULT   — the restriction
3  transferToGasKey(funding)                   signed by VAULT   — the fuel
```

Funding is computed, never guessed:

```
reservation  = tgas × 1e12 × 1e9        ~0.0609 NEAR at 60 TGas — held once per key's life, refunded per call
burn/payment = 1.2e20 yocto             ~0.0012 NEAR — MEASURED from real mainnet payments
default      = reservation + 50 × burn  ~0.1209 NEAR
```

**The agent's key is restricted at the protocol level**, which is the whole product:

```rust
add_gas_key_allowance_function_call(
    public_key,
    AGENT_GAS_KEY_NONCES,       // 1 serial nonce lane
    Allowance::Unlimited,       // NOT a loophole — a gas key's cap is its BALANCE
    env::current_account_id(),  // receiver: this vault, nothing else anywhere
    AGENT_ALLOWED_METHOD,       // method:   request_payment, nothing else
)
```

It cannot call the token contract, raise its own limit, freeze, withdraw, reach any owner function,
or attach a deposit. Not "is checked and refused" — *cannot name them in a transaction.*

---

## ACT 3 — A payment, all the way through

`vault_pay({amount: "12.50", recipient: "vendor.near", memo: "API credits"})`. The MCP signs with
the restricted key, 100 TGas. Then the contract runs **eleven phases**, and the order is the design:
cheapest and most attacker-facing checks first, money last.

```
 1  AUTHENTICATE      resolve node from the caller account or the signing key
                      signed path: verify ed25519, check deadline, check nonce, BURN THE NONCE
                      (burned BEFORE dispatch, so a later panic leaves it burned — replay-safe)
                        → NOT_VIRTUAL_AGENT · BAD_AGENT_SIGNATURE · NONCE_NOT_FRESH
                        → AGENT_SIGNATURE_EXPIRED

 2  GAS FLOOR         prepaid_gas < 50 TGas → refuse, before anything is charged
                      (an under-gassed callback would strand the reservation forever)
                        → INSUFFICIENT_GAS

 3  CHEAP REJECTS     paused · request id shape · duplicate · amount>0 · memo ≤256 and no
                      control chars · any ancestor frozen · allowlist
                        → VAULT_PAUSED · INVALID_REQUEST_ID · DUPLICATE_REQUEST · INVALID_AMOUNT
                        → INVALID_MEMO · NODE_FROZEN · NO_RECIPIENTS_SET · RECIPIENT_NOT_ALLOWED

 4  ROUTE SHAPE       NEAR rail: nothing. Intents rail: quote signer set, quote not expired,
                      quote signature verifies, vault's own daily NEAR budget
                        → QUOTE_SIGNER_UNSET · QUOTE_EXPIRED · QUOTE_BAD_SIGNATURE · NEAR_BUDGET

 5  COOLDOWN          walk self + every ancestor
                        → COOLDOWN · PARENT_COOLDOWN

 6  PASS ONE: VERIFY  walk self + every ancestor, charge NOTHING yet
                        → TOKEN_NOT_ALLOWED · PER_TX_LIMIT · PARENT_PER_TX_LIMIT
                        → DAILY_BUDGET · PARENT_DAILY_BUDGET

 7  APPROVAL GATE     amount > effective threshold (the MINIMUM set anywhere in the chain)?
                      write a ticket, emit approval_required, hold. NO budget is reserved.
                        → APPROVAL_REQUIRED

 8  PASS TWO: CHARGE  only now. pending += amount at every level. stamp last_paid_ns.

 9  RECORD            store the request: TRANSFER_PENDING, with reserved_chain and reserved_day
                      frozen into it so the callback cannot disagree about who to refund

10  TRANSFER          NEAR rail:    ft_transfer(recipient, amount)        1 yocto, 10 TGas
                      Intents rail: storage_deposit(deposit_address) then ft_transfer to it

11  CALLBACK          on_transfer_result → for each level in reserved_chain:
                        pending -= amount  (always)
                        executed += amount (only if the transfer succeeded)
                      → SETTLED or TRANSFER_FAILED
```

**Two passes, not one** — verify every level before charging any level, so a refusal at depth 3
cannot leave depth 1 charged.

**Why `PARENT_DAILY_BUDGET` is its own code.** The agent's own cap can look completely free while a
*sibling* has drained the shared parent pool. One code would send the agent into a retry loop; two
tell it the truth. This is the hierarchy being visible in the error vocabulary, and it is the thing
the competing product structurally cannot say.

**Refusals are recorded outcomes, not exceptions** — a `PaymentOutcome` comes back with a
`reason_code`. The MCP's own instructions tell the model to report the code and not retry blindly.

**Refusals are NOT stored on-chain.** A blocked payment returns its reason and vanishes — storing
them would let anyone spam the vault's storage bill. So `vault_history` shows settled and failed
payments and says, in the response, that refused ones are absent. The adapter reconstructs them
separately by following chain events into a local log.

---

## ACT 4 — Living with it

**Watch.** `vault_tree` (the shape), `vault_budget` (what is left today, resetting 00:00 UTC),
`vault_history` (newest first), `vault_request` (one payment), `vault_gas` (how many payments each
agent can still afford), `vault_config`, `vault_roles`.

**Change policy.** 14 `vault_plan_*` tools. Every one returns the same envelope and **signs
nothing**:

```json
{ "action": "set_node_caps",
  "summary": "…", "warnings": ["…"],
  "unsigned_payload": { "receiver_id": "…", "method_name": "set_node_caps",
                        "args": {…}, "gas_tgas": 100, "deposit_yocto": "1" },
  "approve_with": "near contract call-function … sign-with-keychain send",
  "note": "This server did NOT sign this." }
```

The human approves in their own wallet, or runs the printed command. Owner methods take **1
yoctoNEAR** (`assert_one_yocto` + `#[payable]`, which must pair or the method is permanently
unreachable — the factory's kill switch was exactly that, with 10/10 unit tests green either side,
because unit tests call the Rust fn and never cross the generated wrapper).

**Approve a held payment.** `approve_payment` **re-checks every limit** — caps, cooldown, allowlist,
NEAR ceiling, quote deadline. A ticket is not a promise; it is a pause. An owner who approves a day
later gets a fresh verdict, which is the honest outcome.

**Cap-change validation is live.** In strict mode, `set_node_caps` refuses a cap below the sum of
its children's, and one that no longer fits its parent. The MCP also refuses to *build* a payload
against a node that does not exist — "that payload would be refused by the contract AFTER you signed
it."

**Top up gas.** `float-topup --quote` reads the chain and tells you what a top-up buys, signing
nothing. Without `--quote` it transfers and then **re-reads the key to verify**, because a
transaction can report success while the balance stays put.

---

## ACT 5 — Winding down

### Retiring one agent — `float-retire`

```
0  Authorisation   can this credential sign as the VAULT and as the OWNER?
1  The agent       resolve a ROLE NAME to a key (scoped to this vault — every vault has a "root")
                   report which node and what balance
2  GAS FIRST       withdrawFromGasKey, then RE-READ and assert zero
3  Only then       unbind_virtual_agent — the key can no longer authorise anything
4  What is left    the node and its budget stay; the key stays, empty and unbound
```

**The order is the entire safety property.** If the withdrawal fails this stops without revoking
anything, because an agent that still works is a problem you retry — an unbound key holding stranded
gas is one nobody comes back for. And it warns you never to tidy up the empty key, because:

> **`DeleteKey` on a funded gas key BURNS the balance and reports SUCCESS.** 0.08322 NEAR, measured,
> receipt green. `near-sys` has no withdraw host function at any version, so a contract can *never*
> empty its own gas keys. Recovery is `withdrawFromGasKey`, signed by the vault — a CLI job forever.

### Closing the vault — `float-exit`

Six steps. **Every one destroys the means of doing an earlier one**, which is why the order is not a
style preference:

```
1  ft_transfer tokens out      owner    DeleteAccount does NOT return tokens — ever
2  withdrawFromGasKey          vault    balance lives OUTSIDE account.amount; delete would burn it
3  storage_unregister          vault    refunds 0.00125; refuses while a balance remains (hence after 1)
4  purge_settled               owner    the ONLY lever that shrinks STATE
5  deploy a 33-byte stub       vault    shrinks CODE — and removes purge_settled and withdraw
6  DeleteAccount               vault    irreversible
```

Step 4 before step 5 because step 5 deletes the method step 4 needs. Steps 1–2 before step 6 because
deletion sweeps neither. Measured on mainnet: 308,281 B → purge → 304,300 → stub → **3,300 B**, and
then `delete-account` *succeeded*, returning the whole balance. Testnet refusals were at 10,330 B,
so the bound sits between.

`vault_teardown_report` answers "what do I get back?" before you start, including the part no UI
would show you: **recoverable = `amount` + Σ(gas-key balances) + 0.00125**, because a gas-key balance
is not in `amount`.

Guards that refuse rather than proceed: token withdrawal is **polled to zero** before deletion; a
failed gas withdrawal **stops everything**; and deletion needs the vault name typed out.

**Two things that stay lost.** A function-call key cannot sign `DeleteAccount` — 11.3 NEAR is
stranded forever across 19 agent accounts, and anything that funds an FC-key-controlled account is a
permanent loss. And a **wrong `TOKEN` deletes a vault with money in it silently**, because
`ft_balance_of` on a real-but-wrong token returns `"0"` rather than an error, so the teardown reports
nothing to withdraw and proceeds.

---

# PART 2 — EVERYTHING IT CAN DO

## The vault contract — 47 public methods

**Budget tree** · `add_node` `remove_node`¹ `set_node_caps` `freeze_node` `set_recipients`
`set_cooldown` `get_node` `get_tree`
**Agents** · `bind_agent` (an account) · `add_role` (node + key + funded gas key in one call) ·
`bind_virtual_agent` `unbind_virtual_agent` `get_virtual_agent_node` `get_virtual_agent_nonce`
**Payments** · `request_payment` (agent) · `request_payment_signed` (relayer, ed25519 + nonce +
deadline) · `get_request` `list_requests` `get_node_budget` `on_transfer_result` (callback)
**Approvals** · `set_approval_threshold` `approve_payment` `reject_payment`
`get_approval_threshold` `get_effective_threshold` `get_pending_approval`
**Ownership** · `propose_owner`¹ `accept_ownership`¹ `get_pending_owner` · `withdraw` (owner's
escape hatch — bypasses the budget tree, unaffected by pause)
**Vault-wide** · `set_paused` `set_strict_allocation` `get_config` `current_day`
**NEAR budget** · `set_max_daily_near`¹ `get_near_budget`¹ (caps the vault's own NEAR spend on
Intents registrations; default 0.01/day ≈ 8)
**Cross-chain** · `set_quote_signer` `get_quote_signer`
**Storage** · `purge_settled` (shrinks state, reclaims stake) · `sweep_stuck_pending`¹ (releases
reservations stuck ≥1h)
**Lifecycle** · `new` `migrate`
**Test-only** · `set_day_len_ns` `clock_mode` (production build reports `"production"`)

¹ **shipped and unreachable** — no interface. See §5.

### Two allocation modes

| | `strict_allocation = true` | `false` (default) |
|---|---|---|
| Child caps | must sum ≤ parent's | may overcommit |
| Effect | arithmetic guarantee | first-come-first-served against the parent pool |
| Validated | on `add_node` **and** `set_node_caps`, O(1) via `child_cap_sum` | — |

### Inheritance rules, which are not uniform

- **Recipients** — a child's list **REPLACES** the inherited one. Not a union. `None` = inherit from the nearest ancestor that sets one.
- **Cooldown** — an ancestor's cooldown **also blocks** children.
- **Freeze** — freezing a node freezes its whole subtree (every ancestor is checked on the hot path).
- **Approval threshold** — the effective one is the **minimum** anywhere in the chain. Strictest wins.
- **Budget** — charged at **every** level.

## The factory — 11 methods

`create_vault_with_code` (the path every client uses) · `create_vault` (global-contract path,
deliberately unused) · `vault_id_for` `derive_prefix` `get_config` · `set_paused` `set_code_hash`
`set_required_deposit` (operator-only) · `on_vault_created` (refund callback) · `new`

Events are plain logs, not NEP-297: `VAULT_CREATED:{vault}:{owner}` / `VAULT_FAILED:… refunding`.

## The MCP — 27 tools

**READ (5)** `vault_tree` `vault_budget` `vault_config` `vault_roles` `vault_request`
**PAY (1)** `vault_pay` — amount in **whole tokens** ("1.5" = 1.5 USDC, never base units); `rail: near|intents`
**PLAN (14)** `add_node` `set_caps` `bind_agent` `unbind_agent` `freeze` `set_recipients`
`set_cooldown` `set_approval_threshold` `approve_payment` `reject_payment` `set_strict_allocation`
`pause` `purge` `withdraw` — all return unsigned payloads
**OTHER (7)** `vault_create` `vault_await_create` `vault_add_role` `vault_gas` `vault_history`
`vault_pending_approval` `vault_teardown_report`

`vault_await_create` distinguishes **LIVE / NOT_YOURS / NOT_YET / UNVERIFIED** — it reads
`get_config.owner`, because "the account exists" and "the account is yours" are different facts and
conflating them is how someone gets pointed at a stranger's vault.

`vault_gas` returns a **CLI command, not a wallet payload**, because topping up needs the vault's
signature and a browser wallet cannot give one.

## The CLIs — 5 binaries

| Binary | Does | Signs as |
|---|---|---|
| `create-float` | 10-step wizard: vault, deploy, tree, config files, MCP wiring | owner + vault |
| `float-agent` | Add a virtual agent (bind → install gas key → fund) | owner + vault |
| `float-topup` | Re-fund a gas key; `--quote` reads only | vault |
| `float-retire` | Recover an agent's gas, then revoke it | vault + owner |
| `float-exit` | The six-step teardown | owner + vault |

All take `--network` (default **mainnet**), `--dry-run`/`--quote`, and read
`~/.near-credentials/{network}/{account}.json`.

## The adapter — 9 HTTP routes

Read-only: `/v1/dashboard` `/v1/spend-history` `/v1/vault-info` `/v1/agent-keys` `/v1/resolve`
`/v1/settings` `/healthz` · `POST /v1/owner-plan` returns an unsigned payload + a CLI line and is
**deliberately exempt from the API token** (it signs nothing) · `POST /v1/pay` **requires**
`FLOAT_API_TOKEN`, compared timing-safely.

Missing token on a money-moving route returns **503, not 401** — "the operator has not configured
one" is a different fact from "your credential is wrong". Binds to `127.0.0.1` by default; CORS is
exact-match on one origin.

**Memo redaction**, the one deliberate divergence from chain truth: payment rows return
`memo: null`, `prompt: null`, and `venue` falls back to the recipient. Memos are public on-chain —
the point is not to turn "know how to query a NEAR RPC" into "type a name". The **MCP reads the
chain directly and still sees full memos**, which is the asymmetry that was wanted.

## The dashboard — 7 pages

`/` overview + 14-day chart · `/activity` full history · `/agents` the tree, freeze toggles,
bind-agent form · `/api-keys` on-chain keys with restriction status (**red if FullAccess**) ·
`/fund` QR + balance polling every 15s · `/policies` caps, cooldown, allowlist, pause ·
`/settings` owner, and the teardown readout that tells you to use the CLI

Identity is an **account id typed into a box** — not authentication, because every read is a keyless
view call and every write leaves as a `signLink`. It **asks instead of defaulting** because it once
fell through to the adapter's configured vault and showed a mainnet owner the operator's *testnet*
demo tree as if it were theirs. Session key `float.owner.session.v2`; `floatFetch` is the single
door that attaches the owner, **including on POSTs**, because `/v1/owner-plan` is a POST and the
proxy reads the query string — a payload built against the wrong vault would be handed to a human to
sign.

**No Danger Zone, on purpose.** Four of the six teardown steps need the vault as signer, and wallets
refuse `DeployContract` from a dApp. A panel that walks you through three steps and cannot finish the
fourth is worse than an honest pointer to the CLI.

---

# PART 3 — THE REFUSAL VOCABULARY

**48 variants, 41 reachable.** This is the part of Float a competitor would find hardest to copy:
not that payments are refused, but that each refusal says *which* rule, at *which* level.

Recorded outcomes: `TRANSFER_PENDING` `SETTLED` `TRANSFER_FAILED` `SWEPT_STUCK`

Blocked (returned, not stored): `VAULT_PAUSED` `NODE_FROZEN` `NOT_AGENT` `NOT_VIRTUAL_AGENT`
`BAD_AGENT_SIGNATURE` `NONCE_NOT_FRESH` `AGENT_SIGNATURE_EXPIRED` `INVALID_REQUEST_ID`
`DUPLICATE_REQUEST` `INVALID_AMOUNT` `INVALID_MEMO` `TOKEN_NOT_ALLOWED` `RECIPIENT_NOT_ALLOWED`
`NO_RECIPIENTS_SET` `PER_TX_LIMIT` `PARENT_PER_TX_LIMIT` `DAILY_BUDGET` `PARENT_DAILY_BUDGET`
`COOLDOWN` `PARENT_COOLDOWN` `APPROVAL_REQUIRED` `APPROVAL_REJECTED` `NO_SUCH_APPROVAL`
`NEAR_BUDGET` `QUOTE_SIGNER_UNSET` `QUOTE_EXPIRED` `QUOTE_BAD_SIGNATURE` `INSUFFICIENT_GAS`

Hard panics: `NOT_OWNER` `INIT_NOT_SELF` `INVALID_CONFIG` `INVALID_ALLOCATION` `MAX_DEPTH`
`MAX_NODES` `MAX_CHILDREN` `UNKNOWN_NODE` `LEDGER_INVARIANT`

**7 dead variants retained on purpose** — `BaseRailClosed` `FeeCeilingExceeded` `InvalidFeeFields`
`SignatureRequested` `Signed` `SignatureFailed` `InvalidEvmAddress`, from the retired MPC/Base rail.
Borsh tags enum variants **by position**, and these codes are stored inside `PaymentRequest`, so
removing one would silently reinterpret every historical record. New codes are **appended, never
inserted**. Verified by counting, with a positive and a negative control on the matcher —
`.demo/count-reason-codes.mjs`.

---

# PART 4 — THE HARD LIMITS

| | |
|---|---|
| Tree depth | **4** (root → team → agent → sub-agent) |
| Nodes per vault | **64** · children per node **16** |
| Tokens per node | **4** · recipients per node **32** |
| Label | 1–48 chars · request id ≤64 · memo ≤256, no control chars |
| Cooldown | ≤ 7 days |
| Gas floor per payment | **50 TGas** — and exactly 50 settles, so the guard is `<` not `≤` |
| Day boundary | **00:00 UTC** |
| Sweep eligibility | pending ≥ **1 hour** |
| Purge / sweep batch | ≤ 100 · `list_requests` ≤ 50 |
| Agent gas funding | ≥ 0.06 NEAR, default 0.12 |
| Vault NEAR/day | 0.01 default (Intents registrations ≈ 8) |
| Measured gas | 7.9 TGas at depth 1, 9.3 at max depth — **~10× headroom**, not tight |

---

# PART 5 — WHAT IS MISSING

### Six capabilities with no interface

Built, tested, deployed on both networks, unreachable. Tracked in `scripts/map-surfaces.mjs`
(`KNOWN_GAPS`), which fails the gate on any *new* orphan:

| | |
|---|---|
| `propose_owner` + `accept_ownership` | Ownership transfer works. `vault_config` **displays** `pending_owner` — so the product shows a transfer in flight it gives you no way to start or accept |
| `remove_node` | The tree can only ever grow |
| `sweep_stuck_pending` | A stuck reservation holds budget until someone runs near-cli by hand |
| `set_max_daily_near` + `get_near_budget` | The vault's own NEAR ceiling, and its read side |

### Four warts found while writing this

1. **`create-float` makes a vault that cannot pay.** `--agents` refuses by design; the wizard was never wired to virtual agents. The *browser* path binds one in the creation transaction. Nothing tells a CLI user they must now run `float-agent`.
2. **The two doors disagree on network.** The CLI defaults to **mainnet**; the MCP defaults to **testnet**. Defensible individually (the CLI is for operators, and the MCP deliberately refuses to guess a mainnet factory) — but a user moving between them gets a different network without being told.
3. **Nothing on-chain pins the vault build.** `create_vault_with_code` takes the code as an *argument* and never reads `self.code_hash`, which only `use_global_contract` consults — on the path no client uses. So `get_config` advertises a `code_hash` that is not the code any vault runs. Verified today: the live host serves the canonical artifact byte-for-byte, so this is correct *in practice* and unpinned *in principle*. Deferred with its reasoning in `DECISIONS.md`.
4. **Cross-chain is EXACT_OUTPUT** — the vault is charged *more* than the payee receives (1.5% at 0.50 USDC, 3.5% at 0.10). Small payments are disproportionately expensive, and the budget is charged the larger figure.

### Not code

- **No README, no pitch, no demo script.** Deadline **2026-11-14 23:59 UTC**.
- **`npm publish` pending** — mcp 0.8.1, create-float 0.7.0 (needs 2FA). `float-retire` is not installable until then.
- **`integration-tests` cannot build on Windows** (`near-workspaces` has no Windows sandbox). A red `cargo check --workspace` is the environment, not the diff — scope to `-p vault -p mock-ft`.

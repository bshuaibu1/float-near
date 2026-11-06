# Running the ported Float dashboard on NEAR

The dashboard in `apps/dashboard` is the **existing Float UI**, copied from the
Solana product. Same components, same logo (`public/nobgfloat.png`), same
warm-neutral palette, same screens, same Tailwind config. Two things differ:

1. `components/wallet-provider.tsx` — a drop-in replacement for the
   Phantom/Solana provider. Identical exports and an identical
   `WalletContextValue`, so all ten consuming files are untouched.
2. `NEXT_PUBLIC_FLOAT_API_URL` points at the NEAR adapter instead of the
   Solana backend. Its built-in default was already `http://127.0.0.1:8787`,
   which is the adapter's port, so local dev needs no change at all.

Everything else — `app/`, `components/top-nav.tsx`, `components/app-shell.tsx`,
`lib/`, the Tailwind config — is byte-identical to the Float original. The
original in `New project/float-dashboard` was not modified.

## The data layer

`packages/float-adapter` serves the same `/v1` endpoints the dashboard already
calls, reading from NEAR vault views.

| Dashboard calls | Adapter reads |
| --- | --- |
| `GET /v1/dashboard` | `get_tree` + `get_node_budget` per node + `list_requests` + `get_config` |
| `GET /v1/spend-history` | `list_requests` (paged) |
| `GET /v1/settings` | `get_config().owner` |
| `POST /v1/pay` | signs `request_payment` with the restricted agent key |

## Which vault is the demo

| vault | code | state | role |
| --- | --- | --- | --- |
| `v4.floatv4.testnet` | **current** | 24 nodes, 16 virtual agents | the demo. Deployed 2026-10-28, migrated past the `BaseConfig` removal, and the virtual-agent round trip is proven on it. |
| `v3.floatvault-12329.testnet` | pre-virtual-agent | 21 nodes, 15 requests | **still running, deliberately.** Left serving on the old code it matches. |

v3 is not broken and was not replaced in place. It runs code that matches its
own state, so it answers every view call today. What it cannot do is accept an
upgrade: its 284 state bytes have no `pubkey_to_node`/`pubkey_to_nonce`, so
`migrate` cannot read them and `scripts/upgrade-vault.sh` will abort
atomically rather than brick it. Retiring it is a redeploy, not an upgrade, and
needs its own full-access key — which is held by whoever created it, not by the
`floatv4` keys the rest of this doc assumes.

The two trees are the same shape on purpose, so the cost difference is the only
variable:

```
root
├── research ── r1, r2          r1+r2 caps (500) > research pool (250)
└── swarm ───── s0 .. s15       16 siblings, each capped at the whole 250 pool
```

v3's 16 swarm members are real sub-accounts at 0.55 NEAR each — **8.8 NEAR**,
and per `DEFERRED-agent-key-recovery.md` that NEAR is stranded, because an
agent's only key is function-call scoped and cannot sign `DeleteAccount`. v4's
16 are keypairs bound with `bind_virtual_agent`: **~0.016 NEAR** of contract
state, most of it reclaimable by unbinding.

Rebuild or extend the tree with `node scripts/seed-demo.mjs` (idempotent —
existing labels are skipped, so an interrupted run can be finished rather than
duplicating the tree). `--dry-run` prints the plan; `--prove` demonstrates the
shared pool binding on chain:

```
s0   spend  50 -> SETTLED             | s0 own avail    0 | SWARM POOL avail    0   (x5)
s5   spend  50 -> PARENT_DAILY_BUDGET | s5 own avail  250 | SWARM POOL avail    0
```

s5 has spent nothing and its own cap is fully available, yet it is refused —
by `PARENT_DAILY_BUDGET`, not `DAILY_BUDGET`. That distinction is the hierarchy
being load-bearing rather than decorative, and the dashboard renders the two as
deliberately different sentences. `--prove` can only run once per UTC day; the
pool is genuinely spent afterwards.

## Run it

```sh
# 1. the adapter — pointed at the demo vault above
export NEAR_VAULT_CONTRACT=v4.floatv4.testnet
export NEAR_VAULT_TOKEN=ft.floatv4.testnet    # the NEP-141 the vault pays in
export NEAR_VAULT_TOKEN_DECIMALS=6
# only needed for the pay flow - the RESTRICTED key from create_agent_account:
export NEAR_VAULT_AGENT_ID=a0.your-vault.testnet
export NEAR_VAULT_AGENT_KEY=ed25519:...

npm -w @floatonnear/mcp run build
npm -w @floatonnear/float-adapter run build
npm -w @floatonnear/float-adapter start

curl -s http://127.0.0.1:8787/healthz

# 2. the dashboard (unchanged Float UI)
cd apps/dashboard && npm install && npm run dev
```

## How the screens map

- **Agents** - one row per budget node, root-first, with the hierarchy drawn
  into the display name (`root`, then an indented `research`, then `r1`). Team
  nodes get a row too: they hold the shared pool, which is the thing this
  product exists to show. The flat Float table is unchanged.
- **Policies** - `dailyBudget` and `perTxLimit` per node in human units, plus
  the cooldown and the payee allowlist.
- **Activity** - `list_requests`, newest first, with a reason code on every
  non-settled row.
- **Blocked rows** - Float's UI already renders `rail: "policy"`,
  `status: "blocked"` with `blockReason` and `blockMessage`, so no UI change
  was needed. `PARENT_DAILY_BUDGET` and `DAILY_BUDGET` get deliberately
  different sentences: one says the agent is out of budget, the other says the
  pool it shares is. That distinction is the whole point of the hierarchy, and
  rendering the same text for both would make it invisible on screen.

## Known limitation: historical blocked payments

A blocked payment is **never stored on-chain**. `request_payment` returns it as
a value and emits an event; nothing is written, deliberately, so an agent
cannot grow the vault's storage bill by spamming rejects.

So `list_requests` shows in-flight, settled and failed payments, not blocks.
The adapter keeps a bounded in-memory ring of the blocks **it** sees via
`POST /v1/pay`, which covers blocks made through this product. Blocks made by
another client, or from before the adapter process started, are not there and
cannot be without an event indexer.

## Not yet verified end-to-end

The read path has been exercised against real testnet RPC: the adapter starts,
reaches `rpc.testnet.near.org`, and returns a clean JSON error for a missing
vault rather than crashing. What has **not** been run is the full stack against
a live deployed vault, because that needs a funded testnet account:

- `POST /v1/pay` signing round-trip
- the dashboard rendering real tree and activity data

## Inert pages

`app/auth/callback` and `app/link` still import the Phantom SDK - they are the
Solana onboarding flows. They build and are unreachable in the NEAR flow. Left
in place rather than deleted, since removing screens is outside a data-layer
swap.

## Refusals: where they come from

A blocked payment is never stored in contract state, only emitted as a
NEP-297 event. The adapter therefore follows the chain head and recovers them
itself — on by default, no configuration needed.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BLOCKED_FOLLOW` | on | set `0` to disable following |
| `BLOCKED_FOLLOW_INTERVAL_MS` | `10000` | seconds between ticks |
| `BLOCKED_LOG` | `.demo/blocked-log.json` | where recovered refusals are kept |

`GET /v1/dashboard` returns `blockedCoverage` with the block range examined
**and** any gaps inside it. A gap means "nobody has looked here", which is not
the same as "nothing happened" — do not render them identically.

To fill a gap:

```sh
# into a SEPARATE file: the adapter is writing the live one, and both doing
# load/modify/save against it loses records to a last-writer-wins race
BLOCKED_LOG=.demo/backfill.json node scripts/scan-blocked.mjs --from <height>
node scripts/merge-blocked.mjs .demo/backfill.json
```

Backfilling is slow by nature — roughly 2 RPC calls per block, and public
endpoints throttle a sustained scan. The script paces itself, backs off on
`429`, and checkpoints every 500 blocks, so an interrupted run resumes instead
of starting over. See KNOWN-TRADEOFFS §12 for measured numbers.

## Paying as a specific agent

`POST /v1/pay` signs as whichever agent you name. The contract resolves the
spending node from the **signer**, so this chooses which budget is charged:

```jsonc
{ "amount": "1.5", "recipient": "payee.testnet", "nodeId": 4 }
{ "amount": "1.5", "recipient": "payee.testnet", "agent": "r2.float.me.testnet" }
```

Keys come from `NEAR_VAULT_AGENT_KEYS` (default `.float/agent-keys.json`, which
`create-float` writes) and/or the single `NEAR_VAULT_AGENT_ID` /
`NEAR_VAULT_AGENT_KEY` pair, which remains the default for requests that name
no agent. If several agents are loaded and a request names none, the adapter
returns `400` rather than guessing — picking arbitrarily would charge a budget
nobody chose, and the payment would *succeed*, surfacing later as an
inexplicable balance instead of an error.

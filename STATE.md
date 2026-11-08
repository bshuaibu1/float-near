<!-- STAMP commit=4032e1a date=2026-11-08 -->
# Float on NEAR — what is true right now

**One page. Hard cap.** If it grows past one screen, something belongs in `docs/` instead.
Long-form reasoning lives in `docs/`; settled calls live in `DECISIONS.md`. This file is
*current state only*. Update it when state changes, and re-stamp the commit line above.

## The pitch, in one paragraph

A NEAR smart contract that is a **budget tree an AI agent cannot talk its way out of.** The
owner deploys a vault and gives the agent a NEAR **function-call key pinned to one method
(`request_payment`) on one contract (the vault)**. The agent cannot call the token contract,
cannot raise its own limit, cannot freeze or withdraw, cannot attach a deposit — those are
protocol-level key restrictions, not policy checks. Budgets are **hierarchical**: a payment
charges every ancestor, so a sibling can exhaust your parent's pool and you get
`PARENT_DAILY_BUDGET`, not `DAILY_BUDGET`. Pays NEP-141 on NEAR, or cross-chain via NEAR
Intents.

## Deadline

**NEAR Hackathon closes 2026-11-14 23:59 UTC.** Hackathon ran 2026-11-01 → 11-14.
$250K, 13 tracks, 39 paid slots + $55K grand.

## The two verified differentiators vs the incumbent

`0xileri/SpactVault` (`spactvault.xyz`) is the direct competitor. It is **strong** — policy is
100% on-chain, it has a real concurrent sandbox test, 201 tests. Do **not** claim "we enforce
on-chain" or "we tested concurrency" as differentiators. Only these two survive:

1. **Hierarchy / per-agent budgets.** Ours: `ledgers: LookupMap<(NodeId, AccountId, u64), DailyLedger>`
   (`contracts/vault/src/lib.rs:203`) — the **node** is in the key. Spact's key is
   `(TOKEN, day)` with a single `Policy` and `MAX_AGENTS = 8` → one shared daily budget for
   all agents, no hierarchy. Verified against their `main` on 2026-11-01.
2. **Cross-chain.** Ours: `Route::Intents` (`lib.rs:1638`). Theirs: `enum Route { NearDirect }`,
   still the only variant.

**Who cannot use it:** a vault id is `<owner-with-dots-as-hyphens>[-label].<factory>` and must
fit NEAR's 64 characters. Under `fac.floatv4.testnet` (19 ch) that caps an unlabelled owner at
**44** characters, measured against the live factory. **An implicit account (64 hex chars)
therefore cannot have a vault at all**, under any factory. Both front doors now refuse before
a signature; the browser page did not until 2026-11-08.

Constraints: `MAX_DEPTH = 4`, `MAX_NODES = 64`, `MAX_CHILDREN = 16` (`types.rs:11-18`),
mirrored in `shared/contract-constants.json` and asserted by both the Rust and the MCP suites,
so drift fails two suites.

## What works (proven on chain, not reasoned)

- **Hierarchical charge on mainnet** — paying 0.05 from a node charged root + research + r1 and
  left sibling r2 at 0.000000.
- **16-agent shared-pool contention on testnet** — `s5` refused `PARENT_DAILY_BUDGET` while its
  own cap showed 250 available.
- **NEP-611 gas keys on mainnet** (2026-10-31, 0.000370 NEAR). An agent key *on the vault*
  self-submits a real payment and pays its own gas. **7/7** vs code hash `5UcToT1F…`.
- **Intents cross-chain round trip** end to end with live 1Click pricing; the vault registers
  the solver's deposit address itself.
- **Factory 12/12 on testnet** — `CreateAccount + Transfer + UseGlobalContract + new()` in one batch.
- **Shipped to npm**, each verified by installing from the registry and DRIVING it, never by
  reading the publish output — which disagreed with the registry twice on 2026-11-08:
  **`@floatonnear/create-float` 0.6.0** (15:27Z, `059ca56f…`, carrying the `c1a9ce7d…` contract
  verified on chain), **`@floatonnear/mcp` 0.5.0** (15:26Z, `1debe52b…`), and
  `@floatonnear/float-adapter` 0.2.1. The two were published 53s apart deliberately: the wasm
  and `AGENT_NODE_ID` must agree, or an agent's credential names a node it is not on and the
  failure lands at PAYMENT time. Verified as a pair after install — node 1, wasm `c1a9ce7d…`.
- **Onboarding needs no CLI and no key.** `claude mcp add float-near -- npx -y @floatonnear/mcp`,
  then ask the agent for a vault: it calls `vault_create`, returns a link, and the user signs in
  their own wallet. Verified from npm with zero config — 23 tools, `vault_create` among them.
  0.3.0 shipped 17 and could not create a vault at all, so this was true only in this repo
  until 2026-11-08.
- **A user can recover everything with one command.** `npx @floatonnear/float-exit` installed
  FROM npm, run against the live fixture, resolves the owner's key, finds the token from
  `get_tree`, finds the gas key and quotes **3.465732 back = 3.348190 account + 0.117542 gas
  key**. The six-step sequence behind it is proven 3x on live vaults at **99.96% returns**.
- Next.js dashboard (`apps/dashboard`), mobile build done. 37 of 38 reason codes tested.

## Live state right now

| | |
|---|---|
| active vault | `work12-testnet-fleet.fac.floatv4.testnet` (**testnet**) |
| owner | `work12.testnet` |
| factory | `fac.floatv4.testnet` |
| token | `usdc.fakes.testnet`, 6 decimals |
| RPC | `https://test.rpc.fastnear.com` |
| adapter | port 8787, quote-signer key present (Intents rail open) |
| adapter config | `scripts/restart-adapter.ps1` **hardcodes** the env. `.float/adapter.env` is NOT read by the local stack and still names the dead mainnet `float.test015.near` — edit the script, not the env file |
| fixture tree | `root(0) -> agent(1), marketing(2)` — an agent gets its OWN node since 2026-11-08 |
| fixture history | 3 settled + 1 refusal (`seed-fleet-blocked`, `PER_TX_LIMIT`). Refusal scan covers 276664820–276666019 (1,200 blocks) with **1** unread block (276665614), so the banner reads "incomplete" — correctly, since a refusal there would be invisible |
| stranded on testnet | `work12-testnet.fac.floatv4.testnet` holds **3.370330** with **zero access keys** — unrecoverable, the testnet twin of `r1.float.test015.near`. Predates the factory line that installs the owner's key. `float-exit` refuses it correctly rather than shrinking it |
| **mainnet** | **gone / bricked.** No mainnet factory (`FACTORY_BY_NETWORK.mainnet = undefined`, deliberate) |

## Commands

- Gate: **`node scripts/verify-all.mjs`** — **23 checks, 617 tests**.
  Asserts exit code **and** a
  must-appear pattern **and** a must-not-appear pattern, because a check that cannot run prints
  nothing and exits 0. Mutation suites are auto-discovered from `scripts/mutate-*.mjs`, so a new
  one is picked up without editing the gate.
  **IT DOES NOT RUN `create-float`.** The gate covers dashboard, adapter and mcp only, so
  that package’s **248 tests** — including `rotate-key` (key-privilege), `float-exit` (the refund
  path) and `rerecord` (the publish guard) — can regress without the gate noticing. Run them
  with `npm test -w @floatonnear/create-float`. They are **248/248 green** as of `2026-11-07`,
  so the reason not to wire them in has gone; it is simply not done yet.
- Rust: `cargo test` (192 tests). **Build only with `cargo near build`, never plain `cargo build`.**
- Local: `.claude/launch.json` → `create-page` (`node web/serve.mjs`, :8788) and `dashboard` (:3000).
- Fixture: `node scripts/seed-fixture.mjs` (needs `OWNER`, `FACTORY`, `TOKEN`; refuses mainnet).

## Broken / incomplete — the real list

1. **No README, no pitch, no demo script, no submission doc.** When written it MUST say two
   things that are true and non-obvious, or a user finds them out the hard way: **(a)** an
   implicit account (64 hex chars) cannot have a vault under any factory, use a named one; and
   **(b)** an agent gets its own node with the same caps as root, so your SECOND agent means
   lowering a number rather than restructuring (fixed 2026-11-08; both onboarding paths now
   agree).
   Grepped every file for `hackathon|submission|devpost|2026-11-14`: **zero matches** — the
   submission requirements are recorded nowhere in this repo. ← biggest gap, 6 days left.
2. **Sandbox/integration tier has never run on this machine** (needs Linux `neard`). Consequence:
   `contracts/integration-tests/tests/keys.rs:66` still calls `create_agent_account`, which was
   **removed from the contract** — that test cannot pass, and nobody sees it. 9 mutations
   (M9/M10/M17/M18/M22) blocked on this tier; M29's re-run rests on one manual testnet run.
3. **Mainnet is empty, and one account on it can never be closed.** Re-measured 2026-11-08:
   `float.test015.near` is **gone** (we closed it — that teardown is the proof the sequence
   works on mainnet). `test015.near` holds **3.425**. `r1.float.test015.near` holds **0.546779**
   with **zero full-access keys**, so it is unreachable forever — a function-call key cannot
   sign `DeleteAccount`, and a parent cannot delete a sub-account. Standing mainnet up again
   needs ~1.64 (factory, 163,525 B of code) + 3.468 (a vault with an agent) = **~5.11, so the
   gap is ~1.68** — not the ~1.3 recorded before, which went stale when the factory's code grew.
4. **Key files work but are not the DEFAULT.** `NEAR_VAULT_AGENT_KEY_FILE` /
   `FLOAT_QUOTE_SIGNER_KEY_FILE` are wired into both servers (shipped in `b649e3b`), but the
   provisioning path still *writes* the inline form: `create-float.mjs` (~981-1031),
   `print-mcp-command.mjs:88`, `print-agent-env.mjs:117`, `agent-key.ts:143-152`. A new user
   therefore still gets the exposed shape and only a docs-reader opts out. The exposure is
   realised, not theoretical — reading a config to answer "which vault is this pointed at"
   prints a live private key into scrollback and into the driving agent's transcript.
5. **`deploy-vps.sh` has never run on a host.** No systemd unit, no `pm2 startup`, no log rotation.
6. **A solver has never filled an Intents order** — the testnet deposit address was ours and the
   quote was `dry`. SETTLED on the Intents rail ≠ delivered.
7. Daily window is a **cliff, not rolling** — 2× daily budget across midnight. Open by decision.
8. `test015.near`'s seed phrase is the single key protecting it, in `~/.near-credentials`.
9. Inert Solana pages still in the dashboard (`app/auth/callback`, `app/link`).

## Next 3 steps

**Closed 2026-11-07:** `float-exit` is fixed AND **published as 0.5.0**, verified by installing
from the registry and driving it against the live fixture — not by reading the publish output,
which is how it first looked done while the registry still said 0.4.0. The contract rebuild came
out **byte-identical** (`003568bcea22be80…`): the binary was never stale, only its provenance
record, and the publish guard had a state no rebuild could clear. Nothing now stands between a
user and their deposit, so **step 1 below is the whole remaining job.**

1. **Write the README + pitch + demo script.** Nothing exists. The demo path is already one
   command (`seed-fixture.mjs` → adapter → dashboard → signing page :8788), and the strongest
   demonstrable claim is `PARENT_DAILY_BUDGET` vs `DAILY_BUDGET` rendered as two deliberately
   different sentences.
2. **Decide mainnet explicitly** — fund the ~1.3 NEAR gap and deploy a mainnet factory, or ship
   testnet-only and say so in the pitch. Do not leave this implicit.
3. **Make key FILES the default** (item 4 above): have `create-float` write the secret to a file
   and reference it by path, instead of inlining it into `.mcp.json` / `.float/adapter.env`.
   `.float/agent-keys.json` already holds the secrets, so check whether a new file is needed at
   all before adding one.

## Docs that contradict the code — do not trust these without checking

`docs/` is ~290KB and parts of it are superseded. Known traps:

- **5 docs still describe `create_agent_account` as live.** It was removed (`lib.rs:903`).
  Stale: `RUNNING.md`, `DEFERRED-agent-key-recovery.md` (its *entire* design is moot),
  `KNOWN-TRADEOFFS.md` §13e, `DECISION-ux-before-global-contracts.md` cost tables, `MUTATIONS.md` M15.
- `DECISION-ux-before-global-contracts.md` is **reversed by its own 2026-10-31 amendment.**
  Read the amendment first. Its "~0.05 NEAR/vault" and "~1,439 vaults per 100 NEAR" are wrong;
  real figures are ~0.15–0.25 and ~600.
- `DESIGN-browser-signing-flow.md` settles "factory or direct?" mid-document but leaves the
  "Decisions this needs" list posing it as open.
- `DEPLOY-VPS.md` says "no health endpoint"; `/healthz` exists (`float-adapter/src/server.ts:463`).
- `RUNNING.md` names `v4.floatv4.testnet` as "the demo"; the configured vault is
  `work12-testnet-fleet.fac.floatv4.testnet`. `v4` is an old generation (no `NEAR_BUDGET`,
  no `PARENT_COOLDOWN`, no approval gate).
- `STAGED-mainnet-self-submit.md` — **read ROUND 3 only**; rounds 1-2 are explicitly stale.
- `SKILL.md` claims "mainnet is the default"; there is no mainnet factory.
- `KNOWN-TRADEOFFS.md` has **two sections numbered 13**. Numbers are never renumbered because
  code cites them, so "§13" is ambiguous.

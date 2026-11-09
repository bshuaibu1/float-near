<!-- STAMP commit=e4bbe2b date=2026-11-09 -->
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
- **The MCP tells an agent what Float IS, not just what each call does.** `instructions` on the
  handshake (2,342 chars) is injected into the client system prompt: the three trust lanes, the
  workflow, and that `vault_plan_*` returns an UNSIGNED payload so planning is not doing. It had
  none until 2026-11-08 — the gap between this and servers that feel like they already
  understand the project.
- **Onboarding is meant to be a SENTENCE**, copying agentcash: paste
  `Set up <url>/skill.md` into any agent and it installs itself. `SKILL.md` now opens with a
  Setup section (both install forms, why `-y` matters, never ask for a private key) and
  `web/serve.mjs` serves it at `/skill.md` as text/plain. **LIVE at
  `https://usefloat.xyz/skill.md`** since 2026-11-09 — so the whole onboarding is now one
  pasteable sentence: `Set up https://usefloat.xyz/skill.md`. The install line stays UNPINNED
  (`npx -y @floatonnear/mcp`) so the server always matches the contract create-float ships.
- **Onboarding is also one plugin install.** `plugin/` declares the MCP server in its manifest, so
  installing it starts the server — nothing to paste. It also ships `SKILL.md` at a path Claude
  Code actually reads: the root copy has valid frontmatter and ships inside the create-float
  tarball, but skills load from `.claude/skills/` or a plugin, never an npm package root, so it
  was shipped to every user and loadable by nobody. The manual route still works:
  `claude mcp add float-near -- npx -y @floatonnear/mcp`,
  then ask the agent for a vault: it calls `vault_create`, returns a link, and the user signs in
  their own wallet. Verified from npm with zero config — 23 tools, `vault_create` among them.
  0.3.0 shipped 17 and could not create a vault at all, so this was true only in this repo
  until 2026-11-08.
- **A user can recover everything with one command.** `npx @floatonnear/float-exit` installed
  FROM npm, run against the live fixture, resolves the owner's key, finds the token from
  `get_tree`, finds the gas key and quotes **3.465732 back = 3.348190 account + 0.117542 gas
  key**. The six-step sequence behind it is proven 3x on live vaults. Quoting one RETURN
  PERCENTAGE is misleading and was done here until 2026-11-09: the refundable part is the
  **stake**, which always returns in full, while the gas key returns minus real gas spent
  (0.000674/payment). A lightly-used vault reads ~99.9%, a fully-spent gas key 96.5%, and
  both are the same system behaving correctly.
- Next.js dashboard (`apps/dashboard`), mobile build done. 37 of 38 reason codes tested.

## Live state right now

| | |
|---|---|
| active vault | **`flatdata6673-testnet.fac.floatv4.testnet`** (**testnet**) — UNLABELLED, so `/v1/resolve` derivation finds it. 42.25 USDC, 3 nodes, 1 gas key |
| owner | **`flatdata6673.testnet`** (key already on disk). `work12.testnet` is the browser-test wallet and holds 3.50 USDC |
| factory | `fac.floatv4.testnet` |
| token | `usdc.fakes.testnet`, 6 decimals |
| RPC | `https://test.rpc.fastnear.com` |
| adapter | port 8787, quote-signer key present (Intents rail open) |
| adapter config | `scripts/restart-adapter.ps1` **hardcodes** the env. `.float/adapter.env` is NOT read by the local stack and still names the dead mainnet `float.test015.near` — edit the script, not the env file |
| fixture tree | `root(0) -> agent(1), marketing(2)` — an agent gets its OWN node since 2026-11-08 |
| old fixture | **TORN DOWN 2026-11-09.** `work12-testnet-fleet.fac…` is GONE, verified on chain. **+3.466807 landed** on `work12.testnet` (0.615163 -> 4.081970), reconciled to **0.000946** of teardown gas against a 3.467753 prediction. Six-step sequence now proven **4x**, this time end-to-end by script with `EXPECT_TOKENS=0` guarding the delete |
| fixture history | 3 settled + **1 refusal `PARENT_PER_TX_LIMIT`** (`seed--blocked`) — the HIERARCHY differentiator, not a plain per-tx cap. Scan coverage 276892844–276893243, 0 holes |
| stranded on testnet | `work12-testnet.fac.floatv4.testnet` holds **3.370330** with **zero access keys** — unrecoverable, the testnet twin of `r1.float.test015.near`. Predates the factory line that installs the owner's key. `float-exit` refuses it correctly rather than shrinking it |
| demo blocker | **RESOLVED 2026-11-09.** Was: the seeder could only build `<owner>-fleet.<factory>` while the dashboard only derives `<owner>.<factory>`. Verified end to end that `?owner=flatdata6673.testnet` returns the right vault and 42.250000, with the refusal first in the activity feed |
| CWD TRAP | `BLOCKED_LOG` and `RELAY_LEDGER` default to **cwd-relative** paths. Run the adapter from the **repo root** or the refusal store splits in two and the activity feed shows ZERO refusals while looking fine. The systemd unit now sets both absolute |
| RPC throttling | **fastnear rate-limits PER IP, and one dev session can exhaust it.** After a day's work this machine got **3/12** on a BARE curl with no adapter running, and `rpc.testnet.fastnear.com` / onfinality / near.dev were no better. Consequence: **an "unavailable rate" measured from a dev box is NOT evidence about production.** #67's commit message blames the adapter's refusal-follower for this — that is **REFUTED**: with `BLOCKED_FOLLOW=0` and zero follower rate-limits, reads still failed 8/12, and bare curl failed identically. The follower is innocent; the fix in #67 (503 instead of a false "you have no vault") is still correct and still needed. What the hosted box will actually see is **UNKNOWN until it runs there** |
| RPC | **`rpc.testnet.near.org` is DEPRECATED** — answers `-429 "STOP USING IT NOW"`. Use `test.rpc.fastnear.com`. The adapter's var is `NEAR_VAULT_RPC_URL`, **not** `NEAR_RPC_URL`; the wrong name silently keeps the default |
| **hosting** | **LIVE** on `154.12.117.17`. `https://usefloat.xyz/skill.md` (install sentence), `https://usefloat.xyz/` (signing page), **`https://app.usefloat.xyz/`** (dashboard, `dash.` is an alias). A signing link carrying `?factory=` still 301s from `app.` to the apex — asserted BOTH ways, since a shim that stops shimming is worse than none. TLS to 2027-02-07 |
| hosting: follower | **`BLOCKED_FOLLOW=0` on the public box.** Measured there: follower on = 117 rate-limits/2min, `/healthz` 500, resolve degraded, on a host whose bare RPC is 40/40. Consequence: refusals after deploy are not picked up; re-scan with `NEAR_VAULT_CONTRACT=<vault> node scripts/scan-blocked.mjs --from <block>` on the box, because `.demo/` is gitignored so a fresh clone never carries one |
| hosting safety | `POST /v1/pay` answers **503** from the public internet — unauthenticated AND with the repository's own published `local-dev-token`. Ports 8787/3000/8080 answer **000** externally (loopback only). No `FLOAT_API_TOKEN`, no agent key on that box, and the deploy script REFUSES if either is even present in its shell |
| hosting guards | the script REFUSES to run if `FLOAT_API_TOKEN` / `NEAR_VAULT_AGENT_KEY` / the quote-signer vars are so much as PRESENT in its shell (`${X+set}`, so an EMPTY value is refused too). Final assertions are **positive-controlled**: a read must return 200 through the public hostname BEFORE the 503s are believed, because "gate shut" and "nothing listening" are the same output. It also fires the repo's own published `local-dev-token` at the box, and requires `/v1/owner-plan` to answer **400 not 503** so a regression to method-gating fails the deploy |
| **Float VPS** | **`154.12.117.17`** (`wattson`, Ubuntu 24.04.5, 2 cores / 1.9Gi / 58G). **PREPPED 2026-11-09**: Node **22.23.4** via NodeSource (NOT apt's EOL 18.19), nginx 1.24.0, certbot 2.9.0, git; **4G swap** added + fstab entry, because `next build` on 1.9Gi with no swap was an unmeasured OOM risk; ports 443/8080/8787/3000 free. Non-root **`float`** user with passwordless sudo and the deploy key — the script REFUSES to run as root, and only root existed |
| VPS read reliability | **40/40 (100%)** measured ON that host. Settles it: fastnear free tier is adequate, no subscription. (Dev machine was 26% — per-IP throttle, not a product defect) |
| DNS | **nothing resolves yet.** `usefloat.xyz`, `www`, `app`, `dash` all need A records -> **154.12.117.17**. The old `209.209.10.210` note was STALE — those records are gone, so there is no repointing risk and nothing to break on the pythscan box. `dash` is required or certbot's HTTP-01 fails for the dashboard vhost |
| **mainnet** | **FACTORY IS LIVE: `usefloat.near`** (2026-11-09). Code verified against the CHAIN, not the deploy's report: local sha256 `ee925937c7b9…` == `code_hash` base58-decoded, and the deployed bytes fetched and compared **byte-for-byte**, 163,525 B. `get_config`: owner `test015.near`, network mainnet, `required_deposit` 0.1, not paused. `vault_id_for(test015.near)` -> `test015-near.usefloat.near`. 1 FullAccess key, still matching the saved secret |
| mainnet: usable | **`@floatonnear/mcp` 0.6.1 IS LIVE AND VERIFIED.** Installed UNPINNED from the registry (as users get it) and DRIVEN over stdio: handshake `0.6.1`, `vault_create(network=mainnet)` -> factory `usefloat.near`, deposit **3.34920**, no error. **0.6.0 is deprecated** ("queries the testnet RPC") — it resolved the right factory then asked testnet, so users were told a verified account did not exist. Lesson repeated twice today: 224 green tests did not catch either, because nothing imported both sides of the wiring |
| mainnet: caution | the factory's OWNER is `test015.near` — a personal account. The NAMESPACE is no longer personal (that was the point of `usefloat.near`), but pause/config authority still is. Fine for now; worth moving before this is anyone else's money |
| mainnet: next step | **create the first mainnet vault** with a fresh wallet funded >= ~3.5 NEAR (creation costs 3.34920). Then redeploy with `MAINNET_VAULT=<that vault>` and `.near` wallets resolve on the dashboard. Live factory asked directly: not paused, network mainnet, `required_deposit` 0.10; `demo.near` -> `demo-near.usefloat.near` (23 ch) |
| dashboard: networks | **routes by the wallet's SUFFIX** — `.near` -> mainnet adapter, `.testnet` -> testnet. No page changes; they already send `?owner=`. **No mainnet adapter -> 503 `NO_MAINNET_ADAPTER`, never a testnet fallback.** The mainnet adapter is GATED on `MAINNET_VAULT` because the adapter refuses to start without a default vault and mainnet has none yet |
| **money is recoverable** | **The 3.3492 storage DEPOSIT returns in full, always — it is stake, not a fee.** The gas key returns minus what the agent genuinely spent, measured at **0.000674/payment**. So recovery is usage-dependent, not a fixed figure: **100%** unused, **99.92%** after 4 payments (the fixture, `float-exit --dry-run`), **96.54%** once a 0.12 gas key is fully spent. Tokens and the ~0.00125 registration refund come back on top. **The r1 stranding cannot recur**: the factory runs `.add_full_access_key(env::signer_account_pk())` and that key is confirmed FullAccess on the live fixture; r1 has a FunctionCall key only, 0 FullAccess. Gas keys are withdrawn FIRST (`DeleteKey` BURNS them) and float-exit halts if that fails. **Untested gaps**: the six-step teardown has never run on a `usefloat.near` vault, and float-exit needs the owner key ON DISK — a wallet-only user cannot run it |
| agent gas | **top-up shipped** (PR #98, not yet published): `float-topup` CLI + `vault_gas` MCP tool. An agent's key funds ~**178 payments** at 0.12 (0.000674 each); a depleted one previously had no route back but `add_role`, which leaves a dead node. Each agent needs its OWN key — the vault identifies an agent BY its public key (`pubkey_to_node`), so one shared key would collapse every agent onto one node and delete the hierarchy. Top-ups are signed BY THE VAULT, so CLI-only, like the teardown |
| onboarding | **`usefloat.xyz/skill.md` is live and now covers RECOVERY.** Proven by a real cold install: a fresh agent fetched it, installed it, verified 23 tools by driving `tools/list`, and caught that the doc taught spending but never mentioned teardown or that funds come back (0 mentions of `float-exit`/`teardown`). Fixed and redeployed, 20,601 B. **Heads-up for naming:** `@usefloat/mcp` is YOUR OTHER product (masterwattson), not a competitor — both wanted the MCP name `float`, so an installer must pick one |
| gas keys: top-up | **SHIPPED 2026-11-09.** `npx @floatonnear/float-topup --vault <v> --owner <o> --agent <pk> --payments 100` (or `--amount 0.05`, or `--quote` to read only), plus the **`vault_gas`** MCP tool so an agent can answer *"how's my marketing agent doing?"* and *"what would 0.05 buy?"* — it resolves by NODE LABEL, reads the balance, quotes, and hands over the command. **Not reachable by users until the next npm publish.** A top-up is NOT a second initial funding: the reservation is already in the key, so charging `gasKeyFunding()` again would overcharge 0.06 (~50x the burn bought). Measured on the fixture: 47 payments left, +100 costs 0.12, 0.05 buys 42 more |
| mainnet: signing link | VERIFIED end to end with the URL the MCP actually emits: `app.usefloat.xyz/?factory=usefloat.near&network=mainnet` -> 301 to the apex with the query intact -> 200, page carrying the real Circle USDC id `17208628f84f5d6a…` (6dp). That chain crosses today's dashboard move to `app.`, so it was checked rather than assumed |
| mainnet: money | `usefloat.near` **1.800000**, `test015.near` **1.617630** (after funding it). Factory code stake **1.635250** is covered by the factory's own balance — nothing more moves from the parent. A mainnet DEMO VAULT is a further **3.4692** and is **NOT affordable**: mainnet will be "the factory is live, anyone can create a vault" rather than a populated demo, unless funded |
| factory artifact | `target/near/factory/factory.wasm`, **163,525 B, sha256 `ee925937c7b9…`** — rebuilt 2026-11-09 via `scripts/build-factory.sh` from a clean tree at HEAD (both artifacts deleted first, 14s of real work, existence asserted). **It was never stale**; an earlier claim that it was came from reading MTIME, which this repo already knows lies |

## Commands

- Gate: **`node scripts/verify-all.mjs`** — **25 checks**.
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
4. ~~Key files work but are not the DEFAULT.~~ **FIXED 2026-11-09.** The provisioning path
   now writes a PATH, never the secret: `.float/adapter.env` and `.mcp.json` carry
   `NEAR_VAULT_AGENT_KEY_FILE` pointing at `.float/agent-keys.json`, and `vault_create`'s
   env file does the same. `readKeyFile` learned the fleet-keyring shape so **no third file
   holding the same secret was created** — that would have been more exposure, not less.
   Verified end to end: the env file does not contain the secret, and the server still
   resolves it and learns the account id. Two field spellings exist in real keyrings
   (`{agentId, secret}` canonical, `{vault, privateKey}` older) and both are read; a refusal
   names the fields it found, never a value.
5. **Multi-tenant for reads AND owner actions; `/v1/pay` can never be.** Fixed 2026-11-09: the adapter accepts
   `?vault=` / `?owner=` per request and answers `/v1/resolve`, and the dashboard's proxy
   rewrites every GET to the connected wallet's own vault. **The pages never changed** — all
   seven have always sent `?owner=`; the adapter just ignored it, which is the whole reason a
   visitor saw the operator's vault. Having no vault answers 404 `NO_VAULT` and renders a
   create-one empty state, rather than falling through to the configured vault.
   The gate is now by **ROUTE, not method** (an ALLOWLIST, so a new route is born shut):
   `/v1/owner-plan` needs no token because it returns an **unsigned** payload the owner signs
   in their own wallet, so a hosted box can offer owner actions with **no token and no agent
   key**. **`/v1/pay` always needs it** and is never rewritten — it signs with the key the
   process holds. This matters because the dashboard proxy attaches `FLOAT_API_TOKEN` *without
   authenticating the caller*: a public dashboard **with** a token set is an open `/v1/pay`.
   So **never set `FLOAT_API_TOKEN` on the public box** — the deploy script refuses if it is set.
   The gate is ONE tested function, `apps/dashboard/lib/proxy-gate.ts`: the proxy used to carry
   its own method-based copy, which **silently bypassed the adapter's route gate** and 503'd
   owner actions in production while the PR claimed they worked. Found only by curling a
   token-less stack; now 10 tests + 7 killed mutants. Caveat: derivation finds the
   **unlabelled** vault only — a labelled one needs an explicit `?vault=` (see Live state).
6. **`deploy-vps.sh` has never run on a host.** No systemd unit, no `pm2 startup`, no log rotation.
7. **A solver has never filled an Intents order** — the testnet deposit address was ours and the
   quote was `dry`. SETTLED on the Intents rail ≠ delivered.
8. Daily window is a **cliff, not rolling** — 2× daily budget across midnight. Open by decision.
9. **Two mainnet seed phrases are unbacked-up.** `test015.near`'s, and now `usefloat.near`'s —
   written by the CLI as `master_seed_phrase` inside
   `~/.near-credentials/mainnet/usefloat.near.json`. That account will own Float's entire
   mainnet namespace (every vault is its sub-account), and it has exactly ONE full-access
   key. Losing that file loses the namespace permanently.
10. ~~Inert Solana pages in the dashboard.~~ **DONE** — `app/auth`, `app/link` and `app/setup` are deleted, no `@solana`/wallet-adapter package remains, and every surviving mention is a COMMENT recording what was removed. Verified 2026-11-09.

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

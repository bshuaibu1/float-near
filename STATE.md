<!-- STAMP commit=308a644 date=2026-11-14 -->
# Float on NEAR — what is true right now

**One page. Hard cap.** If it grows past one screen, something belongs in `docs/` instead.
Long-form reasoning lives in `docs/`; settled calls live in `DECISIONS.md`; **how the parts fit
together lives in `ARCHITECTURE.md`** — the parts, the trust boundaries, where the vault's code
comes from, and the list of what is missing. This file is *current state only*. Update it when
state changes, and re-stamp the commit line above.

## Hackathon status — 2026-11-12

**Golden path is demo-ready on MAINNET, with two steps left for a human to run.**

- **THE MAINNET VAULT IS LIVE AGAIN — recreated by Bashir in the browser, 2026-11-14.**
  `test015-near.usefloat.near`: owner `test015.near`, mainnet, not paused, 2 nodes, **registered
  on USDC**. Root `root` 25/day · 10/tx, allowlist `["test015.near"]`; node 1 `agent` inherits
  25/day · 10/tx. Agent gas key **0.12 NEAR**, `receiver_id` = the vault, `method_names`
  `["request_payment"]` — verified at the protocol level, so it cannot withdraw, cannot call
  `set_node_caps`, cannot reach owner functions. Owner holds **2.28 NEAR + 8.857652 USDC**.
  - **TWO THINGS BLOCK A DEMO VIDEO.** (1) **The vault holds 0 USDC.** (2) **This machine does
    not hold the live agent's secret** — key `ed25519:Aa8pyxNS49uJ…` was generated in the
    browser, so `vault_pay` cannot sign at all, funded or not. `vault_roles` reports it
    correctly: `usable: 0`, `key: "wallet-only (this machine does NOT hold the secret)"`.
    **`STAGED-DEMO-SETUP.ps1`** (untracked, repo root) holds the two round-trip-validated
    mainnet commands: bind a `demo` agent (5/day · 1/tx, key already generated locally at
    `~/.float/agent-keys.json`, public half `ed25519:EJmg2Te2zLnbCZC4wGcV2LE4dkQfPD1ddiYqjSvRG1re`)
    and send 2 USDC in. **Human-run.**
  - **The `float` MCP server was restored to `~/.claude.json`** pointing at this vault with
    `NEAR_VAULT_AGENT_KEYS` pinned ABSOLUTE. **Needs a client restart to appear.**
  - **Pre-video checklist: 4 of 6 pass.** Tools list (27, incl. 14 `vault_plan_*`), reads
    (`vault_config`/`vault_tree`/`vault_budget` all return real chain data), plans-don't-execute,
    and the key restriction. Items 3 and 4 (settle + refuse) are blocked on the two above.
  - *(Historic: the previous vault at this derived id was torn down 2026-11-13; **+3.467730
    NEAR** of the **3.468390** quoted came back, the 0.000660 difference being gas, with the
    agent gas key withdrawn BEFORE the delete so nothing burned; measured against a **settled**
    owner baseline, storage 300,035 → 1,229 B, nothing stranded.)*
  - **ALL LOCAL FLOAT STATE WAS REMOVED** during that teardown, deliberately, so the next run was a
    true cold start: both MCP servers (`float` = `@floatonnear/mcp`, `float-agent` =
    `@usefloat/mcp`, the Solana/Colosseum one), all three `.float/` directories (home,
    `near-vault`, `New project`), `~/.claude/skills/float`, and 8 npx cache entries across
    `@floatonnear` and `@usefloat`. Backed up — **not deleted** — to
    `C:\Users\BASHIR\float-removed-2026-11-13\` because several of those files hold live
    private keys. `~/.near-credentials` was left untouched; it is the NEAR wallet, not Float.
  - **Next step to have a demo again:** create a vault (browser, <https://usefloat.xyz>), fund
    it with USDC, bind an agent (`float-agent` or `vault_add_role`), then re-read the figures.
    The address is DERIVED, so a recreated vault lands on the same id.
  - `DEMO.md` carries a banner saying its numbers are historical. `check-mcp-live.mjs` is red
    (11 failures) and correctly so; `verify-all` is green because the gate never depended on a
    live vault.
  - The dead agent key was pruned from `.float/agent-keys.json` — a recreated vault shares the
    same derived address, so a stale entry could have been handed to `vault_pay` instead of the
    new one and failed like a contract bug.
- **Published `create-float` 0.8.1 ships a SKILL.md that is 49 lines STALE** — including the
  corrected deposit quote. The bundled guide still understates the cost: it lacks the
  with-agent **3.66839** / without-agent **3.54839** breakdown and the "round up, always"
  rule. A user who funds to the understated figure has the transaction **refused by their own
  wallet**, which reads as the product being broken. `SKILL.md` is copied into the package at
  `prepack`, so it only refreshes on a publish. Fix is **prepared as 0.8.2 but NOT published
  — see the blocker below.**
  - **CORRECTION (2026-11-13):** an earlier revision of this file claimed the published
    0.8.1 shipped *older code* (`step(0, "Keys")`, no token-metadata rendering). **That was
    wrong.** It came from diffing against an arbitrary **npx cache directory** — one of 8,
    holding an older version — instead of the published tarball. Checked properly against
    `npm pack @floatonnear/create-float@0.8.1`: **22 of 24 files are byte-identical**,
    including `bin/float-exit.mjs`. Only `SKILL.md` and `package.json` (the version field)
    differ. The lesson is the one this repo keeps re-learning: **an npx cache entry is not
    the published artifact** — compare against the tarball the registry serves.
- **BOTH PACKAGES ARE PUBLISHED AND VERIFIED FROM THE REGISTRY (2026-11-14).**
  `@floatonnear/mcp` **0.10.2** and `@floatonnear/create-float` **0.8.2** are live. Verified by
  **downloading each tarball and diffing it**, not from a publish success message:
  mcp's published `dist/server.js` contains `resolveKeyringPath`, `retireRole` and
  `Nothing was written`; both packages' bundled `SKILL.md` is byte-identical to the repo's, as
  are create-float's `bin/float-exit.mjs` and `bin/create-float.mjs`.
  (Publishing needed a human: the account has 2FA, so `npm publish` returns `EOTP`. Omitting
  `--otp` lets npm authenticate in a browser — no code to type.)
  - **PROVEN LIVE FROM A COLD npx INSTALL**, which is the only claim that matters to a user.
    A fresh `npx -y @floatonnear/mcp` (cache cleared) reports version **0.10.2**, and the exact
    failure that used to strand a key — `vault_add_role` with no token configured — returns
    *"Nothing was written — no key was generated"* and **creates no keyring file at all**. The
    orphan is gone from the published artifact, not just the working tree.
  - The verifier is **positive-controlled against the known-bad 0.10.1**: all four detectors
    fire there (three missing strings, plus a differing `SKILL.md`), so the green result is
    meaningful rather than vacuous.
  - It took three attempts because the verifier kept failing on its own plumbing — a
    shell-mangled `node -e` path, then GNU tar reading `C:\...` as a remote host — and the
    first version counted those as "the registry does not serve this repo's code". It now
    separates **BROKEN** from **INCONCLUSIVE**. *A broken check that reports itself as a
    finding is worse than no check.*
- **UX LOCK: every user-facing tool now returns `say` / `next_step` / `money_moved` (2026-11-14).**
  `vault_pay` already did; every other tool returned raw technical keys, so driving agents narrated
  public keys, gas keys and unsigned payloads at people who had asked for a budget. Now also
  `renderPlan` (**all 13 `vault_plan_*` tools at once**), `vault_add_role`, `vault_budget` and
  `vault_await_create`. Technical detail moved under `technical`, never deleted;
  `unsigned_payload` stays top-level because `check-mcp-live.mjs` asserts on it.
  - **SKILL.md's voice rules moved to the TOP, before the tool tables.** They already existed — at
    line 308 of ~29 KB, *after* the tables an agent follows mid-task, which is indistinguishable
    from absent. New `## How you talk to the human (non-negotiable)` section with Always/Never
    lists, five templates and a before/after table; the old section is now a pointer so the two
    cannot drift. Guarded by **gate check 40, `check-ux-voice.mjs`**, which asserts the section
    exists, is positioned before the tool tables, keeps its specifics, and that every tool the
    rules promise a `say` from actually returns one.
  - **Two leaks found by DRIVING the tools and reading the sentences**, not by the jargon list — *a
    forbidden-word list cannot catch a forbidden shape.* `vault_add_role` said "1 usdc.testnet a
    day" (`label()` returns `SYMBOL (id)`, right for a field, wrong in prose; on mainnet it renders
    USDC's **64-hex-character** id), and `vault_plan_add_node` put the full id in its sentence
    because `payloads.ts` is pure and cannot resolve symbols. Added `displaySymbol()` (falls back
    to "tokens", never an id) and symbol substitution in `renderPlan`'s `say` only. The smoke test
    now uses mainnet USDC's real id, because the original used `usdc.testnet` — short enough to
    look harmless while the tool printed a hash at users.
  - **Plan summaries no longer speak TREE vocabulary (2026-11-14).** `planVoice` copies
    `summary` verbatim into `say`, so every plan tool said "node 1" / "Freeze node 0" — a
    contract primary key shown to someone who called the budget "news". Fixed at the source:
    `payloads.ts` gains `budgetName()` + an optional `nodeName` on the eight node-scoped
    builders, and `resolveNode()` (replacing `assertNode`) returns the label **the same tree
    read was already fetching and discarding** — no extra view call. Root is always "the main
    budget" because the contract hardcodes its label to the literal `"root"`.
    **Degraded case named, not hidden:** `Node.label` is a required `String` on chain, so a
    missing name means the tree READ failed and two budgets then read identically — real loss of
    distinguishability, kept safe because `node_id` is still in `args`, which is what the wallet
    displays and the owner signs.
    **The first guard was inadequate and a mutation proved it:** it checked one tool driven over
    stdio, so restoring the leak in `planSetNodeCaps` passed 85 tests. Replaced with a sweep over
    **all 16 plan builders** (summary *and* warnings) plus a coverage test that fails when a new
    builder is added without one. No payment logic touched — `contracts/`, `sign.ts`, `amounts.ts`
    untouched.
  - **423 tests, 42 gated checks.** All mutation-verified: disabling the substitution, re-planting
    the leak, or removing `say` turns the right test red.
- **AGENT KEYS ARE NOW SECURE BY DEFAULT — `vault_add_role` writes NOTHING unless asked
  (2026-11-14).** It used to generate a keypair on this machine **always**, writing a live
  spending key to disk as a side effect of asking for a budget — no opt-in, no disclosure.
  New `key_location`, default **`wallet`**: nothing is written and the refusal *is* the
  instructions (keep the key yourself → hand over the public half → `vault_plan_bind_agent`,
  or ask again with `local`). `local` generates here and **discloses it in the same breath as
  the bound**. The wording was then strengthened (`d787fa6`) to lead with the CAPABILITY rather
  than the file, and it now reads, verbatim:
  > *WORTH BEING CLEAR: this machine will now hold a spending key for your vault. Once you
  > approve, it can spend up to 5 USDC a day, 1 at a time, WITHOUT asking you again. It cannot
  > withdraw your money. It cannot change any limit, including its own. It cannot do anything
  > else an owner can. That is **NEAR enforcing it, not a rule I follow** — the key is locked to
  > a single payment request on this one contract, and anything else it tried would simply be
  > refused.*

  The three "cannot"s are separate sentences because each answers a different fear (empty the
  vault / raise its own allowance / act as me), and the last clause is the load-bearing one: an
  AI saying it has *voluntarily* limited itself is worth nothing. SKILL.md quotes the whole
  paragraph and says **relay it whole, do not summarise it into "the key is restricted"**.
  The method NAME is deliberately kept out of user-facing text; it stays in the payload.
  - `vault_roles` now names WHERE the secret lives — `key: "local (this machine holds the
    secret)"` vs `key: "wallet-only (this machine does NOT hold the secret)"`. It reported
    `status` alone, so "usable" and "the secret is on this disk" were one label.
  - `vault_pay` with no local key no longer throws a keyring stack trace: it says the machine
    holds no key, that this is **usually on purpose**, and offers both paths. The env-var
    detail moved under `technical` — the first version appended `(technical: …)` to the
    sentence and put `NEAR_VAULT_AGENT_ID` in front of someone asking to pay a vendor, which
    is exactly what SKILL.md's Never list forbids. Pinned by a test.
  - **Mutation-verified:** disabling the wallet branch turns *"the DEFAULT writes no key"* and
    *"the two paths differ ONLY by the parameter"* red. The differ-test exists because
    otherwise both halves could pass for the wrong reason. **427 tests, 42 gated checks.**
  - **DEFERRED:** `create-float --agent-key local` and the `add-local-agent` migration command.
    They touch a separately published CLI and would add a second publish to the critical path
    with ~14h to the deadline. `DECISIONS.md` records why.
- **`mcp 0.10.5` IS PUBLISHED AND VERIFIED (2026-11-14). `0.10.4` IS BROKEN — nothing points
  at it.** Verified not from a publish message but by **downloading the tarball and comparing
  `dist/server.js` byte-for-byte against a fresh local build** — identical. Cold
  `npx -y @floatonnear/mcp` (cache cleared) reports **0.10.5**, `vault_add_role` writes **no
  key** by default, and `keyLocation: "local"` emits the full disclosure including *"NEAR
  enforcing it"*. `create-float` stays at **0.8.2**, also verified byte-identical.
  - **Why 0.10.4 is abandoned:** it reached the registry *missing* the strengthened disclosure.
    The version was bumped in `39d0bab`, the disclosure changed in `d787fa6`, and the publish
    landed between them — 125,426 published vs 127,119 bytes fresh. npm will not let a version
    be reused, so the number is permanently wrong. That was the **third** same-version
    divergence in one session (0.8.1, 0.10.3, 0.10.4).
  - **Two guards so it cannot recur.** `publish-and-verify.mjs` now (a) **refuses to publish
    from a dirty or unpushed tree** — the state that lets a bumped version be taken with
    half-finished source, verified firing on the real tree; and (b) **compares the published
    build byte-for-byte against a fresh one**, replacing the hand-maintained marker list as the
    primary proof. `tsc` output is byte-deterministic here (two clean rebuilds, identical
    127,119 B), positive-controlled against the stale 0.10.4.
  - **A publish can look un-landed for minutes.** The first `--verify` after 0.10.5 shipped saw
    nothing; the packument read directly showed it. Registry propagation, not a failed publish —
    check `registry.npmjs.org/<pkg>` before concluding, as the memory on `npm view` staleness
    already says.
  - **Trap found here:** `tsc` PRESERVES source-level string concatenation, so a phrase split
    across a `+` — `` `That is NEAR ` + `enforcing it` `` — never appears as a contiguous
    substring in the emitted JS even though the runtime output contains it. Grepping for it
    reports MISSING for a good build, identical to the feature being absent. Markers must be
    single identifiers, never sentences.
- **NESTED AGENTS ARE NOW ONE APPROVAL — COMMITTED, *NOT RELEASED* (2026-11-14).** `add_role`
  takes an optional **`parent`**. It is the only method that composes node + key + **funded gas
  key** atomically, and it hardcoded root — so an agent under a department fell onto
  `add_node` + `bind_virtual_agent`, **neither of which touches gas keys**, producing a key that
  could authorise a payment and never submit one (`BOUND_BUT_NO_GAS_KEY`), repairable only via
  `float-agent` from a terminal. Hit live: `digest` under `news` cost 2 approvals + a CLI step;
  `marketing` under root cost 1. Routes through `insert_node`, which already owns parent-exists,
  `MAX_DEPTH`, `MAX_CHILDREN` and strict allocation. Omitting the argument still means root, and a
  root-level payload carries **no `parent` key at all** — byte-identical to previous releases.
  Backward compatibility is tested **at the serde layer**, because a unit test calls the Rust fn
  directly and can never see the generated wrapper (the `#[payable]` lesson). Mutation-verified.
  **170 contract tests (+5), 441 MCP tests, 42 gated checks.**
  - **⚠ THE BUNDLED WASM IS DELIBERATELY STALE.** Shipping means new bytes reach *every future
    vault*, and the change is unexercised on any chain. It cannot help the existing vault (which
    runs deployed code) or the demo. **Release AFTER submission**, and create a testnet vault and
    nest on it first. `create-float`'s prepack already refuses to publish until someone rebuilds
    on purpose: `cd contracts/vault && cargo near build non-reproducible-wasm --no-abi`, then
    `BUNDLE_WASM_RERECORD=1 node packages/create-float/scripts/bundle-wasm.mjs` — note that
    bundler lives under the PACKAGE, not in the repo-root `scripts/`.
- **BUDGET-TREE BARS FIXED AND DEPLOYED (2026-11-14).** The master "Used today" bar never moved.
  The numbers were right: the API rounds `dailyBudgetUsedPercent` to an integer, so a real
  **0.02 USDC against the 25 USDC master = 0.080%** arrived as `0`, and the card printed
  *"0.02 spent today"* above *"0%"* and an empty track. Measured live: root **0.080%**, news
  **0.667%**, headlines **4.000%** — only the last survives rounding, exactly what was reported.
  `apps/dashboard/lib/utilisation.ts` now computes from the raw spend and cap the page already
  receives, returning a **label** (`<1%` — never overstates) and a **barWidth** (minimum sliver —
  signals that something moved). Mutation-verified; 227 dashboard tests.
  - **LIVE at <https://app.usefloat.xyz/agents>.** The dashboard is a Next.js service
    (`float-near-dash`, `npm run start`, `WorkingDirectory=/srv/float-near-web/apps/dashboard`),
    so **a git pull alone does nothing** — it serves a pre-built `.next`. Deploy is: pull, then
    `sudo -u float npm run build` in `apps/dashboard`, then `systemctl restart float-near-dash`.
    Verified by fetching the served chunk and finding `<1%` in it, not by trusting the restart.
    `find /srv/float-near-web -user root` → **0**.
- **`bind_virtual_agent` DOES NOT INSTALL A GAS KEY — `add_role` is the only contract function
  that does.** Measured 2026-11-14 while building a bind link for the `news` node: binding only
  inserts into `pubkey_to_node`, which grants AUTHORITY and no ability to submit. The key would
  have shown as `BOUND_BUT_NO_GAS_KEY` and every payment would have failed. **So a two-step
  create-then-bind leaves a non-working agent** unless `float-agent` (CLI) installs and funds the
  gas key afterwards — which is itself a CLI job, because installing a key means signing AS THE
  VAULT and browser wallets ignore `signerId`. This is the strongest practical argument for the
  one-approval `add_role` path: the two-step route is not merely slower, it is **incomplete**.
- **CREATING AN AGENT IS NOW ONE APPROVAL, EVEN WHEN YOU KEEP YOUR OWN KEY (2026-11-14).**
  `add_role` creates the node, binds the key and installs the funded gas key in a **single
  contract call** — the chain could always do it in one. The wallet path degraded into
  `add_node` + `bind_virtual_agent`, two wallet signatures, only because `vault_add_role` had
  nowhere to accept a user-generated key. It now takes **`publicKey`**; supply the public half
  and the whole agent is created in one approval. **Key generation is local-path-only** — making
  one "just in case" would put a live spending key on disk for someone who asked to keep their own.
  - **`vault_add_role` also returns `approve_here` now.** The link was added to `renderPlan`,
    which covers the thirteen `vault_plan_*` tools — and `vault_add_role` has its **own return
    block**, so the one tool people reach for to create an agent still handed back a raw payload.
    Found only because Bashir asked twice whether the link also binds. Verified by decoding a live
    link: one `add_role` call carrying `label`, `public_key` and the 0.12 NEAR gas deposit.
  - **The disclosure branches by path.** On the wallet path this machine *cannot* spend, so
    claiming "this machine will now hold a spending key" would have been the most misleading
    sentence in the response. It now says the secret stays with you; the protocol-level bound is
    stated either way, and `credentialWrittenTo` is omitted rather than naming a file never written.
  - **Ships in mcp 0.10.6** — npm has 0.10.5. **439 tests, 42 gated checks.**
- **PLAN TOOLS NOW RETURN AN APPROVAL LINK, not just a CLI command (2026-11-14).** Asked for a
  news budget, the agent handed back a 300-character `near contract call-function as-transaction
  … sign-with-keychain send` line. The create page has accepted owner-action links all along
  (`?action=<base64url JSON>`, **15 methods**) and nothing built one — so the product's own pitch,
  *the human approves in their own wallet*, was contradicted by its main output. `renderPlan` now
  returns **`approve_here` first** and `next_step` names it; `approve_with` stays as fallback.
  - **`withdraw` has NO link, by design.** The page's allowlist refuses it — a link is something a
    stranger can send you — so `approveUrl` returns `null` and the note explains. A URL the page
    rejects is worse than none: the user clicks, is turned away, and reads it as a broken product.
  - **Encoding is UTF-8, not latin1.** `web/index.html` documents why in its own decoder: `btoa`
    throws above U+00FF, and a node **label is user-chosen**. Getting it wrong does not throw — it
    hands the page mojibake, so *the owner approves a transaction whose description is wrong*.
    Tested with CJK, accents, smart quotes, emoji. Network is pinned explicitly, because the page
    defaults to mainnet and a testnet payload would render a believable screen on the wrong chain.
  - **Gate check 42, `check-approve-url-methods.mjs`**, compares the MCP's mirrored allowlist to
    the page's in BOTH directions, plus a third list of what the builders actually emit, so a new
    CLI-only method cannot appear unnoticed. Controlled both ways. Tests decode the way the PAGE
    does, reimplemented from the page rather than from the encoder.
  - **NOT PUBLISHED.** Ships in **mcp 0.10.6**; npm has 0.10.5. The link handed to Bashir for the
    `news` budget was built by hand with the same encoder and is valid.
- **THE CREATE PAGE REFUSED TO WORK FROM ITS OWN PUBLISHED LINK — fixed in the repo, NOT YET
  DEPLOYED (2026-11-14).** A bare <https://usefloat.xyz> answered *"This link has no factory, so
  there is nothing to create the vault."* That is the link in the README, on npm, and in anything
  shared — so the first thing a new user or judge saw was a refusal. The page read `?factory=`
  with **no fallback**, which was correct while no mainnet factory existed (a guessed id sends a
  real ~3.5 NEAR deposit to an unverified account), and nobody revisited it when `usefloat.near`
  went live. Now `DEFAULT_FACTORY` resolves per network from the same values the MCP uses;
  an explicit `?factory=` still wins. Verified by evaluating the real constant lines out of
  `index.html` against four query strings.
  - **Gate check 41, `check-create-factory-default.mjs`**, compares the page's defaults to
    `FACTORY_BY_NETWORK` in `create.ts`. They cannot share a constant — one is TypeScript in a
    published package, the other a `<script type="module">` served statically — so the value is
    duplicated, and it had already drifted in the worst direction. Positive-controlled both ways.
  - **DEPLOYED AND VERIFIED 2026-11-14.** `usefloat.xyz` serves `DEFAULT_FACTORY`, so a bare
    link now resolves the live factory instead of refusing. **`usefloat.xyz/skill.md` was also
    stale and is now current** — it served **34,333** bytes against 43,623 in the repo, missing
    the whole voice section; `check-live-docs.mjs` passes on both targets.
    - The pull was blocked by two **generated** artifacts drifting on the box
      (`package-lock.json`, `apps/dashboard/next-env.d.ts`). The diff was inspected before
      discarding, not reset reflexively: the lockfile pinned `0.8.0`, *older* than the repo's
      `0.10.5`, which is what confirmed them leftovers rather than work.
    - Every git command ran as **`float`**, the tree's owner, never root.
      Verified after: `find /srv/float-near-web -user root | wc -l` → **0**.
    - Deploys now use an installed **ed25519 key**, so they no longer need an interactive
      password. `web/serve.mjs` reads per request, so a pull is enough — no restart.
  - Also corrected the deploy command `check-live-docs.mjs` prints: it said
    `ssh root@… 'cd /srv/float-near-web && git pull'`, which runs git as **root** in a
    service-owned tree and leaves root-owned `.git` files the service cannot write — silent
    degradation later rather than a failure now.
- **`usefloat.xyz/skill.md` IS NOW THE CANONICAL GUIDE LINK, and the repo has a LICENSE.**
  The README pointed at `raw.githubusercontent.com` only because the hosted copy was stale;
  it is deployed and gate-guarded now, so the short branded URL is the one to publish. Served
  as `text/plain` so an agent gets bytes rather than a rendered page; GitHub raw and
  `app.usefloat.xyz` kept as mirrors.
  - **LICENSE (MIT) added.** All three published packages have declared `"license": "MIT"` on
    npm for weeks while the repository itself said nothing — npm was asserting a licence the
    repo did not carry. The file and the root `package.json` now match that existing public
    declaration. **Aligning with it, not choosing it**; one commit to revert if a different
    licence was intended.
- **README REWRITTEN for the now-public repo (2026-11-14).** It leads with the PROBLEM — every
  agent wallet hands the agent the key and asks you to trust it — because the design only looks
  interesting once you see what it refuses to do. **Four mermaid diagrams** (GitHub renders
  them): the trust boundary with the four refusals attributed to the protocol; the budget TREE
  charging every level, which is why `PARENT_DAILY_BUDGET` is its own answer; a sequence diagram
  carrying **both** outcomes with the real plain-English sentences; and the `key_location`
  choice. New sections for the `say`/`next_step`/`money_moved` shape and the key disclosure.
  **Every figure re-measured rather than carried over** — the old one said "37 checks" (it is
  40) and gave no test count. Now **1,120 tests** counted per package (427 MCP + 262 CLI + 230
  adapter + 165 vault + 36 factory), 41 live reason codes, `MAX_DEPTH 4` read from `types.rs`,
  deposit **3.66839** with an agent / **3.54839** without. Limitations kept and made *more*
  prominent, including that cross-chain is implemented but **NOT demonstrated on mainnet**.
- **`npx … > file 2>&1` SILENTLY RUNS NOTHING on this box** (exit 0, zero bytes, no effect).
  Measured three times, including `--help`, and once on the real teardown — the vault was
  **still fully intact** afterwards while the command reported success. Piping (`| tee`) works;
  `node <bin>.mjs > file` works. The teardown above was therefore run through `node`, and
  confirmed by **querying the chain**, not by the exit code. Recorded in project memory as
  `npx-with-stdout-redirected-silently-does-nothing`.
- **Every surface now defaults to mainnet** (was: CLIs mainnet, MCP/adapter/page testnet).
  `scripts/check-network-defaults.mjs` fails the gate if the eight of them drift apart.
- **NO MCP SERVER IS CONFIGURED RIGHT NOW** (2026-11-12, deliberate — reinstalling from
  scratch alongside the vault). `.mcp.json` was deleted, and `float` was removed from
  `~/.claude.json`. Both were the SAME product: the repo's local `dist/server.js` and
  `npx @floatonnear/mcp`. **`float-agent` was kept** — it is `@usefloat/mcp`, a different
  product (Solana/Twitter/swap tools) for the Colosseum work, and a "remove the float MCPs"
  instruction should not take it.
  - **Local Float state is wiped too**, so a fresh session meets the product as a new user
    does: `.float/` (agent keys, `adapter.env`, fixtures), the deleted vault's refusal log, and
    the `~/.claude/skills/float` skill are all gone.
  - Everything is backed up to **`~/float-reset-backup/`** — deliberately OUTSIDE the repo, so
    a fresh run cannot see it. Contains `dot-float/`, `claude-skill-float/`, the blocked log and
    `~/.claude.json.float-backup`. `~/.claude.json` itself was edited surgically; it carries
    project history and three unrelated servers.
  - **NEAR CLI credentials were NOT touched.** `~/.near-credentials/mainnet/` holds
    `test015.near.json` (the owner, 5.797730 NEAR) and `usefloat.near.json` (the operator key
    for the LIVE mainnet factory). Deleting those would cost the factory and real money, and the
    browser path needs no CLI credential, so they do not contaminate a new-user test.
  - The one difference a reset cannot remove: this is a developer machine with the full repo.
    A real new user has only the npm package and a wallet.
  - Reinstall: point a client at `npx -y @floatonnear/mcp` with `NEAR_VAULT_NETWORK=mainnet`,
    `NEAR_VAULT_FACTORY=usefloat.near`, and `NEAR_VAULT_CONTRACT` **empty** — `vault_create`
    needs no vault and no key, which is the real first-run path.
  - `drive-mcp.mjs`, `settle-baseline.mjs` and `show-agent-key.mjs` all now say "no `.mcp.json`
    … configure one" instead of stack-tracing. They work again once it exists.
- `README.md` and `DEMO.md` exist. `DEMO.md` is the 90-second script.
- `vault_await_create` now refuses to call a FACTORY a live vault (`vault_id` is the
  discriminator); all four states re-verified against mainnet.
- One config name: the adapter's offline fallback read `NEAR_NETWORK`, now `NEAR_VAULT_NETWORK`.
- **PATH A IS VERIFIED END TO END ON MAINNET, 2026-11-12.** Both halves:
  - UNDER cap: 0.25 USDC -> **SETTLED** (`bdac52f8-3416-4c9d-b865-70091f63582b`), charged
    chain `[0,1]` so node 1 AND root both read `executed 0.25 / available 24.75`.
    Recipient credited 0.25. Vault now holds **0.750000 USDC**.
  - OVER cap: 15 USDC -> **`PARENT_PER_TX_LIMIT`**, nothing moved, `get_request` null
    (blocked payments are not stored). `node scripts/prove-refusal.mjs 15 test015.near`
    reproduces it and refuses to sign any amount that could actually settle.
- **Gas accounting CLOSED** (was amber): settled before/after in exact yocto showed the agent's
  gas key paying **0.000866 NEAR** while the vault's `amount` moved **-1 yocto** — the NEP-141
  `ft_transfer` deposit the vault must attach and the agent's key cannot. Storage grew 667 B,
  which stakes against the balance rather than deducting from it. See `DECISIONS.md`.
- **Refusals and successes now speak plain English** (2026-11-12). `vault_pay` returns
  `say` / `next_step` / `money_moved`, with the contract outcome under `technical`. A user
  never sees `PARENT_PER_TX_LIMIT`; they get *"That's too big for one payment — the most per
  payment is 10 USDC, and this asked for 15. Nothing was sent."* Built in the SERVER, not the
  prompt, because the good sentence needs caps the payment response never carried. The codes
  are kept (they are a differentiator) and the instructions still teach the
  `DAILY_BUDGET` vs `PARENT_DAILY_BUDGET` difference while forbidding printing it.
  See `packages/mcp/src/explain.ts` and `DECISIONS.md`.
- **Merged to `main`** (2026-11-12). All of the above was on `docs/map-the-surfaces` for 23
  commits, so the repo's front page had no README. Main now carries everything.
- **Git history is CLEAN of secrets** — 3393 text blobs across all refs, verified with a
  planted-secret control (`node scripts/scan-history-secrets.mjs`). This is the pre-flight for
  making the repo public — **DONE 2026-11-14, the repo is now PUBLIC** (`isPrivate: false`), so
  the hackathon qualification requirement is met. History was scanned clean beforehand.
- **PUBLISHED 2026-11-12 and verified from the registry**: mcp **0.9.0**, create-float
  **0.8.0**, adapter **0.3.0** (were 0.6.5 / 0.6.1 / 0.2.1). So `npx -y @floatonnear/mcp` now
  gets mainnet by default and plain-English refusals instead of raw reason codes.
  Verified by INSTALLING EACH FRESH FROM npm and checking the shipped artifact, not the version
  number: explain.js present with the real copy, instructions forbid printing codes, mainnet
  default, unknown network fails closed, `float-retire` finally in `bin` at all, and the shipped
  wasm is still the mainnet-validated `dc7a3fb6…`.
- **Gotcha worth keeping: `npm view` serves stale metadata for minutes after a publish.** It
  reported 0.6.5 with `--prefer-online` while the registry already had 0.9.0, and `npm install`
  failed `ETARGET` for a version that existed. To check a publish, hit
  `https://registry.npmjs.org/<pkg>` directly, or `npm cache clean --force` first.
- GitHub description updated (the old one still advertised the retired Chain Signatures/Base
  rail). Repo has no topics and no website link yet — `usefloat.xyz` is live.
- **Cold-install feedback acted on 2026-11-12** (a first-time install against
  `usefloat.xyz/skill.md`): the documented `claude mcp add float -- npx …` **fails on Windows
  PowerShell** (swallows `--`, `claude` then rejects `-y`) — fixed to `"--"`, tested; the tool
  count said ~23 against a real **27** and is now test-pinned; the ~29 KB file gets lossily
  summarised by fetchers so the JSON config block is hoisted to the top; and the `float` name
  collides with `@usefloat/mcp`.
- **Cold-start error is now an onramp.** `NEAR_VAULT_CONTRACT is not set` became a message that
  names `vault_create`, says NO KEY is needed, covers the have-a-vault-but-unconfigured case, and
  tells the agent not to hunt for another rail. Found by a real agent that hit the old message and
  went searching three unrelated wallets instead of offering to make a vault — the WORKFLOW
  preamble already said the right thing, which is the point (see `DECISIONS.md`).
  **Live in mcp 0.9.1** — verified against the published package, see below.
- **LIVE DOCS FIXED AND VERIFIED 2026-11-12.** The box was on `87a4559` — ~5,000 lines behind,
  with no README, ARCHITECTURE, DEMO or FLOAT docs at all — and served a `skill.md` 4 KB older
  than the repo, which is why a second cold install reported the same four defects word for word.
  Pulled to `c643725` as the `float` service user (NOT root: git's `safe.directory` suggestion
  would have left root-owned objects in a service-owned tree). `find -user root` → **0**.
  - Verified live, not assumed: both `usefloat.xyz/skill.md` and `app.usefloat.xyz/skill.md` are
    byte-identical to the repo; the create page serves 200 with the connect screen, the mainnet
    default and the agent-key consent gate; and **`vault.wasm` live == repo (`Fqep3KLe…`)**.
  - `node scripts/check-live-docs.mjs` (green) and `node scripts/check-live-page.mjs` are the
    post-deploy pair. Neither is in the gate — both need the internet and a live host.
  - **The wasm check is load-bearing**, not cosmetic: nothing on-chain pins the vault build
    (`ARCHITECTURE.md` §4), so the code a user's vault runs is whatever that page serves.
  - Open, nobody has decided: the apex serves `skill.md` as `text/plain`, `app.` as
    `text/markdown`. `serve.mjs` intends plain text; the deploy asserts it for the apex only.
- **ALL THREE PACKAGES PUBLISHED AND VERIFIED, 2026-11-12 18:45 UTC.** mcp **0.9.1**,
  create-float **0.8.1**, float-adapter **0.3.0**. Verified by installing fresh FROM THE REGISTRY
  — not the local build — and reading the shipped bytes: 11/11 for the no-vault onramp,
  plain-English refusals, the never-show-a-code rule, the mainnet default, and in create-float's
  bundled `SKILL.md` the up-front vault offer, the 3.55-and-refundable wording, the PowerShell
  install fix, the 27-tool count and the restart note. `float-retire` is now installable.
  - **The cold-start dead end is fixed for real users**, which is the check worth having run:
    `node scripts/drive-mcp.mjs --published vault_config '{}'` returns the onramp naming
    `vault_create` and "needs NO key", where it used to return `NEAR_VAULT_CONTRACT is not set`.
- **THE OPERATING GUIDE IS NOW AN MCP RESOURCE — staged, NOT yet published.**
  mcp **0.10.0** registers `float://skill` and serves the full ~34 KB SKILL.md on demand, so a
  real user gets the depth without a repo or a skill mechanism. It ships inside the package
  (`files`), copied by the BUILD not just `prepack`, the instructions name it, and a missing
  guide throws rather than returning empty. Verified against the built server: `resources/list`
  → one entry, `resources/read` → 33,784 bytes with the refusal table, teardown order and vault
  offer; removing the file errors loudly. Why a resource and not a skill install or a tool:
  `DECISIONS.md`.
  - **float-adapter bumped to 0.3.1** solely because its `^0.9.0` on mcp would NOT accept
    0.10.0 — a caret on a 0.x range pins the MINOR. Now `^0.10.0`.
  - **Needs publishing** (superseded — see the blocker near the top): the pending versions are
    now **`mcp 0.10.2`** and **`create-float 0.8.2`**; `float-adapter 0.3.1` is already live.
    No server pull needed; the live `skill.md` is unaffected.
- **The operating guide now ships as an MCP resource** (`float://skill`), so a real user gets the
  depth without a repo or a skill install — verified by reading it back from the PUBLISHED
  `@floatonnear/mcp@0.10.0`: 33,784 bytes of markdown. Published: mcp **0.10.0**,
  float-adapter **0.3.1** (its `^0.9.0` would not have accepted 0.10.0 — caret on 0.x pins the
  MINOR), create-float **0.8.1**.
- **Fixed an UNDERSTATED cost in the vault offer.** SKILL.md quoted 3.55 NEAR, the no-agent
  figure, while the default path binds an agent and really needs **3.66839**. A user funding to
  the quote has the transaction refused by their own wallet. Now quotes **3.7** (rounded up) and
  `create.pins.test.ts` fails if the quoted figure drops below the with-agent total.
- **GOLDEN-PATH BREAK FOUND AND FIXED STRUCTURALLY, 2026-11-13: a browser-created vault could
  not be funded.** A NEP-141 transfer to an unregistered account FAILS; the CLI wizard registers
  the vault on its token, the browser path did not, and the browser path is the one strangers
  use. So "send it some USDC" — step 4 of Path A — was broken for every vault made through the
  page, and `SKILL.md` had no funding section to warn anyone. Measured on
  `test015-near.usefloat.near`: LIVE, owner verified, `storage_balance_of` → **null**.
  - `create_vault_with_code` now fires `storage_deposit` on every token in `root_limits`, in the
    transaction the user already signs. A SEPARATE promise, not an action on the batch: the
    batch's receiver is the vault and the deposit must reach the token — and independent failure
    is the safer shape, since a chained one would revert the whole creation and charge the user
    gas for nothing. See `DECISIONS.md`.
  - The deposit floor rises by the registration and the same amount is held back from the
    vault's transfer, because **every receipt a factory schedules is funded by the factory** —
    the drain already documented for the gas key. **No user-facing figure moves**: floor with an
    agent and 4 tokens is 3.21339 against the page's 3.46839, and a new pin fails if the floor
    ever overtakes the headroom.
  - **DEPLOYED TO MAINNET 2026-11-13.** `usefloat.near` now runs **166,841 B / `02323ecc…`**
    (was 164,596 / `ec28be51…`). No migration was needed and that was verified, not assumed: the
    `Factory` struct gained no field, so borsh layout is unchanged. The artifact was REBUILT
    before deploying and reproduced `02323ecc…` byte-for-byte, because mtime has lied in this
    repo before.
  - **PROVEN LIVE BY THE PRODUCT'S OWN BEHAVIOUR, not by its hash.** The deploy printed 5/5
    (hash, owner, network, paused, key) — which is exactly the suite
    `deploy-checks-that-never-try-the-product-action` records passing on a factory that could not
    create a single vault. So: a probe attached **0.101 NEAR** against a 1-byte code, which sits
    ABOVE the old floor (0.10001) and BELOW the new one (0.10126). The contract panicked
    `DEPOSIT_TOO_SMALL`, which only happens if the registration term is in the live floor. Safe
    either way — `begin()` panics before scheduling any receipt. `.demo/probe-registration-floor.mjs`.
  - **The old unregistered vault was TORN DOWN 2026-11-13** to fund the proof and because it
    could not be funded anyway. `test015-near.usefloat.near` is DELETED; reconciled against the
    chain, not the script's summary: NEAR **+3.467992** of 3.468390 quoted (0.000398 = gas
    across the six steps), USDC unchanged, nothing stranded. Storage shrank 300,035 -> 1,229 B
    before the delete. Owner now holds **5.781862**, so a vault is affordable again.
  - **PROVEN END TO END ON A REAL VAULT, 2026-11-13.** Recreated through the fixed factory and
    all three pre-committed checks PASS:
    (1) `get_config.owner` = `test015.near`, read from the contract rather than inferred from the
    address existing; (2) **`storage_balance_of` = `{total: 1250000000000000000000}`** — exactly
    `TOKEN_REGISTRATION`, so the factory registered the vault on USDC inside the signed
    transaction; (3) the agent key `ed25519:EUNSWPmaiHisn2uXDVqDtY5gnE2XXdQB5GMFLs7zYpGu` carries
    `receiver_id` = the vault, `method_names` = `["request_payment"]`, balance 0.12.
    **The golden-path funding break is closed**: funding is now a plain wallet send, no
    registration step, no "account not registered" failure.
  - **`vault_await_create` now TELLS the owner how to fund it**, derived from live state rather
    than a fixed list. It used to end "nothing can spend from it until an agent is bound", which
    is false for a vault created with `bindAgent` — the agent relaying it had to correct the tool
    in front of the owner. It now returns a `funding` block (token, symbol, balance,
    `registeredOnToken`, `sendTo`) and next steps that name the ACTUAL gate: register first if
    unregistered (that one makes a transfer FAIL), else FUND IT with the address and an
    instruction to ASK how much, else bind an agent, else ready. The token is read from the TREE,
    because at creation time `NEAR_VAULT_CONTRACT` is unset and the configured token is empty.
- **`SUBMISSION.md` is drafted and ready to paste** (track **Agent Economy**, description
  verified at 1,947 chars inside the 20–2,000 limit, X demo-post draft, and a judge-verifiable
  claims table). Official requirements confirmed from <https://nearhackathon.com/>: form takes
  project name / team lead / email / team size / track / NEAR wallet / repo link / demo post link
  / description / website; **the repo MUST BE PUBLIC**; the demo must be an X post tagging
  @NEARProtocol with #NEARHackathon and a video or screenshots; judging is technical
  implementation, design, impact, originality, sustainability — **with an AI screening first to
  verify the project runs as described**, which is why every figure in the draft is measured and
  §6 lists what is deliberately NOT claimed.
- **`vault_roles` NOW ANSWERS FROM THE CHAIN, not from the keyring file.** It reported
  `listAgents(cfg)` verbatim — role, nodeId and all — without ever asking the vault whether it
  had heard of those keys. A keyring pointed at the wrong directory therefore reported a healthy,
  signable agent on node 1 that the vault did not know, `vault_pay` signed with it and came back
  `NOT_VIRTUAL_AGENT`, and the vault was unspendable for hours with nothing noticing. Cost a user
  a whole session of forensics to find one wrong path. Every entry is now resolved against
  `get_virtual_agent_node` and the access-key list, with statuses **USABLE / DEAD /
  BOUND_BUT_NO_GAS_KEY**, plus `onChainWithoutLocalKey` (an agent the vault has and this client
  cannot sign as), `unreadableKeyringEntries` (previously dropped in silence) and a loud warning
  when NOTHING is usable. Verified both ways against mainnet.
- **`vault_add_role` NO LONGER LEAVES AN ORPHAN, AND NO LONGER MOVES WITH THE WORKING
  DIRECTORY (2026-11-13).** Three defects, one symptom — a key on disk that nothing could use,
  and a retry refused because of it. (1) It generated and **wrote** the keypair, then built the
  payload, which validates the token and can throw; a call that failed validation filed a real key
  bound to nothing, and the retry was refused citing the wreckage of the attempt that had failed
  seconds earlier. Validation now runs first against a placeholder, so a failure writes nothing
  and says so. (2) The keyring default was the **relative** `.float/agent-keys.json`, resolved
  against the server's CWD — wherever the client was launched. Measured: `NEAR_VAULT_AGENT_KEYS`
  is unset for the configured `float` server, and `New project/.float` vs `near-vault/.float` hold
  **different keys for the same vault**. `keyring-path.ts` now resolves by asking which file can
  sign for THIS vault, falling back to `~/.float`; a project-local ring that already holds a
  credential still wins, so nothing is stranded. (3) `generateAgentKey` took a **directory** and
  appended a hardcoded filename while the server read the full configured path — pinning the
  keyring to any other name meant reading one file and writing another, reported as success.
  Found by a smoke test pinning a non-default name; every unit test passes a directory, so none
  could see it. An existing orphan is now **self-healing**: the duplicate guard asks
  `get_virtual_agent_node` and **retires** (renames, never deletes) a role bound to nothing.
  Verified against mainnet — the `travel` key reports node `null`, the live one reports node 1.
  Mutation-verified both ways. **388 MCP tests.** `vault_roles` now also reports **which keyring
  it read and why** — every status it returns is a claim about one specific file, and the tool had
  the path and did not say it. Driven from both project directories against the real config: from
  `New project` it names that ring and reports `travel` **DEAD**; from `near-vault` it names the
  other and reports node 1 **USABLE**.
  **NOT LIVE FOR USERS YET** — this ships in mcp **0.10.2**; npm has **0.10.1** and this machine
  is not authenticated to publish.
- **Gate is 39 checks: `mcp typecheck` was missing.** The most-edited package, and the one that
  ships to npm, was never typechecked here. A `server.ts` with a literal syntax error passed all
  38 checks AND 368 vitest tests, because esbuild is more permissive than tsc. A broken MCP could
  have been published and failed only in a user's client.
- **Remaining:** deploy the factory (above); publish **mcp 0.10.2** (floor term + the server
  version that had drifted to 0.10.0 after 0.10.1 shipped); `git pull` on the skill host for the
  SKILL.md cost fix; make the repo PUBLIC (git history verified clean —
  `scripts/scan-history-secrets.mjs`); and the hackathon submission, which nobody has started and
  is the only item with a hard deadline (**2026-11-14 23:59 UTC**). Lower priority: the public
  dashboard's DEFAULT vault is still testnet (invisible in the demo, since the UI asks "Whose
  vault?"); fixing it is a staged VPS change.
- **Incident 2026-11-12:** a private key was committed and pushed via a `.mcp.json.bak`
  that `git add -A` swept up. Purged from history and the local object store, remote
  force-pushed; the key controlled a non-existent testnet account. `check-no-secrets.mjs`
  is now gate check 1.

Gate: **38 checks**, all green (`node scripts/verify-all.mjs`).

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
| **hosting** | **LIVE** on `154.12.117.17`. `https://usefloat.xyz/` (signing page + `/skill.md`), **`https://app.usefloat.xyz/`** (dashboard). **MAINNET ADAPTER NOW UP (2026-11-11)** — `float-near-adapter-mainnet` on `:8788` pinned to `test015-near.usefloat.near`, alongside the testnet adapter on `:8787`. **Multi-tenant owner routing PROVEN live in both directions:** `?owner=test015.near` -> `test015-near.usefloat.near` / mainnet / nearblocks.io, and `?owner=flatdata6673.testnet` -> the testnet vault / testnet.nearblocks.io. Different vaults, networks and explorers from one URL, **no wallet and no key** — reads are keyless and owner actions go out as sign links. **The backend is already multi-tenant; only the UI pins a vault.** The deploy first failed `EADDRINUSE`: an unmanaged adapter started by hand in an SSH session two days earlier still held `:8788`. It had been spotted and noted that morning and not removed — noticing is not fixing. TLS to 2027-02-07 |
| hosting: follower | **`BLOCKED_FOLLOW=0` on the public box.** Measured there: follower on = 117 rate-limits/2min, `/healthz` 500, resolve degraded, on a host whose bare RPC is 40/40. Consequence: refusals after deploy are not picked up; re-scan with `NEAR_VAULT_CONTRACT=<vault> node scripts/scan-blocked.mjs --from <block>` on the box, because `.demo/` is gitignored so a fresh clone never carries one |
| hosting safety | `POST /v1/pay` answers **503** from the public internet — unauthenticated AND with the repository's own published `local-dev-token`. Ports 8787/3000/8080 answer **000** externally (loopback only). No `FLOAT_API_TOKEN`, no agent key on that box, and the deploy script REFUSES if either is even present in its shell |
| hosting guards | the script REFUSES to run if `FLOAT_API_TOKEN` / `NEAR_VAULT_AGENT_KEY` / the quote-signer vars are so much as PRESENT in its shell (`${X+set}`, so an EMPTY value is refused too). Final assertions are **positive-controlled**: a read must return 200 through the public hostname BEFORE the 503s are believed, because "gate shut" and "nothing listening" are the same output. It also fires the repo's own published `local-dev-token` at the box, and requires `/v1/owner-plan` to answer **400 not 503** so a regression to method-gating fails the deploy |
| **Float VPS** | **`154.12.117.17`** (`wattson`, Ubuntu 24.04.5, 2 cores / 1.9Gi / 58G). **PREPPED 2026-11-09**: Node **22.23.4** via NodeSource (NOT apt's EOL 18.19), nginx 1.24.0, certbot 2.9.0, git; **4G swap** added + fstab entry, because `next build` on 1.9Gi with no swap was an unmeasured OOM risk; ports 443/8080/8787/3000 free. Non-root **`float`** user with passwordless sudo and the deploy key — the script REFUSES to run as root, and only root existed |
| VPS read reliability | **40/40 (100%)** measured ON that host. Settles it: fastnear free tier is adequate, no subscription. (Dev machine was 26% — per-IP throttle, not a product defect) |
| DNS | **nothing resolves yet.** `usefloat.xyz`, `www`, `app`, `dash` all need A records -> **154.12.117.17**. The old `209.209.10.210` note was STALE — those records are gone, so there is no repointing risk and nothing to break on the pythscan box. `dash` is required or certbot's HTTP-01 fails for the dashboard vhost |
| **mainnet** | **THE PAYMENT PATH IS PROVEN WITH REAL MONEY (2026-11-11).** Vault `test015-near.usefloat.near`, owner `test015.near`. Request `596cb172-0374-41f9-b290-8c769724a992` **SETTLED**: vault 2.000000 -> 1.000000 USDC, payee 6.857652 -> 7.857652, node 1 budget executed 1 / available 24 of 25. Every figure read back from the chain, not from the tool's own response. Signed by `ed25519:E2PGijm…`, a **GasKeyFunctionCall pinned to `method_names:['request_payment']` on the vault alone, `allowance: None`** — so the README's claim that the restrictions are protocol-level now has a transaction behind it. Factory `usefloat.near` runs `GtsFXF99…` (anti-squat guard live). **Three blockers cleared first, none of them the contract:** the vault was NOT registered for USDC (an NEP-141 transfer would have bounced — fixed with `storage_deposit`, 0.00125 NEAR, tx `HQ1cMwQm…`); PowerShell strips quotes from near-cli JSON args; and `vault_create` had orphaned the agent secret |
| mainnet: the fix is NOT on chain | `bind_virtual_agent` was unreachable and is fixed in the repo, but the vault ships as a **global contract** the factory references by hash. Publishing a new one burns **29.9 NEAR** (1e20/byte x 298,839) against **3.42** held — short ~26.5. **Nothing is broken for anyone today**: no mainnet vault exists, and `add_role` (the primary path) is payable and binds internally. `res/vault.wasm` is rebuilt WITH the fix (`dc7a3fb6…`, 298,839 B, `CONTRACT_BYTES` re-pinned) so the publish is a funded decision, not a blocked one |
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
2. ~~Sandbox/integration tier has never run.~~ **IT RUNS AND IS GREEN: 45 passed, 0 failed,
   1 ignored** (2026-11-10, Linux VPS — Windows has no sandbox binary, which is why it had
   never run). It was entirely DEAD, and being unrunnable is what hid a LIVE CONTRACT BUG:
   - **`bind_virtual_agent` was UNREACHABLE in the deployed vault.** It calls `assert_owner`
     -> `assert_one_yocto`, but was not `#[payable]`, and near-sdk's wrapper rejects a deposit
     before the body runs. With a deposit: "doesn't accept deposit". Without: "requires
     exactly 1 yoctoNEAR". **No third kind of call existed.** The unit tier cannot see it —
     it calls the Rust fn directly and never crosses the wrapper. This is the SECOND time this
     shipped (the factory kill switch was the first), so `scripts/check-payable.mjs` now fails
     the gate on it: 63 methods scanned, mutation-verified.
   - `common/setup` omitted `root_limits` (a field `new()` grew) and still added a root node
     `new()` now creates — every test in every file died on its first call. Fixed.
   - `keys.rs` called `create_agent_account`, removed months ago. It kept COMPILING because
     near-workspaces takes the method name as a string. Rewritten onto `add_role`.
   - The test key's 1 NEAR allowance sat just under a max_gas reservation of 1.000919, so
     every self-submit died `NotEnoughAllowance` by 0.0009. Raised to 5.
   - **Still ignored, and not a contract fault:** the bundled sandbox `neard` does not
     implement NEP-611 gas keys — it ACCEPTS `AddGasKey` and silently does nothing (measured:
     3 receipts, 0 failures, no key). near-workspaces 0.23 maps `GasKeyFunctionCall` to
     `unimplemented!()` and panics on read. That path is proven on mainnet instead (7/7).
   - Toolchain now on the VPS: Rust 1.99.1, `cargo-near` 0.23 (needs `libudev-dev`).
3. ~~The web host serves a stale `vault.wasm`.~~ **FIXED AND VERIFIED 2026-11-10.** Host serves
   **298,839 B `dc7a3fb6`**, `scripts/check-create-page.mjs` **green**, 14/14 post-deploy
   assertions, all 3 services active, **0 root-owned files**. Checkout `d90eb8e` → `a050d18`.
   Two bugs found by doing it: (a) the unquoted `<<UNIT` heredocs **executed their own comments** —
   `'ss -ltnp'` ran and its socket listing was written into the live `float-near-dash.service`;
   fixed, and `check-heredoc-expansion.mjs` is in the gate (**29 checks**). (b) **the script
   `git reset --hard`s the tree it is running from**, so the run that applied fix (a) was still
   executing the OLD file and reported pre-fix line numbers; the unit stayed dirty until a third
   run from `/tmp`. **Deploy from a copy outside `$ROOT`** whenever the script itself changed.
   **Still true: no vault has ever been created by this factory**; `MAINNET_VAULT` is unset so the
   dashboard answers `503 NO_MAINNET_ADAPTER` for `.near` wallets; an unmanaged `node` on `:8788`
   is a leftover in no systemd unit.

   **NEW 2026-11-10 — the mainnet factory has a live squatting hole, now fixed in source but NOT
   on chain.** `alice.near` passing label `near` builds `alice-near-near`, exactly what
   `alice-near.near` derives with no label; first creator holds the id and the dashboard, which
   finds vaults BY DERIVATION, would show the victim an attacker-owned vault at their own address.
   The charset rule waves `near` through and the rooting is satisfied, so neither existing guard
   catches it. Fixed by banning a label equal to the factory's own TLD; mutation-tested (guard off
   -> only that test reds, and a merely-TLD-containing label like `nearby` stays allowed).
   **`usefloat.near` still runs the old build** — new factory is `164,596 B ec28be51` (`GtsFXF993GPYooShKAMWQF4YDJLur2Kk1cVwYpnxckSP`), chain has `H4HTsyZW`, re-read 2026-11-10. Dry run is staged for Bashir — `$env:FACTORY="usefloat.near"; node scripts/deploy-factory-mainnet.mjs` (PowerShell form; the bash `VAR=x cmd` prefix sets nothing on his shell), then the same with `$env:CONFIRM_MAINNET="1"`. No borsh migration: the guard added no struct fields. **The redeploy costs 0.01071, not 1.64596** — `free()` is already net of the deployed code's stake, so the old precondition charged for it twice and printed a FATAL telling Bashir to send ~1.5 NEAR from the account holding the vault deposit. Fixed in #115; dry run is green and `usefloat.near`'s 0.16034 covers it. Nothing has reached the hole (no vault exists), but a factory redeploy is staged and
   needs Bashir's full-access key.

   **PUBLISHED-ARTIFACT DEFECTS, found 2026-11-10 (reported by another agent, verified here).**
   (a) **The documented refund path 404'd.** `npx @floatonnear/float-exit` — the ONLY documented
   way to recover a vault's ~3.09 NEAR, printed in `SKILL.md` and in the MCP instructions sent to
   every client — is a **bin of `@floatonnear/create-float`, not a package**. Fixed to
   `npx -p @floatonnear/create-float float-exit`; same for `float-topup` and `float-agent`.
   `scripts/check-npx-commands.mjs` is now in the gate (**30 checks**).
   (b) **npm `@floatonnear/mcp@0.6.1` != local 0.6.1** — the published `dist/server.js` has **zero**
   `vault_gas`, local has it registered. Same version, different code, so nobody can tell which
   they run. **Needs a version bump + republish (Bashir's 2FA).**
   (c) **`create-float@0.6.0` ships bins `create-float, float-exit, float-agent` — no
   `float-topup`**, so even the corrected command fails until it is republished. Also 2FA.
   (d) `apps/dashboard/public/skill.md` is a THIRD stale copy (Oct 26) that the site does not
   serve; harmless now, a silent regression if it ever becomes the fallback.

   ~~**OPEN GAP — THE CREATE URL IS HALF-WIRED.**~~ **WIRED 2026-11-10.** `vault_create` now takes
   `daily`, `perTx`, `token`, `decimals` and `label` and bakes them into the link, so the agent
   interviews the user and the page only handles the wallet signature — the agentic flow we pitch.
   Caps are HUMAN units (the page scales by `decimals`). **Validated before a link is built**, not
   after: more decimal places than the token has is refused because the page TRUNCATES rather than
   rounding (`2.0400001` would silently become `2.040000`), `perTx > daily` is refused as probably
   swapped, and a label is checked against the contract's own rule INCLUDING the new TLD ban the
   page predates. A label moves the reported vault id (`<prefix>-<label>.<factory>`), matching
   `web/index.html:1282`. New read-only **`vault_await_create`** polls for the account and compares
   `get_config.owner`, reporting LIVE / NOT_YET / NOT_YOURS / UNVERIFIED — so the agent never asks
   the user to paste an id back, and existence is never mistaken for ownership.
   `scripts/check-create-url-params.mjs` is in the gate (**31 checks**) and is asymmetric on
   purpose: sending a param the page ignores is a hard failure, reading one nothing sends needs a
   written reason. Three mutations confirmed the new tests carry weight.
   **Versions bumped and NOT YET PUBLISHED (needs Bashir's 2FA): `@floatonnear/mcp` 0.6.1 -> 0.6.2,
   `@floatonnear/create-float` 0.6.0 -> 0.6.1** (the latter finally ships the `float-topup` bin).
   The 0.6.2 bump also resolves the collision where npm 0.6.1 and local 0.6.1 were different code.

   **INTERVIEW UX FIXED 2026-11-10 (three changes, from reviewing the flow running).**
   (a) **The owner question moves to position 1** — it was never asked, and without it
   `vault_create` returns `vault: null` and `confirm.args: null`, silently disabling the
   `vault_await_create` verification and putting the human back to reading an id aloud.
   (b) **Caps are proposed, not interrogated.** Rule now in `SKILL.md`: *ask about what is
   expensive to change, propose what is cheap.* Network and agent-binding are baked into one
   signature; caps are one signed `vault_plan_set_caps` away, so four blocking modals was a web
   form rendered in chat.
   (c) **Page defaults `2.04`/`0.51` -> `25`/`10`.** The old pair were `float.test015.near`'s
   stored caps, undocumented, leaked into every new user's default. **The real rule, which bit
   twice in one sitting: no cap can deliver a round payment EQUAL to itself** — cross-chain is
   EXACT_OUTPUT so charge = amount x (1+fee), and 0.51 refuses 0.50 exactly as 5 refuses 5.00.
   My first fix was 5 and had the identical defect. Pinned by three tests in
   `create.pins.test.ts` that read the defaults OUT OF the page; verified to red on both `0.51`
   and `5`.

   **WHY THE FIXED FLOW STILL SHOWED OLD VALUES (2026-11-10).** Three stale COPIES, none of which
   the repo compared. (a) **MCP tool descriptions still said `2.04`/`0.51`** — and a tool schema is
   injected into the agent's context, so it kept offering "Page defaults: 2.04 / 0.51" as a
   recommended option hours after the page changed. Fixed; `scripts/check-quoted-defaults.mjs`
   gates it. (b) **`apps/dashboard/public/skill.md` was LIVE and wrong** — Next.js serves `public/`
   with no route, so `app.usefloat.xyz/skill.md` served an **October** skill (18,881 B) while the
   apex served current (24,130 B). Two documents, same path, two hosts. Synced, and
   `check-plugin.mjs` now compares it. (c) **`~/.claude/skills/float/SKILL.md`** is an installed
   COPY, so editing the repo never touches it — re-copied by hand. All four copies now agree
   (`b05515c2`). **mcp bumped 0.6.2 -> 0.6.3, needs publishing.** Gate now **32 checks**.

   **ONBOARDING GREETING IS NOW DICTATED, NOT DESCRIBED (2026-11-10).** The interview logic was
   right and the output was nine paragraphs — refundable stake, trust model, gas reservation, all
   true, all unprompted — and a user asking for a vault could not find the two questions in it.
   `SKILL.md` now carries the exact text to send (two numbered questions + one italic note), with
   "SEND EXACTLY THIS, AND NOTHING ELSE". Cost moves to where it is actionable: quote
   `totalRequiredNear` WITH the link, not before. **Describing the reasoning was not enough; the
   output had to be specified.** The greeting is also a FOURTH copy of the cap figures, so
   `check-quoted-defaults.mjs` was upgraded from a retired-value blocklist to **validating any
   stated figure against the page** — a blocklist cannot catch someone inventing "50 USDC/day".
   Positive-controlled on both an invented daily and an invented per-tx.

   **GREETING NOW ASKS ONE THING (2026-11-10).** The network question is gone — cross-chain only
   exists on mainnet, so offering the choice spent attention on a decision already known. Mainnet
   is STATED, not asked, and testnet stays reachable by saying so. **Removing a question made the
   default load-bearing, and the default was wrong:** `vault_create` resolves an omitted `network`
   to `NEAR_VAULT_NETWORK ?? "testnet"`, so a greeting promising Mainnet with the argument omitted
   would hand over a TESTNET link — play money, no error, both paths succeed on different chains.
   `SKILL.md` now mandates passing `network: "mainnet"` explicitly and
   `check-quoted-defaults.mjs` fails if the stated network and the documented call disagree
   (controlled both ways: argument absent, and argument contradicting).

   **CRAFT PASS ON THE CREATE PAGE — SHIPPED AND LIVE 2026-11-10 (#125, `88e00c4`).** Deployed to
   `154.12.117.17`; live HTML is **byte-identical to local, 104,548 B, sha `5d9a75dd`**, 14/14
   post-deploy assertions, 3/3 services clean since restart, 0 `command not found` in a 63-line
   deploy log (matcher positive-controlled). The page looked like a wireframe of itself — `#fff` on
   `#fbfbfa`, hairline, no shadow — but the real finds came from reading the STATES, not the
   stylesheet:
   - **The agent key is grouped in fours.** 52 base58 chars under `word-break: break-all` orphaned
     a single `c` onto line two; a swapped key hides exactly where the eye stops tracking. The
     grouping **adds no characters** (margins + `<wbr>`), so select/Copy still yield the exact key —
     `groupKey` asserts that with a round-trip probe on every call and leaves the node alone if it
     ever fails.
   - **`--faint` is deleted, not darkened.** `#a0a09a` at 12px is ~2.4:1, under AA — and `.note` is
     the style carrying *"check this public key matches the one your agent showed you"*. The
     sentence that stops a key swap was the quietest ink on the page.
   - **Three things the page SAID that were untrue:** "Connect the wallet that will own it" showed
     on the agent gate and plan (panels that only render once a wallet IS connected — `renderAction`
     already had this fixed, with a comment stating the rule); the plan said "Nothing can spend from
     this vault until you add an agent" directly beneath the row naming the agent being bound in
     that same transaction; and `25 / day, 10 / tx` crammed two independent caps into one cell.
   - **`web.gate.test.ts`'s header claim "no DOM library installed" was WRONG** — `happy-dom` has
     been a root devDependency the whole time, so the rendered check it recorded as *owed* was
     available for the asking. `groupKey` is now extracted from the page and executed against a real
     DOM. Both clauses mutation-checked: chunk `4`→`3` reds the grouping test while round-trip stays
     green **because the revert guard fires**; disabling the guard too reds all three.
   - **"MASTER VAULT BUDGET" IS NOW SAID AT ONBOARDING (2026-11-10).** The greeting said "standard
     limits of 25 USDC/day", ambiguous between the whole vault's ceiling and this agent's personal
     allowance — and **both readings are true on day one**, which is why it survived. `daily`/`perTx`
     become `root_limits` (`web/index.html:2027`) and a bound agent gets a child whose caps are
     **cloned from root** (`agent_limits = root_limits.clone()`, `contracts/vault/src/lib.rs:322`).
     They diverge at agent #2: the master stays shared, each agent still shows its own 25/day, and a
     sibling draining the pool returns `PARENT_DAILY_BUDGET` while the refused agent's cap looks
     free — **the headline differentiator, previously first met as a surprise.** The greeting now
     names the master budget and says every agent shares it, and the page rows read **"shared daily
     limit"**. This also ends one concept having two names: the dashboard has always said "MASTER
     VAULT BUDGET / Shared by every agent". All four `SKILL.md` copies re-synced (`a6fee4a6`).
   - **Deploy trap worth keeping:** `SKIP_CERTBOT=1` looks like a safe way to avoid re-running
     certbot on a valid cert, but the script REWRITES the vhost and `certbot --nginx --redirect` is
     what re-injects the TLS block — skipping it would leave a live HTTPS site serving plain HTTP.
     `VAULT`/`TOKEN` also default to EMPTY and must be carried off the live units, not re-derived.

   **ADOPTION PATH ADDED 2026-11-10 — `vault_create` was being used to VERIFY.** A user who had
   already created a vault said so, and the agent had nowhere to go: the skill only documented
   greet -> link -> sign -> `vault_await_create`, and that tool REQUIRED a vault id the user does
   not know (it is derived, not chosen). So the agent called `vault_create`, which **threw**
   "already exists and test015.near owns it" — a refusal — and reported it to the user as
   "Confirmed ✅". Right answer, reached by reinterpreting an error, and indistinguishable from the
   throw that says the vault belongs to SOMEBODY ELSE. **Fixed:** `vault_await_create`'s `vault`
   arg is now optional and derived from `owner` via the factory's `vault_id_for`; `SKILL.md` routes
   "I already created it" straight to it and states that a `vault_create` throw is never a success.
   Verified against the live vault: derived `test015-near.usefloat.near`, read `get_config.owner`
   back = `test015.near`, LIVE.

   **THE RPC DID NOT FOLLOW THE NETWORK — every mainnet install read the wrong chain (2026-11-10).**
   `cfg.rpcUrl` was `NEAR_VAULT_RPC_URL ?? DEFAULT_RPC_URL`, and `DEFAULT_RPC_URL` is the TESTNET
   endpoint. Setting `NEAR_VAULT_NETWORK=mainnet` — the documented way to be on mainnet — left all
   **14** tools that use `cfg.rpcUrl` querying testnet, so `vault_config`/`vault_tree` answered
   "account does not exist" about `test015-near.usefloat.near` (holding 3.35 NEAR), and `vault_pay`
   would have submitted to the wrong chain. Only `vault_create`/`vault_await_create` worked, because
   they alone call `rpcForNetwork()`. **That asymmetry also defeated the diagnosis:** the testnet
   theory was correct and was "refuted" by testing it with `vault_await_create`, the one tool immune
   to the bug. Fixed; mutation-tested at the WIRING level, because the `rpcForNetwork` unit test
   stays green through the regression. **`vault_roles` returning `[]` was NOT a bug but was a lie
   by omission** — `bindAgent` writes no `role`, `listRoles` filters on one, so a live funded agent
   was invisible and "no agents" was indistinguishable from "one unnamed agent". New `listAgents`
   reports it with `role: null`. **mcp 0.6.3 -> 0.6.4, needs publishing.**

   **LIVE MCP SWEEP ADDED, and it found a second real bug (2026-11-10).** `scripts/check-mcp-live.mjs`
   spawns the server over stdio against the REAL mainnet vault and calls every read + plan tool:
   **12/12 ok**, `vault_pay`/`vault_create`/`vault_await_create`/`vault_add_role` skipped with
   reasons. Outside `verify-all` (needs internet + a live vault); run it before a demo.
   **Found: the keyring was never scoped to the configured vault.** `vault_roles` on the mainnet
   vault listed `rudeisland4178-testnet…` and `work12-testnet-fleet…` — TESTNET accounts from old
   experiments — and `selectRole("root")` would have handed `vault_pay` a testnet key to sign a
   MAINNET payment. Fixed: all keyring reads filter on `agentId === cfg.vault`; mutation-tested
   (filter removed -> 3 tests red). ~~Known rough edge:~~ **FIXED** — `vault_tree` now returns human units
   (`daily_cap: "25"`, with `decimals` echoed so the base figure stays derivable), matching
   `vault_budget`. Converted ONLY for `NEAR_VAULT_TOKEN`: caps are stored per token and the server
   knows one token's decimals, so an unknown token keeps base units and says `units: "base"` rather
   than being scaled by a guess. **mcp 0.6.4 -> 0.6.5, needs publishing.**

   **ERROR PATHS ARE THE UX — four defects, found by probing them (2026-11-10).** The happy-path
   sweep was 12/12 while all four were wrong, and a user meets the unhappy path far more often.
   (a) **`vault_plan_*` built signable payloads for nodes that do not exist** — `set_caps({nodeId:
   999})` on a two-node vault returned a complete unsigned transaction; you sign, pay gas, and the
   CONTRACT rejects it. All four node-scoped plan tools now refuse first and list the real nodes.
   (b) `vault_budget(999)` said "node 999 has no limit for that token", **asserting the node
   exists** — now distinguishes "no such node" from "node exists, no limit for THAT token" and
   names which tokens it does have. (c) `vault_request(bogus)` returned a bare `null`,
   indistinguishable from a failed call — now explains, including that a settled request may have
   been **purged**, so absence is not proof the payment never happened. (d) A failed tree READ must
   not block a plan: an unreachable chain is not evidence a node is missing.
   `check-mcp-live.mjs` now asserts all five error paths on CONTENT; positive-controlled by
   removing a guard. **mcp 0.6.5 -> 0.6.6, needs publishing.**

   **UX BATCH, mcp 0.7.0 (2026-11-10) — made by LOOKING at every tool's output as a user.**
   (a) **Tokens read as `USDC (1720…)`, not 64 hex characters.** New `token-meta.ts` resolves
   `ft_metadata` once per token, cached for the process (failures cached too, or one bad id becomes
   a storm). It keeps the id beside the symbol because **a symbol is not unique** — anyone can
   deploy a "USDC". (b) **That also removed a correctness caveat**: `vault_tree` previously
   humanised ONLY `NEAR_VAULT_TOKEN` and left every other token in base units, because guessing an
   exponent prints a tidy figure wrong by orders of magnitude. The chain knows the real decimals,
   so the guess was never needed. (c) **`vault_budget` says `date: 2026-11-11` and `resets: 00:00
   UTC`** — `day: 20768` is the right ledger key and means nothing to a person; it stays alongside.
   (d) **`vault_config` now explains the hierarchy**, which is the differentiator and was invisible:
   root cap vs allocated-to-children, `mode: overcommit|strict`, and in plain words that a sibling
   spending first yields `PARENT_DAILY_BUDGET` while your own cap still reads available — *"the
   design working, not a fault"*. Also decodes `clock_mode`. The gate caught the caret trap on the
   bump (`^0.6.0` does not match 0.7.0 — a clean install would have pulled the published mcp over
   the sibling). **280 unit tests, 32 checks, live sweep 12 tools + 5 error paths. Needs
   publishing.**

   **GAP AUDIT: 26 tools listed against the payload builders (2026-11-10).** Found by enumerating
   the surface, not by hitting the bugs. (a) **`vault_plan_set_strict_allocation` DID NOT EXIST** —
   `planSetStrictAllocation` was in `payloads.ts`, the dashboard exposed it, and no MCP tool did. So
   `vault_config` described overcommit as a mode worth changing and offered no way to change it.
   Added. (b) **`vault_plan_purge` demanded a raw Unix day number** (`beforeDay: 20768`) — unusable
   as an INPUT, and an off-by-one silently purges a day more or less of records that are then gone.
   Now takes `beforeDate: "YYYY-MM-DD"`, with no default: a purge cannot be undone and "today" would
   remove everything settled. (c) **A no-amount `vault_plan_withdraw` empties the vault**, and the
   summary read identically to a partial one. Now says "the ENTIRE balance" and warns the figure was
   read from the chain. (d) **The live sweep covered 12 of 26 tools; now 20** — eight plan tools had
   never been called by anything, and the first caller would have been a user. mcp 0.7.0 -> 0.7.1.
   **284 unit tests, 32 checks, 20 tools + 5 error paths. Still unpublished — batching.**

   **THREE READS THE CONTRACT HAD AND NOTHING EXPOSED — mcp 0.8.0 (2026-11-10).**
   (a) **`vault_history` is new.** `list_requests` was always on the contract; the MCP had only
   `vault_request(id)`, and an id is obtainable ONLY from a `vault_pay` response — so "what has my
   agent been spending on?" had no answer but a running total. Renders amount, token symbol, payee,
   memo and an ISO timestamp. **Its caveat ships WITH the data every time**, because the contract
   deliberately does not store a REFUSED payment (that would let an agent inflate the storage bill
   by spamming refusals) — so an empty feed means "nothing was paid", NOT "nothing was attempted",
   and an agent blocked every time looks identical to one that never tried. Mutation-tested: drop
   the caveat and the live sweep reds. (b) **The approval threshold was write-only** — you could
   `vault_plan_set_approval_threshold` and never read one back, so an owner could not see their own
   rule and an agent could not warn "this will be HELD". `vault_tree` now shows the **effective**
   threshold (it inherits, so the local value under-reports). (c) **An in-flight ownership transfer
   was invisible** — `vault_config` now reports `pending_owner`. Verified against a vault with real
   payments, not just the empty case. **Live sweep 21 tools + 5 error paths; 284 unit tests; 32
   checks. Still unpublished — batching.**

   **CRITICAL, LOGGED NOT YET FIXED — `vault_create({bindAgent:true})` orphans the agent secret.**
   `generateAgentKey` defaults to `const dir = opts.dir ?? ".float"` — a RELATIVE path.
   `vault_add_role` passes `dir: dirname(cfg.agentKeysPath)`; **`vault_create` passes no `dir` at
   all**, so the secret is written to `.float/` relative to the MCP SERVER'S working directory,
   which is wherever the client launched it — not `NEAR_VAULT_AGENT_KEYS`. Measured 2026-11-10:
   `test015-near.usefloat.near`'s agent key landed in `Documents/New project/.float/agent-keys.json`
   while the server read `near-vault/.float/`. **The key was never lost — it was written where
   nothing reads, which is worse than failing**: `vault_create` reported success, the link worked,
   the vault bound the key on chain, and the credential was silently orphaned. Bashir diagnosed it
   from the symptom before I found the line. **Second, related gap:** `vault_pay` with no `role`
   calls `requireAgentKey`, which reads ENV ONLY — so a keyring holding exactly one credential for
   the configured vault still cannot pay. It should fall back to the sole credential. Recovered by
   hand for now (entry copied, source untouched, backup at `.float/agent-keys.json.pre-recover.bak`).
   **Fix both in the next batch.**

   **THE DASHBOARD IS MULTI-TENANT (2026-11-11).** `?owner=` in the URL, or an account id typed into
   a new "Whose vault?" screen, and the existing proxy resolves that account's vault through the
   factory. **Verified in a browser against the real mainnet vault:** `/?owner=test015.near` showed
   `test015-near.usefloat.near`, TOTAL SPENT $1.00, 1 transaction (1 approved / 0 blocked), 24 USDC
   left of 25 — the payment made an hour earlier. No wallet, no key: reads are keyless and owner
   actions already leave as sign links, so this needed **identity, not authentication**.
   **Behaviour change:** with no owner it now ASKS, where it used to fall through to whichever vault
   the adapter was configured with — a stranger landing on the operator's vault believing it was
   theirs. Nav chrome is hidden until identified, because those links led only back to the same
   prompt and the "Connect" dropdown opened nothing. No vault yet is an OFFER (the derived address
   plus a create link), not an error.
   **Found while testing it: the ADAPTER had the same RPC-follows-network bug as the MCP** —
   `NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com"`, so `NEAR_VAULT_NETWORK=mainnet` alone
   queried testnet and answered "account usefloat.near does not exist". **The deployed copy masked
   it** because `deploy-skill-host.sh` sets the RPC explicitly; every hand-run instance failed.
   Fixed and mutation-tested. **Not yet deployed.**

   **STALE SESSIONS WERE SHOWING THE TESTNET VAULT AS YOURS (fixed 2026-11-11).** Until the
   dashboard asked whose vault, it auto-connected to whatever vault the ADAPTER was configured with
   and SAVED that owner to `localStorage` under `float.owner.session.v1`. On the public deployment
   that is the operator's testnet demo account — so every returning visitor silently auto-loaded a
   stranger's vault, on the wrong network, with no prompt. Reported with a screenshot: a mainnet
   owner seeing the testnet budget tree (100 USDC master, `marketing` agent, 42.25 balance) rendered
   as their own. **Key bumped to `v2`, which drops every stale session** — a migration cannot work,
   because v1 recorded only the account id and so cannot distinguish one the USER chose from one
   inherited from the adapter. Verified by reproducing the exact v1 state in a browser: it now
   prompts. Also fixed: `danger-zone` hardcoded `e.g. you.testnet` while already receiving
   `info.network`. **Confirmed in the DEPLOYED bundle, not just locally: `v1` in 0 files, `v2` in 4.**

   **SEVENTEEN DASHBOARD FETCHES NEVER SAID WHOSE VAULT (fixed + deployed 2026-11-11).** Reported
   twice with screenshots: a mainnet owner on `/?owner=test015.near`, in incognito, seeing the
   TESTNET budget tree as their own. `/v1/dashboard` was passed an owner in **one of five** call
   sites, so Overview resolved correctly and every other page did not. The proxy falls back to the
   adapter's configured vault when no owner arrives — on production, the testnet demo. **The failure
   is silent: HTTP 200, a real vault, nothing red.** Fixed by `apps/dashboard/lib/float-fetch.ts`,
   now the only door, attaching the owner itself **including on POSTs** (`/v1/owner-plan` is a POST
   and the proxy reads `searchParams`, not the body — a payload built against the wrong vault would
   have been handed to a user to SIGN). `API_BASE_URL` was redeclared in nine files; now defined
   once. `scripts/check-dashboard-owner.mjs` fails the build on a bare adapter fetch.
   **Two of my verifications were incapable of catching it**: (a) I tested locally with
   `FLOAT_ADAPTER_URL` and `FLOAT_ADAPTER_URL_MAINNET` pointing at the SAME mainnet adapter, so both
   branches led to one place; (b) the gate ran `tsc`, not `next build`, so a `"use client"` ordering
   error passed the gate and failed the DEPLOY. Gate now builds the dashboard — **34 checks**.
   **Danger Zone removed from the UI** (see DECISIONS.md). Deployed and verified live: `vault-info`,
   `dashboard` and `agent-keys` all return the mainnet vault for `?owner=test015.near`.

   **REFUSAL PROVEN ON MAINNET, and it exposed a UI lie (2026-11-11).** `vault_pay` of 15 USDC
   against a 10 per-payment cap returned `status: BLOCKED, reason_code: PARENT_PER_TX_LIMIT`;
   balances unchanged, `get_request` -> `null`. **The refusal will never appear as a count**: the
   contract does not store a blocked request — it emits an event and returns the reason, so an agent
   cannot inflate the vault's storage bill by spamming refusals. Counting them needs
   `scripts/scan-blocked.mjs` over the event log. The adapter has always sent
   `blockedCoverageNote` saying refusals are "UNKNOWN rather than absent"; **Activity rendered it,
   the Overview did not** — and printed `0 blocked` in DANGER red, the colour of a measurement, on
   the page people land on. Fixed and deployed: muted "refusals not scanned". The data layer was
   honest and the most-seen view was not.

   **OPEN, Bashir's call — memo visibility on a public vault view.** `/v1/agent-keys` is SAFE: only
   public keys and `methodNames`, from `viewAccessKeys`, which anyone can read from any RPC. But
   memos ("landing page draft", "copywriting") are business intelligence, and while **nothing on the
   dashboard is more public than the chain already is**, the dashboard changes the EFFORT from
   "query NEAR RPC" to "type a name" — a real privacy change even for already-public data. Three
   options put to him: leave it (consistent with a public ledger); hide memos behind proof of
   ownership (reintroduces the authentication the design deliberately avoided); or keep reads open
   and drop memos from the public view, keeping amounts and status. **DECIDED: option 3**, and shipped — see DECISIONS.md.

   **`vault_teardown_report` HANDED OUT A COMMAND THAT COULD NOT RUN (fixed 2026-11-11).** It is
   the first thing a user asks when closing a vault, so all three defects landed on someone
   deleting an account holding real money. (a) **No `CONFIRM_MAINNET=1`** — `teardown-vault.mjs`
   exits 2 on mainnet without it, so the command did nothing and the user found out by running it.
   (b) **No `EXPECT_TOKENS`** — the script's own guard against its worst documented failure: a
   WRONG token id reads as a zero balance, prints "no tokens to withdraw", and the delete strands
   the real USDC at an address nobody can ever sign for. The report has just READ the balance, so
   it now fills this in — the one number a user would otherwise supply from memory, where being
   wrong is permanent. Omitted (with a warning) when the balance could not be read, because a guard
   built from "unknown" asserts a number nobody verified. (c) **bash env-prefix syntax only**,
   which silently sets nothing in PowerShell; both shells are emitted now. Mutation-tested.
   **Also: `apps/dashboard/lib/proxy-gate.ts` was found to be 3,970 NUL bytes** — power-loss
   corruption during load shedding, metadata written and data not. Restored from git; a full scan
   found no other file affected.

   **CLOSING A VAULT NOW POINTS AT THE FRIENDLY CLI (2026-11-11).** `vault_teardown_report` emitted
   `NETWORK=… VAULT=… OWNER=… TOKEN=… CONFIRM_MAINNET=1 EXPECT_TOKENS=1 node
   scripts/teardown-vault.mjs` — six env vars, a path only someone who cloned the repo has, no dry
   run, and a permanent delete at the end. For the one action a user takes when already nervous,
   that was the worst available interface. **`float-exit` already shipped for exactly this**:
   `npx -p @floatonnear/create-float float-exit --owner X --vault Y --dry-run`, two flags, numbered
   steps `[0]`–`[6]`, "would" phrasing for everything not yet done, and an explicit "This is
   irreversible" before the delete. The report now emits the DRY RUN first and the destructive form
   separately, so copying the first thing you see cannot delete a vault. **I spent a round fixing
   the hard road's ergonomics before checking whether the easy one existed.** mcp 0.8.0 -> 0.8.1.

   **`float-exit` READS LIKE A PRODUCT NOW (2026-11-11).** It was mathematically correct and shaped
   like a debug log: a 64-character token id printed four times, `1000000` for one dollar, and
   `300817 B = 298839 code + 1978 state` on the screen where someone decides whether to delete
   something holding their money. Now: **`1 USDC`** via a local `ft_metadata` read, byte counts
   gone (the only number they implied — the NEAR the stake refunds — was already on the next line),
   the token named by symbol everywhere, and headings that say what the user GETS rather than what
   the script does (`What comes back`, `Your tokens`, `Gas held by agents`). Decimals are read from
   the CHAIN, never assumed: a token whose metadata will not read keeps its raw id and base units
   and says so, because scaling by a guessed 6 prints a figure wrong by orders of magnitude while
   looking tidy. **Mirrored from the MCP's `token-meta.ts`, not imported** — siblings published
   independently, same reason `check-gas-math.mjs` exists. create-float 0.6.1 -> 0.6.2.

   **`float-retire` SHIPPED — retiring one agent without burning its gas (2026-11-11).**
   Unbinding leaves the agent's NEP-611 gas key funded; the obvious tidy-up is to delete the
   orphaned key, and **`DeleteKey` on a funded gas key BURNS the balance and reports SUCCESS**
   (measured 0.08322 NEAR). So the correct path was one nobody would find and the natural path
   destroyed money. `float-retire --retire <role> --owner X --vault Y --dry-run` recovers the gas,
   **re-reads the key to confirm it is empty**, and only then unbinds — stopping without revoking
   anything if the withdrawal fails, because a working agent can be retried while an unbound key
   holding stranded NEAR is money nobody revisits. Takes a ROLE, scoped to the vault (role names
   are not unique across vaults). Verified against the live mainnet agent: node #1, 0.118916 NEAR,
   dry run writes nothing; four refusal paths each name the fix. `vault_plan_unbind_agent`'s
   description now points at it. **The lifecycle story is now: freeze (wallet, reversible) ->
   retire (CLI, recovers gas, permanent) -> exit (CLI, closes the vault).**
   create-float 0.6.2 -> 0.7.0 (new bin).
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
6. ~~`deploy-vps.sh` has never run on a host.~~ **SUPERSEDED, not pending.** It deploys the
   adapter under **pm2** to `/srv/float-near`, for a box already running pm2 — a path
   `DECISIONS.md` (2026-11-08) rejected in favour of **systemd on a dedicated box**. The
   chosen script, `scripts/deploy-skill-host.sh`, HAS now run on `154.12.117.17` repeatedly
   with all 14 post-deploy assertions green. `deploy-vps.sh` is kept because
   `docs/DEPLOY-VPS.md` documents the pm2 alternative, but nothing in the current deployment
   uses it — so "never run" is true and no longer a gap.
7. **A solver has never filled an Intents order** — the testnet deposit address was ours and the
   quote was `dry`. SETTLED on the Intents rail ≠ delivered.
8. Daily window is a **cliff, not rolling** — 2× daily budget across midnight. Open by decision.
9. **Two mainnet seed phrases are unbacked-up.** `test015.near`'s, and now `usefloat.near`'s —
   written by the CLI as `master_seed_phrase` inside
   `~/.near-credentials/mainnet/usefloat.near.json`. That account will own Float's entire
   mainnet namespace (every vault is its sub-account), and it has exactly ONE full-access
   key. Losing that file loses the namespace permanently.
10. ~~Inert Solana pages in the dashboard.~~ **DONE** — `app/auth`, `app/link` and `app/setup` are deleted, no `@solana`/wallet-adapter package remains, and every surviving mention is a COMMENT recording what was removed. Verified 2026-11-09.
11. **NO USER BUT THE OPERATOR CAN EVER SEE A REFUSAL** (found 2026-11-14, the "tier 2" gap).
    Three separate things have to be true for a blocked payment to render, and for anyone
    other than the adapter's own configured vault the FIRST one is false by construction:
    - **The multi-tenant emptying.** [`server.ts:359`](packages/float-adapter/src/server.ts)
      does `isDefault ? cfg : { ...cfg, vault, blockedRing: [], chainBlocked: {} }`. A
      visitor's vault gets an empty refusal set *before the handler runs*, so scanning more
      would change nothing for them. The comment's reasoning is right (never attribute the
      operator's refusals to a visitor) but the remedy is too blunt: the store is keyed by
      vault AND carries a `vault` provenance field, so the fix is to **filter**, not to empty.
    - **The scan is per-vault and does not scale.**
      [`blocked-scan.ts:272`](packages/float-adapter/src/blocked-scan.ts) filters
      `tx.receiver_id !== vault` — exact match, one vault per pass. But the expensive part is
      the block/chunk walk, which is IDENTICAL no matter who you filter for, and every Float
      vault is a sub-account of the factory. Make that a suffix predicate (`*.usefloat.near`)
      and **one** follower covers every vault anyone ever creates at zero marginal RPC cost:
      O(blocks) instead of O(vaults × blocks). This is the single highest-leverage line in
      the feature.
    - **`BlockedRecord` does not carry which vault it came from** (`requestId`, `nodeId`,
      `reasonCode`, `agent`, `txHash`, `blockHeight`, `blockTimestampNs`), and
      `BlockedStore.vault` is a SCALAR. Going factory-wide means reshaping the store from
      one-vault to many-vault and updating the provenance checks — which exist precisely
      because cross-vault contamination already happened here once (six refusals from
      `v3.floatvault-12329.testnet` rendered on a one-node vault). That reshape is the bulk
      of the work and the reason this was not attempted before the deadline.
    - **Measured 2026-11-14 on the live mainnet vault**, via the hosted API
      (`?owner=test015.near`): `blockedCoverage: null`, note `scanned: false`. The vault has
      never had a refusal scan run against it, so **every refusal ever made on it is
      invisible** — and the dashboard says so only in the muted coverage note. The reason
      TEXT is not missing: `REASONS` ([`map.ts:385`](packages/float-adapter/src/map.ts))
      covers every hot-path code and both the row and the detail modal render it. The missing
      thing is the ROW.
    - **Tier 3, for later and worth it:** `KNOWN-TRADEOFFS.md` §2 rejects storing refusals
      on-chain because an agent could inflate the vault's storage bill by spamming rejects.
      That objection is about **unbounded** growth. A fixed-size circular buffer of ~32
      entries is constant storage (~3 KB, ~0.03 NEAR of stake) and an agent spamming rejects
      only overwrites its own entries — the griefing vector closes by construction. Then
      `list_blocked` is a plain view call: no scanner, no coverage caveat, no "UNKNOWN rather
      than absent" banner, correct for every vault the instant it is created. Contract change
      + republish, so it was never a same-day option.
12. **THE AGENT DECLINES BEFORE THE CONTRACT EVER REFUSES — so the enforcement leaves no
    trace** (measured 2026-11-14 17:52 UTC, mainnet). Asked to pay 0.35 USDC from `marketing`
    against caps just tightened to 0.05/tx and 0.35/day, the agent answered with a correct,
    well-reasoned refusal naming BOTH caps — and **never called `request_payment`**. Verified
    two ways: NearBlocks shows the vault's last transaction as `set_node_caps` at 17:16:01 with
    nothing after it for 36 minutes, and `vault_pay` itself has **no pre-flight cap check** —
    [`server.ts:2295`](packages/mcp/src/server.ts) goes straight to `sendRequestPayment`, so a
    refusal that *had* reached the contract would necessarily be on chain. The agent read
    `vault_budget`/`vault_tree` (the MCP's own "look before acting" guidance) and reasoned its
    way out.
    - **A nonce probe was run and DISCARDED as inconclusive**, recorded so it is not re-run as
      if it proved anything: all three function-call keys read nonce `0` because they are
      NEP-611 gas keys, which do not track nonces like ordinary access keys. Only the owner's
      FullAccess key carries a real nonce. That check cannot see agent activity at all.
    - **Why it matters beyond the demo.** An agent choosing not to overspend is *politeness*;
      the key being unable to overspend is the *guarantee*. Those are different claims, and a
      demo that only ever shows the agent declining demonstrates the weaker one. It also means
      the dashboard's refusal feed will under-report in normal use: the better the agent, the
      fewer contract refusals exist to display. **Tier 2/3 above do not fix this** — they make
      recorded refusals visible; this is about refusals never being recorded.
    - **THIS IS A PRODUCT BUG, NOT A DEMO INCONVENIENCE**, and `DECISIONS.md` already said so
      hours earlier on 2026-11-14: *"if the client refuses, the user never sees the contract
      refuse and starts believing the client is the enforcer — the soft-budget illusion
      re-entering through the UI."* That row closed the pre-check in the MCP's **code** (and
      `vault_pay` is correct). The agent's reasoning reopened it one layer **up**, where no
      code change is implicated and no test can see it. A refusal costs **0.000866 NEAR for a
      settled payment, less for a blocked one** — so "pre-checking saves gas" defends a fifth
      of a cent against the product's central claim.
    - **The fix is in the MCP's GUIDANCE, not its code.** "Look before acting" must read as
      *for planning*, never as *for gatekeeping*, with the contract named as the only gate.
      Not yet written.
    - **To produce one on demand**, the agent must be told explicitly to submit without
      pre-checking. `scripts/prove-refusal.mjs <amount> <recipient>` exists for exactly this
      and refuses to sign any amount that could actually settle.

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

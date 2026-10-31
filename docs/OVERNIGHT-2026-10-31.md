# Overnight session, 2026-10-31

Autonomous work on `intents-rail`. Nothing published, no mainnet transaction
sent — both were off-limits and are staged below.

## Test counts

| suite | before | after |
| --- | --- | --- |
| vault (Rust unit) | 103 | **136** |
| create-float (wizard) | 183 | **201** |
| mcp | 92 | **92** |
| float-adapter | 119 | **119** |

The sandbox/integration tier was **not** run: it needs a Linux `neard` and does
not build on Windows. Unchanged from before, but worth stating rather than
implying it passed.

## What changed, in order

### 1. Eleven untested refusals (`466d395`)

Found mechanically: every `ReasonCode` the contract can emit, cross-referenced
against both forms a test asserts one (`ReasonCode::X` and the
`"SCREAMING_SNAKE"` string in a `should_panic`). **11 of 38 had no test.**

Two were the fixes this PR introduced. `NEAR_BUDGET` (F2) and `PARENT_COOLDOWN`
(F3) have *integration* tests — but those are the sandbox tier, so on Windows
the two newest guards in the contract were verified by nothing.

37 of 38 now covered. `LEDGER_INVARIANT` is deliberately left: it guards
pending-counter overflow and underflow, which no sequence of public calls can
reach, and contriving it would assert the contrivance.

Ten mutations, all caught — including replacing the chain-wide `last_paid_ns`
write with a leaf-only one, which is **F3's fix undone**.

**A sentinel found by writing a test wrong:** `last_paid_ns` has no entry until
a first payment and the guard reads a missing entry as `0`, so "never paid" and
"paid at the unix epoch" are the same value. While `now < cooldown`, a node
carrying a cooldown refuses everything. Harmless on mainnet (block timestamp
~1.76e18 ns vs a 6.05e14 ns maximum cooldown) but it bites on a fresh localnet.
Pinned by its own test.

### 2. The freshness guard was crying wolf, then got stuck (`466d395`)

Two defects in the guard added the day before:

- It watched **every** `*.rs`, including `tests.rs`, which is `#[cfg(test)]` and
  never compiles into the contract. Appending unit tests reported the contract
  STALE over a change that cannot reach the artifact. `compiledSources` now
  reads the `cfg(test)` module list out of `lib.rs`.
- **mtime gets stuck.** A mutation pass wrote `lib.rs` and reverted it, leaving
  identical content with a newer timestamp. The guard demanded a rebuild;
  `cargo near build` is content-addressed, so the rebuild was a no-op that could
  not move the artifact's mtime. Permanently red with no action available.

`res/vault.sources.json` now records a digest of path+content for every compiled
source, keyed by the artifact's own sha256. mtime stays as the fallback when no
record exists. A digest also survives a fresh `git clone`, which sets every
mtime to the checkout time and would have fired the old check spuriously in CI.

### 3. Human approval above a threshold (`eb4d9df`)

A second gate **inside** the caps:

```
amount <= threshold          executes immediately, as before
threshold < amount <= caps   held for the owner (APPROVAL_REQUIRED)
amount > caps                refused, as before
```

So no setting of a threshold can move more than the tree already allowed.

**Nothing is reserved while a ticket waits.** The gate sits after every limit
has passed and before anything is charged; `approve_payment` re-runs the whole
dispatch. Hence: a held payment does not block other spending, an approval
cannot slip past a cap tightened while it waited, and a stale Intents quote is
refused at approval with `QUOTE_EXPIRED` rather than sent on a moved price.

Most-restrictive-wins across the chain (the **lowest** threshold binds),
deliberately unlike `effective_recipients` where a child list *replaces* an
inherited one. Stored under raw keys outside `Vault`, so **no borsh migration**.
Three reason codes appended, which the tag-pinning test guards. Default is no
threshold anywhere, so existing vaults are unchanged.

Eight mutations; one survived — removing `assert_owner` from `reject_payment`.
`approve` had an owner test and `reject` did not, so anyone could cancel the
owner's held payments and grief the feature into uselessness. No funds move,
which is exactly why it was easy to leave untested. Test written while the
mutation was applied, watched red, then reverted.

### 4. The feature broke onboarding, and only arithmetic noticed (`eb4d9df`)

The contract grew 278 → 292 KB. Code stake is 1e19 yocto **per byte**, so the
stake went 2.848 → 2.990 against a hardcoded 3 NEAR of funding: state headroom
collapsed from 0.152 to **0.010 NEAR**, about one kilobyte. A four-node tree
does not fit. The wizard would have created the account, funded it, deployed,
then failed partway through building the tree — *after* the user had paid. Every
suite was green.

`VAULT_FUNDING` is no longer a constant. `bin/funding.mjs` derives it as code
stake + 0.35 NEAR headroom, so the contract can grow without breaking
onboarding. Now **3.340 NEAR with 0.350 headroom**; `usage()` updated 3.6 → 3.9
NEAR for a vault plus one agent.

A test asserts the wizard does not reintroduce a flat constant. The
affordability test in `steps.test.mjs` now derives its figure the same way — it
hardcoded `need 3.001` and went stale immediately, the second literal in that
one assertion to do so.

### 5. MCP tools + a trust-boundary test that was lying (`bde5567`)

`SKILL.md` documented `APPROVAL_REQUIRED` and said the owner calls
`approve_payment`, with no way to reach it except `near-cli`. Four tools close
that: `vault_pending_approval` (read) and three `vault_plan_*` unsigned owner
actions. The server still signs exactly one thing.

The "exposes exactly ONE signing tool" test filtered out `vault_plan_*` and then
asserted `vault_pay` appeared once — satisfied by `vault_pay` **existing**, and
would pass with a second signer beside it. Now every tool must be classified;
proven by inserting a `vault_sneaky_transfer` tool, which the new assertion
catches and the old one would not have.

## Blocked on you

### Publish (needs browser auth)

Versions are bumped and all three pack cleanly. **`mcp` is a minor bump, so the
adapter's dependency range moved to `^0.2.0`** — otherwise `^0.1.0` silently
refuses to resolve the new server and a deploy gets the old one.

```powershell
cd C:\Users\BASHIR\Documents\near-vault
git pull origin intents-rail

npm publish --workspace @floatonnear/mcp            --access public   # 0.2.0
npm publish --workspace @floatonnear/float-adapter  --access public   # 0.2.0
npm publish --workspace @floatonnear/create-float   --access public   # 0.3.0
```

One at a time, completing the browser auth before the next. `mcp` first — the
adapter depends on it. Check the **last line**: `+ @floatonnear/...@x.y.z` means
accepted; `PUT 401` / `authId` means the browser step timed out. A `PUT 202` is
*accepted and queued*, and the registry can take a few minutes to show it — the
npm log is authoritative, not the registry timestamp.

### Mainnet

**Nothing is required.** The deployed `float.test015.near` is unaffected: the
approval gate is inert with no threshold set, and nothing here was deployed.

If you later deploy the new contract, note it is 292 KB against the deployed
278 KB, so the vault needs ~0.14 NEAR more staked, and `scripts/upgrade-vault.sh`
runs `migrate` in the same transaction as the deploy. The three new reason codes
are **appended**, so no stored request is re-tagged (`persisted_reason_code_tags_are_pinned`
asserts the four persisted tags).

### Still outstanding from before

- **`deploy-vps.sh` has never run on a host.** Unchanged.
- **`test015.near`'s seed phrase is still in `~/.near-credentials`.** The vault
  key rotation pointed the vault at that wallet, so this is now the single key
  protecting it. Hardware wallet or a fresh owner via `propose_owner`.
- **`float.test015.near.json`** is inert (its key is off the account) but worth
  deleting so it is not mistaken for live credentials.

## One honest note on method

Five separate times this session a probe broke on shell escaping — backslashes
collapsing in a heredoc, `\r?\n` arriving as literal control characters, an
apostrophe ending a quote. My own memory file says to write anything containing
escapes with the editor rather than a heredoc, and I kept reaching for the
heredoc anyway. Every mutation harness here is now line-based and CRLF-aware for
that reason; the ones that matter were rewritten after producing a false result.

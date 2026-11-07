# Float on NEAR — project instructions

## Read these first, in this order

1. **`STATE.md`** — what is true right now. One page. Current vault, what works, what's broken,
   next 3 steps. If it disagrees with a doc in `docs/`, **`STATE.md` wins** and the doc is stale.
2. **`DECISIONS.md`** — settled calls with the **rejected alternative** and why. Before proposing
   anything, check whether it is already in a Rejected cell.
3. `SKILL.md` — the product/operator surface. Note it has known stale claims; `STATE.md` lists them.

Only then open `docs/`. It is ~290KB of long-form reasoning, parts of it superseded. `STATE.md`
has a "docs that contradict the code" section — read that before trusting any of it.

**This is a build project, not a security review.** Do not auto-load the smart-contract bounty
workflow, the bounty workspace, or the LLM Wiki recognition pass for ordinary work here. Those are
for auditing *other people's* targets. If you are specifically asked to audit this vault, load them
then.

## Closing out a session

If the session changed what is true — shipped something, broke something, learned a live-state
fact, changed the plan — **update `STATE.md` and re-stamp its commit line** before you finish:

```
<!-- STAMP commit=<short sha> date=<YYYY-MM-DD> -->
```

The SessionStart hook compares that stamp against `HEAD` and prints the drift. An unstamped update
is how a state doc silently becomes a lie. If a *decision* was made, append a row to
`DECISIONS.md` — including the alternative you rejected, which is the part that stops it being
re-litigated next week.

Keep `STATE.md` to one page. If it wants to grow, the detail belongs in `docs/` with a pointer.

## Hard rules, each earned from a real failure

- **Build the contract with `cargo near build`, never plain `cargo build`.** A plain build swaps in
  near-sdk's pure-Rust fallbacks ("not for on-chain use"), so every panic lands as "unreachable
  opcode" and reason-code messages vanish — silently, with tests still passing.
- **The gate is `node scripts/verify-all.mjs`**, not `npm test`. It asserts exit code **and** a
  must-appear pattern **and** a must-not-appear pattern, because a check that cannot run prints
  nothing and exits 0.
- **Never hardcode a deposit or funding figure.** Derive it from the bytes being sent, and quote
  `vault_create`'s own `totalRequiredNear`. Deposits have broken twice from a remembered number;
  a wallet checks the balance against the full amount, reservation included.
- **Never run the `create-float` CLI on someone else's behalf** — it needs a full-access key, which
  contradicts the product.
- **Mainnet actions are staged and human-run.** There is no mainnet factory, deliberately
  (`FACTORY_BY_NETWORK.mainnet = undefined`): guessing one wrong sends a real ~3.31 NEAR deposit to
  an unverified account. `deploy-factory-mainnet.mjs` is a separate file on purpose and needs
  `CONFIRM_MAINNET=1`.
- **`DeleteKey` on a funded gas key BURNS the balance and reports success** (0.08322 NEAR measured).
  Always `withdrawFromGasKey` first.
- **A function-call key cannot sign `DeleteAccount`.** This is why 11.3 NEAR is stranded forever
  across 19 agent accounts. Anything that funds an account an FC key controls is a permanent loss.
- Load `.float/adapter.env` as **data**, never `set -a && .` — the shell executes `$(...)` and
  backticks inside a value. This already died for real on one unquoted value with a space.
- `.float/fixture-*.json` and `.float/adapter.env` hold **live private keys**. Never `cat` them
  into a transcript; never quote their contents in a message or an error.

## Deadline

**NEAR Hackathon closes 2026-11-14 23:59 UTC.** As of 2026-11-07 the repo has no README, no pitch
and no demo script. That is the gap, not the code.

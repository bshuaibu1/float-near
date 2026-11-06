# scripts/

Everything here passes one test: **would someone run this again, unchanged?**

That is deliberately narrower than "was it useful". Most of what used to live
here was useful exactly once.

## If you are looking for a script a doc mentions and cannot find it

It was pruned, and it is still in git history. The docs that cite one are
recording **what was measured**, not telling you to run it — e.g.
"MEASURED 2026-11-01 by `scripts/measure-global-burn.sh`". The answer is in the
doc; the instrument is in history.

```bash
git log --diff-filter=D --oneline -- scripts/<name>   # find the removing commit
git show <sha>^:scripts/<name>                        # read it
git checkout <sha>^ -- scripts/<name>                 # bring it back
```

Note the `^`: the removing commit does not contain the file, its parent does.

## What is here, and why

**The gate.** `verify-all.mjs` runs everything and refuses to report a false
pass — it asserts an exit code, a must-appear pattern, and a must-not-appear
pattern, because a check that cannot run prints nothing and exits 0, which is
indistinguishable from success. It discovers `mutate-*.mjs` from disk rather
than listing them, so a deleted suite cannot linger as a silent pass.

**Build.** `build-wasm.sh`, `build-factory.sh` (fails loudly if the build did
nothing — `cargo near build` will print "✓ successfully built" and the stale
file's checksum in 0s), `wsl-sandbox.sh` (the only way to run the integration
tier at all; it cannot build on Windows, because the NEAR sandbox has no
Windows binary), `m21-plain-vs-cargo-near.sh` (builds the `res/m21/` fixtures
the `panic_reason_codes` tests load).

**Deploy and upgrade.** The runbooks: `deploy-*`, `upgrade-vault.sh`, and the
pre-flight checks that refuse rather than guess — `check-signer-key.mjs`,
`check-upgrade-margin.mjs` — plus `verify-upgrade.mjs` afterwards.

**Recover real money.** `teardown-vault.mjs`, `teardown-factory.mjs`,
`rotate-key.mjs`, `testnet-fund.mjs`, `fund-new-owner.mjs`.
`make-stub-wasm.mjs` belongs to this group despite its name: the teardowns
shrink an account with its 33-byte stub before deleting, and NEAR refuses the
delete without it.

**Operate and inspect.** MCP wiring (`mcp-dryrun.mjs`, `verify-mcp-json.mjs`,
`print-mcp-command.mjs`, `print-agent-env.mjs`), chain state (`policy-state`,
`gas-key-state`, `deployed-methods`, `check-balances`), wasm anatomy
(`wasm-hash`, `wasm-imports`, `wasm-sections`, `wasm-strings`).

**Local dev loop.** `start-stack.ps1`, `restart-*.ps1`,
`undo-preview-pollution.mjs`.

## What was removed, and why those three groups

1. **Applied codemods.** The source already contains their output, so
   re-running one double-applies or dies on a missing anchor. `wire-add-role`
   and `revert-add-role` were both present and undo each other — keeping
   either implies a repo state that does not exist.

2. **Measurement spikes.** The value is the answer, and the answer is in the
   commit message or `docs/`. Nobody re-measures a settled fact.

3. **One-time runs against accounts that are gone.** `recycle-approve-testnet`
   names `approve.floatv4.testnet`, which has been deleted. It cannot succeed,
   and its failure would read as a bug.

## Adding one

If it is a codemod or a measurement, run it and let it go — the commit message
is the artifact, not the file. If someone will run it again, it belongs here,
and `verify-all.mjs` should probably know about it.

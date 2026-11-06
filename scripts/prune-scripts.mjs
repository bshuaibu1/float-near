/**
 * Prune scripts/ down to the tooling that will be run again.
 *
 * THE TEST APPLIED TO EVERY FILE
 *
 * "Would someone run this again, unchanged, in the future?"
 *
 * That is the only question. It is NOT "was this useful" - almost all of them
 * were. Three groups fail it:
 *
 *   1. CODEMODS that have already been applied. The source now contains their
 *      output, so re-running one either double-applies or dies on a missing
 *      anchor. `wire-add-role.mjs` and `revert-add-role.mjs` are both here,
 *      and they undo each other - keeping either implies the repo is in a
 *      state it is not.
 *
 *   2. MEASUREMENT SPIKES. The value is the ANSWER, not the script, and the
 *      answer is already in the commit message, docs/, or project memory. The
 *      gas-key spikes are the clearest case: they established that a gas key
 *      pays its own way, that is now the architecture, and nobody re-measures
 *      a settled fact.
 *
 *   3. ONE-TIME VALIDATION RUNS against specific accounts that no longer
 *      exist. `recycle-approve-testnet.mjs` names approve.floatv4.testnet,
 *      which has been deleted; the script cannot succeed and its failure
 *      would be read as a bug.
 *
 * NOTHING IS LOST. Every deleted file stays in git history and is recoverable
 * with `git show <sha>:scripts/<name>`. The commit records the sha to use.
 *
 * WHAT WOULD MAKE THIS DANGEROUS, and is checked below rather than assumed:
 *   - deleting a file that verify-all.mjs discovers or invokes
 *   - deleting a file another KEPT script executes
 *   - deleting a file the docs tell a human to run, leaving a lying runbook
 */
import { readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const LF = String.fromCharCode(10);

/**
 * KEEP, with the reason each one survives. Grouped by what it is FOR, because
 * the grouping is the argument: these are build, deploy, recover, inspect,
 * and verify - the five things that recur.
 */
const KEEP = {
  // --- the verification gate -----------------------------------------
  "verify-all.mjs": "the gate; runs every check and refuses a false pass",
  "scan-invisible-chars.mjs": "invoked by verify-all",
  "check-fs-imports.mjs": "catches what `node --check` cannot: used-but-not-imported",
  "mutate-applied.mjs": "mutation suite, auto-discovered by verify-all",
  "mutate-cooldown.mjs": "mutation suite, auto-discovered by verify-all",
  "mutate-owner-plan.mjs": "mutation suite, auto-discovered by verify-all",
  "mutate-sign-link.mjs": "mutation suite, auto-discovered by verify-all",
  "mutate-watch.mjs": "mutation suite, auto-discovered by verify-all",

  // --- build ---------------------------------------------------------
  "build-wasm.sh": "builds the wasm the sandbox tests load",
  "build-factory.sh": "builds a wasm and FAILS if the build did nothing",
  // NOT bundle-wasm.mjs: it lives in packages/create-float/scripts/, and the
  // package.json path that names it is package-relative. A grep for
  // "scripts/bundle-wasm.mjs" matches both directories, which is how it
  // briefly got onto this list.
  "wsl-sandbox.sh": "the ONLY way to run the integration tier; it cannot build on Windows",
  // A FIXTURE BUILDER, not a measurement, despite the name. The two
  // panic_reason_codes sandbox tests load res/m21/*.wasm and skip loudly
  // without them, so deleting this would strand two tests permanently in
  // the skipped state. panic_reason_codes.rs names it directly.
  "m21-plain-vs-cargo-near.sh": "builds the res/m21 fixtures two sandbox tests load",
  "lib/shell-env.sh": "shared by the shell scripts",

  // --- deploy and upgrade (the runbooks) ------------------------------
  "deploy-testnet.sh": "runbook: deploy to testnet, refuses if the binary mismatches",
  "deploy-vps.sh": "runbook: the adapter under pm2",
  "deploy-factory-mainnet.mjs": "runbook: the factory on mainnet",
  "deploy-factory-testnet.mjs": "runbook: the factory on testnet",
  "upgrade-vault.sh": "runbook: in-place upgrade preserving state",
  "check-signer-key.mjs": "upgrade pre-flight: refuses a key that cannot sign",
  "check-upgrade-margin.mjs": "upgrade pre-flight: refuses an upgrade that will not fit",
  "verify-upgrade.mjs": "upgrade post-check: proves state survived",
  "global-is-published.mjs": "pre-publish check: is this hash already global?",

  // --- recover real money ---------------------------------------------
  "teardown-vault.mjs": "recovers everything a vault holds, in the order that works",
  // A REAL dependency of both teardowns, not a measurement helper: they
  // shrink an account with its 33-byte stub before deleting it, and NEAR
  // refuses the delete without that. The safety check below caught this
  // after I filed it under "wasm experiments".
  "make-stub-wasm.mjs": "builds the stub wasm the teardowns shrink an account with",
  "teardown-factory.mjs": "reclaims a factory's storage stake",
  "rotate-key.mjs": "replaces a full-access key with no dead window",
  "testnet-fund.mjs": "moves free testnet balance between held accounts",
  "fund-new-owner.mjs": "funds a fresh wallet enough to create a vault, and proves it",

  // --- operate ---------------------------------------------------------
  "print-agent-env.mjs": "emits the agent .env without re-minting a key",
  "print-mcp-command.mjs": "emits the MCP config, verified rather than guessed",
  "verify-mcp-json.mjs": "proves .mcp.json actually starts a working server",
  "mcp-dryrun.mjs": "exercises the MCP server over stdio, as a client would",
  "seed-demo.mjs": "stands up the demo budget tree",
  "sync-agent-nodes.mjs": "fills in node ids by asking the chain",
  "scan-blocked.mjs": "backfills refused payments from chain",
  "merge-blocked.mjs": "folds a backfill into the store the adapter follows",
  "check-credential-matches.mjs": "safety: does this credential control the account it names?",
  "intents-pay.mjs": "the cross-chain payment path, end to end",
  "intents-dryrun.mjs": "the same path, read-only, against a real NEP-141",
  "oneclick-probe.mjs": "read-only probe of the live 1Click API",

  // --- inspect ---------------------------------------------------------
  "check-balances.mjs": "balances for every testnet account we hold keys for",
  "gas-key-state.mjs": "an account's free balance and a gas key's own balance",
  "policy-state.mjs": "the policy the CONTRACT enforces, per node",
  "deployed-methods.mjs": "what the DEPLOYED contract actually exposes",
  "measure-vault-state.mjs": "what a vault's state costs, per component",
  "wasm-hash.mjs": "a wasm's global-contract code hash",
  "wasm-imports.mjs": "a wasm's real imports, by parsing the import section",
  "wasm-sections.mjs": "where a contract's bytes are, section by section",
  "wasm-strings.mjs": "what is in the data section",

  // --- local dev loop ---------------------------------------------------
  "start-stack.ps1": "brings up the whole local stack and verifies it",
  "restart-adapter.ps1": "rebuild + restart the adapter",
  "restart-dashboard.ps1": "restart the dashboard with a clean .next",
  "undo-preview-pollution.mjs": "reverts the config edits the preview harness makes",

  // --- this pruner and its record ---------------------------------------
  // Both are untracked the first time this runs, so `git ls-files` cannot see
  // them and they look safe. Once committed they become ordinary tracked
  // files, and a second run would classify them as doomed and delete the very
  // list that decides what is doomed. Confirmed rather than assumed: staging
  // them and re-running --dry-run duly listed README.md for removal. Naming
  // them here is what stops that, and it replaces an ad-hoc filter that only
  // covered the pruner and would have missed the README.
  "prune-scripts.mjs": "this file; the keep-list IS the policy, and it is auditable",
  "README.md": "explains the keep rule and how to recover a pruned script",
};

const all = execSync("git ls-files scripts", { encoding: "utf8" })
  .trim()
  .split(LF)
  .map((f) => f.replace(/^scripts\//, ""));

const keepNames = new Set(Object.keys(KEEP));
const doomed = all.filter((f) => !keepNames.has(f));

// A keep-list entry naming a file that does not exist is a silent no-op that
// makes the list look more careful than it is.
const phantom = [...keepNames].filter((k) => !all.includes(k));
if (phantom.length) {
  console.log(`  KEEP names ${phantom.length} file(s) that do not exist:`);
  for (const p of phantom) console.log(`    ${p}`);
  process.exit(1);
}

console.log(`  ${all.length} tracked, ${keepNames.size} kept, ${doomed.length} to remove`);

// --- SAFETY 1: does any KEPT file invoke a doomed one? --------------------
// EXECUTABLES ONLY. README.md is a kept file that describes the pruning, so
// it necessarily names pruned scripts in prose - scanning it here reported
// measure-global-burn.sh as "invoked by a kept script" and blocked the run.
// Documentation cannot invoke anything; only something runnable can.
const keptSource = [...keepNames]
  .filter((f) => /\.(mjs|sh|ps1)$/.test(f))
  .map((f) => {
    try {
      return readFileSync(`scripts/${f}`, "utf8");
    } catch {
      return "";
    }
  })
  .join(LF);

const brokenKeeps = doomed.filter((d) =>
  new RegExp(`scripts[/\\\\]${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(keptSource),
);

// --- SAFETY 2: do the docs tell a human to run a doomed one? --------------
const docFiles = execSync("git ls-files *.md docs", { encoding: "utf8" }).trim().split(LF).filter(Boolean);
const docSource = docFiles
  .map((f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  })
  .join(LF);

const docRefs = doomed.filter((d) =>
  new RegExp(`scripts[/\\\\]${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(docSource),
);

if (brokenKeeps.length) {
  console.log(`  BLOCKED: ${brokenKeeps.length} doomed file(s) are invoked by a KEPT script:`);
  for (const b of brokenKeeps) console.log(`    ${b}`);
  process.exit(1);
}

if (docRefs.length) {
  console.log(`  ${docRefs.length} doomed file(s) are named in docs - those docs need updating:`);
  for (const d of docRefs) console.log(`    ${d}`);
}

if (process.argv.includes("--dry-run")) {
  console.log(LF + "  would remove:");
  for (const d of doomed) console.log(`    ${d}`);
  process.exit(0);
}

for (const d of doomed) unlinkSync(`scripts/${d}`);
console.log(`  removed ${doomed.length} file(s)`);

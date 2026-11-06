import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

import { wantsHelp, usage } from "../bin/args.mjs";
import { vaultFunding } from "../bin/funding.mjs";

/**
 * `--help` must print usage and touch nothing.
 *
 * Measured 2026-10-30, immediately after the first publish: the documented
 * discovery command
 *
 *   npx -y @floatonnear/create-float --help
 *
 * ignored the flag entirely, ran preflight, and prompted "Your NEAR testnet
 * account:" — i.e. a user asking what this tool does was dropped into an
 * interactive flow that goes on to create accounts and spend NEAR.
 *
 * Two things make that worse than a missing feature:
 *
 *   - preflight runs FIRST, so a user who has never installed near-cli gets
 *     "no testnet credentials at ..." in answer to `--help`. The one command
 *     that should work on a machine with nothing set up was the one command
 *     guaranteed to fail there.
 *   - `--help` is what someone types when they are NOT ready to act. Answering
 *     it with a prompt inverts that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RES_WASM = resolve(HERE, "..", "res", "vault.wasm");
const BIN = resolve(HERE, "..", "bin", "create-float.mjs");

test("wantsHelp recognises the forms people actually type", () => {
  for (const argv of [["--help"], ["-h"], ["help"], ["--network", "mainnet", "--help"]]) {
    assert.equal(wantsHelp(argv), true, `expected help for ${JSON.stringify(argv)}`);
  }
});

test("wantsHelp is false for a real invocation", () => {
  assert.equal(wantsHelp([]), false);
  assert.equal(wantsHelp(["--owner", "alice.near", "--network", "mainnet"]), false);
});

test("wantsHelp is not fooled by a value that merely contains help", () => {
  // `--owner help.near` is a (strange but legal) account, not a request for
  // usage. Matching substrings here would refuse to run for that user.
  assert.equal(wantsHelp(["--owner", "help.near"]), false);
  assert.equal(wantsHelp(["--vault", "helpdesk.near"]), false);
});

test("usage names every flag parseArgs actually reads", () => {
  // Drift guard: a flag that exists but is undocumented is invisible, and a
  // documented flag that does not exist is a lie. Both have happened in this
  // repo's docs.
  const text = usage();
  for (const flag of [
    "--network",
    "--owner",
    "--vault",
    "--token",
    "--decimals",
    "--agents",
    "--rpc",
    "--dry-run",
    "--yes",
  ]) {
    assert.ok(text.includes(flag), `usage() does not mention ${flag}`);
  }
});

test("REAL SOURCE: usage names every flag the wizard actually reads", () => {
  // The test above has a HAND-MAINTAINED list, and on 2026-10-31 it drifted:
  // `--fund` was read at create-float.mjs:379, told to the user by
  // token-setup.mjs and handoff.mjs ("re-run with --fund <amount>"), documented
  // in SKILL.md's one-liner — and absent from `usage()`. Its own comment says
  // "a flag that exists but is undocumented is invisible", which is exactly
  // what happened, because the guard needed a human to remember the thing the
  // human had already forgotten.
  //
  // So this one derives the list from the SOURCE. A new flag is documented or
  // this test fails; nobody has to remember anything.
  const text = usage();
  // BOTH files, and that split is the point: `parseArgs` in args.mjs reads most
  // of them, while a few (--fund among them) are read straight from argv in the
  // wizard. Scanning only one file found 6 of 11 — caught here because this
  // test states the expected count before trusting the match, rather than
  // reading a short list as "nothing undocumented".
  const flags = new Set();
  for (const f of ["create-float.mjs", "args.mjs"]) {
    const src = readFileSync(join(HERE, "..", "bin", f), "utf8");
    for (const m of src.matchAll(/"(--[a-z0-9-]+)"/g)) flags.add(m[1]);
  }
  // --help is answered before parseArgs and documented as `-h, --help`.
  flags.delete("--help");
  assert.ok(flags.size >= 10, `only found ${flags.size} flags — the matcher is probably broken`);
  const undocumented = [...flags].filter((f) => !text.includes(f)).sort();
  assert.deepEqual(undocumented, [], `flags the wizard reads but usage() never mentions`);
});

test("REAL DATA: usage() never UNDERSTATES what the wizard will demand", () => {
  // THE BUG THIS CATCHES, found by driving the published 0.3.1 from outside the
  // repo. `usage()` hardcoded "3.341 NEAR for a bare vault" while the wizard
  // demanded **3.347** — because the contract grew 299,016 -> 299,620 bytes
  // after that string was written, and `VAULT_FUNDING` is derived from the
  // artifact while the help text was not.
  //
  // 0.006 NEAR, so a user topping up to exactly the figure in `--help` is
  // refused by the affordability gate. That is the SAME failure mode 0.3.1 set
  // out to fix when SKILL.md said "~3" against a real 3.341 — reintroduced one
  // commit later, an order of magnitude smaller, by me.
  //
  // The sibling test below compares to ONE decimal, deliberately loose so a few
  // kilobytes of contract growth do not churn the docs. That tolerance is why
  // it stayed green through a 0.006 drift. This one is exact and one-sided:
  // usage() may round UP, never down.
  const bytes = statSync(RES_WASM).size;
  const bare = Number(vaultFunding(bytes)) / 1e24;
  const withAgent = bare + 0.12; // a VIRTUAL agent: gasKeyFunding() default
  const ceil3 = (n) => (Math.ceil(n * 1000) / 1000).toFixed(3);

  const text = usage();
  // Every three-decimal figure, NOT `(\d+\.\d{3})\s*NEAR` — the first version
  // required the word NEAR to follow and found only ONE of the two, because the
  // sentence reads "3.341 NEAR for a bare vault, 3.891 with one agent" and the
  // second figure has no unit after it. The count assertion below is what
  // caught that; without it a one-figure match would have silently half-checked.
  const quoted = [...text.matchAll(/\b(\d+\.\d{3})\b/g)].map((m) => Number(m[1]));
  assert.ok(
    quoted.length >= 2,
    `usage() quotes ${quoted.length} three-decimal figures; expected the bare and agent totals`,
  );

  const lowest = Math.min(...quoted);
  assert.ok(
    lowest + 1e-9 >= bare,
    `usage() quotes ${lowest} NEAR but the wizard demands at least ${bare.toFixed(5)} ` +
      `for a ${bytes}-byte contract — the help UNDERSTATES it`,
  );
  assert.ok(text.includes(ceil3(bare)), `usage() does not quote the derived bare-vault figure ${ceil3(bare)}`);
  assert.ok(
    text.includes(ceil3(withAgent)),
    `usage() does not quote the derived one-agent figure ${ceil3(withAgent)}`,
  );
});

test("usage says what it will spend, because the next step costs real money", () => {
  const text = usage();
  assert.match(text, /NEAR/);
  assert.match(text, /mainnet/);
});

test("REACHABILITY: --help exits 0 and prints usage with NO NEAR setup present", () => {
  // The whole point. Pointed at an empty credentials dir, which is what a new
  // machine looks like — this must still answer, so it has to return before
  // preflight.
  const empty = mkdtempSync(join(tmpdir(), "float-nocreds-"));
  const out = execFileSync(process.execPath, [BIN, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NEAR_CREDENTIALS_DIR: join(empty, "does-not-exist") },
  });
  assert.match(out, /--network/);
  assert.doesNotMatch(out, /Preflight/, "--help ran preflight; it must return before that");
  // The preflight failure is `no <network> credentials at <dir>`. Matching bare
  // /credentials/ was wrong: usage() legitimately tells the reader their key
  // lives in ~/.near-credentials, so the first version of this test failed on
  // its own help text rather than on a defect.
  assert.doesNotMatch(out, /credentials at /, "--help reported a credentials problem");
  assert.doesNotMatch(out, /account:/, "--help prompted for input");
});

test("REACHABILITY: -h behaves identically", () => {
  const out = execFileSync(process.execPath, [BIN, "-h"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(out, /--network/);
});

test("the wizard's top-level catch does not process.exit with RPC in flight", () => {
  // MEASURED against the published 0.3.1, from outside the repo. A mainnet
  // dry-run that failed its affordability check printed the error correctly and
  // then aborted:
  //
  //   failed  insufficient balance: need 3.347, have 0.177
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
  //
  // `main()` has made RPC calls by then, and `process.exit` tears the event loop
  // down while a handle is still closing. The user still sees the message, so it
  // is cosmetic for a human — but the exit code becomes -1073740791 instead of
  // 1, so anything SCRIPTING the wizard sees a native crash rather than a clean
  // failure. Same bug this repo already fixed in check-signer-key.mjs and
  // check-upgrade-margin.mjs, which is why the root suite has the equivalent
  // guard for `scripts/`; the wizard was simply outside its scope.
  //
  // Only the top-level catch matters. The three other process.exit calls in the
  // wizard are at MODULE SCOPE, before any network I/O, where exiting
  // immediately is both safe and what you want.
  const src = readFileSync(BIN, "utf8");
  const tail = src.slice(src.indexOf("main().catch("));
  assert.ok(tail.length > 0, "could not find the top-level catch — this scan is measuring nothing");
  assert.ok(
    !/process\.exit\(/.test(tail),
    "the top-level catch calls process.exit(); set process.exitCode so the loop can drain",
  );
  assert.match(tail, /process\.exitCode/, "the top-level catch does not set an exit code at all");
});

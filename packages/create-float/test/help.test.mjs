import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { wantsHelp, usage } from "../bin/args.mjs";

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

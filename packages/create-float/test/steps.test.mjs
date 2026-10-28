import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";

/**
 * Step ordering, by running the real CLI.
 *
 * HOW THIS IS HERMETIC, since a subprocess test usually is not. Two seams make
 * it so, and both already existed for this purpose:
 *
 *   - `NEAR_CREDENTIALS_DIR` redirects the keychain lookup, so preflight and
 *     the owner-key read work against a scratch directory. The wizard's own
 *     comment says why it exists: "a wizard whose only test path runs against
 *     the real keychain is a wizard nobody tests."
 *   - `--rpc http://127.0.0.1:1` points the first network call at a closed
 *     local port. It fails instantly, with no DNS and no internet, so the run
 *     is deterministic offline AND on a plane.
 *
 * WHAT IS BEING ASSERTED, and why it is ordering rather than output. The whole
 * point of f69e9d0 was "preflight before the bill, not after it": the wasm and
 * credential checks used to run at step 5, AFTER the plan was confirmed and two
 * accounts had been created and funded, so discovering there was nothing to
 * deploy left a half-built vault and real NEAR spent. That is a property of the
 * ORDER, invisible to any test of the individual steps.
 *
 * WHAT IT STILL CANNOT REACH. The `--dry-run` gate sits AFTER
 * `await ownerAcct.getBalance()`, so a hermetic run dies at step 3 and cannot
 * observe it. Steps 4 onwards spend real NEAR and are not exercised here by
 * design — nothing in this file is allowed to send a transaction.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "create-float.mjs");
const DEAD_RPC = "http://127.0.0.1:1";

/** Run the CLI and capture stdout+stderr and the exit code, never throwing. */
function run(args, { creds } = {}) {
  const env = { ...process.env };
  if (creds) env.NEAR_CREDENTIALS_DIR = creds;
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (e) {
    return {
      code: e.status ?? 1,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

/** A scratch keychain holding one usable credential file. */
function scratchCreds(network, account) {
  const kp = KeyPair.fromRandom("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "cf-creds-"));
  mkdirSync(join(dir, network), { recursive: true });
  writeFileSync(
    join(dir, network, `${account}.json`),
    JSON.stringify({
      account_id: account,
      public_key: kp.getPublicKey().toString(),
      // GENERATED, not a literal. Two reasons. A key-shaped string committed to
      // a repo reads as a leak to anyone scanning, and more importantly it must
      // be VALID: a malformed key throws while the signer is built, so the run
      // would stop at key-parsing and the test would claim to prove "stops at
      // the first network call" while actually proving something weaker. This
      // key is valid, controls nothing, and is discarded with the temp dir.
      private_key: kp.toString(),
    }),
    "utf8",
  );
  return dir;
}

/**
 * Strip ANSI before matching. The step headers are emitted as
 * `\x1b[1m[0]\x1b[0m Preflight`, so a naive /\[(\d)\]\s/ finds nothing — the
 * `]` is followed by an escape sequence, not a space. Matching raw output here
 * silently returned an empty step list, which read as "no steps ran" rather
 * than "the matcher cannot see them". Same hazard as asserting on coloured
 * text anywhere else.
 */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The indices of the `[N] Title` step headers, in the order printed. */
const stepOrder = (out) => [...plain(out).matchAll(/\[(\d)\]\s+\w/g)].map((m) => Number(m[1]));

test("an unknown network exits 2 before any step runs", () => {
  const r = run(["--network", "betanet"]);
  assert.equal(r.code, 2);
  assert.match(plain(r.out), /Unknown network 'betanet'/);
  assert.deepEqual(stepOrder(r.out), [], "no step may run once the network is rejected");
});

test("preflight runs FIRST, and a preflight failure stops everything after it", () => {
  // The scratch dir has no `<network>/` subdirectory, so the credentials check
  // inside step 0 fails. This is the f69e9d0 property: nothing downstream may
  // run, because downstream is where accounts get created and funded.
  const empty = mkdtempSync(join(tmpdir(), "cf-nocreds-"));
  try {
    const r = run(["--network", "testnet", "--yes", "--owner", "me.testnet", "--rpc", DEAD_RPC], {
      creds: empty,
    });
    assert.notEqual(r.code, 0, "a failed preflight must be a non-zero exit");
    const steps = stepOrder(r.out);
    assert.deepEqual(steps, [0], `only preflight may have run, got steps ${steps}`);
    assert.match(plain(r.out), /\[0\]\s+Preflight/);
    assert.doesNotMatch(plain(r.out), /\[4\]/, "step 4 creates the vault account — it must not be reached");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("steps run in ascending order, and stop at the first network call", () => {
  const creds = scratchCreds("testnet", "me.testnet");
  try {
    const r = run(
      ["--network", "testnet", "--yes", "--owner", "me.testnet", "--vault", "v.me.testnet", "--rpc", DEAD_RPC],
      { creds },
    );
    const steps = stepOrder(r.out);

    // 0, 1, 2 complete without a network: preflight is filesystem-only, the
    // owner key is read from disk, and step 2 takes decimals from a flag.
    assert.deepEqual(steps, [0, 1, 2, 3], `expected 0,1,2,3 then a stop, got ${steps}`);
    assert.deepEqual([...steps].sort((a, b) => a - b), steps, "step numbers must be ascending");

    // Step 3 prints the plan and then reads the balance, which is where a dead
    // RPC stops it. Reaching 4 would mean money moved.
    assert.doesNotMatch(plain(r.out), /\[4\]/, "must not reach step 4 with no reachable RPC");
    assert.notEqual(r.code, 0);
  } finally {
    rmSync(creds, { recursive: true, force: true });
  }
});

test("the plan is printed BEFORE the run can spend anything", () => {
  // "Show the bill first" is principle 1 in the file's own header. The tree and
  // the cost must appear in the output of a run that never reaches step 4.
  const creds = scratchCreds("testnet", "me.testnet");
  try {
    const r = run(
      ["--network", "testnet", "--yes", "--owner", "me.testnet", "--vault", "v.me.testnet", "--rpc", DEAD_RPC],
      { creds },
    );
    const txt = plain(r.out);
    const planAt = txt.indexOf("[3]");
    const treeAt = txt.indexOf("/day,");
    const costAt = txt.indexOf("you send");
    assert.ok(planAt >= 0, "the plan step must be reached");
    assert.ok(treeAt > planAt, "the tree must print inside the plan");
    assert.ok(costAt > treeAt, "the cost must print after the tree, before any spend");
    assert.doesNotMatch(plain(r.out), /\[4\]/);
  } finally {
    rmSync(creds, { recursive: true, force: true });
  }
});

test("--agents rejects a non-numeric value, and does so before spending", () => {
  const creds = scratchCreds("testnet", "me.testnet");
  try {
    const r = run(
      ["--network", "testnet", "--yes", "--owner", "me.testnet", "--vault", "v.me.testnet",
       "--agents", "3abc", "--rpc", DEAD_RPC],
      { creds },
    );
    assert.notEqual(r.code, 0);
    assert.match(plain(r.out), /--agents expects a number or "all", got "3abc"/);
    assert.doesNotMatch(plain(r.out), /\[4\]/, "a bad flag must not get as far as creating accounts");
  } finally {
    rmSync(creds, { recursive: true, force: true });
  }
});

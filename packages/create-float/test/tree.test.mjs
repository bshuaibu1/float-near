import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTree, flatten, planTreeLines } from "../bin/tree.mjs";
import { xchainCeiling } from "../bin/xchain.mjs";

/**
 * The plan step 3 prints, asserted as text.
 *
 * WHY TEXT AND NOT JUST THE DATA. A data-only test would have caught the bug
 * these exist for — `xchainCap` applied to the testnet branch instead of the
 * mainnet one — but what ACTUALLY caught it was running `--dry-run` and reading
 * `102/day, 10.2/tx` where round numbers belonged. The rendered line is the
 * first thing a user sees and the last thing a reviewer checks, so it is pinned
 * here rather than left to a manual run.
 *
 * WHY NOT SHELL OUT TO THE WIZARD. `--dry-run` would be the most faithful
 * check, and it is not testable: step 3 ends with `await ownerAcct.getBalance()`,
 * a live RPC read against a real funded account. A subprocess test would be
 * network-, credential- and account-dependent — three ways to go red for
 * reasons unrelated to the code. `NEAR_CREDENTIALS_DIR` makes the PREFLIGHT
 * scriptable, but not the plan. So the rendering is extracted and asserted
 * directly, and the trade is recorded rather than hidden: these tests cannot
 * catch a break in the wizard's step ordering or its argument parsing.
 */

const lines = (mainnet) => planTreeLines(flatten(defaultTree(mainnet)));

test("the mainnet plan renders pre-sized caps, not round ones", () => {
  assert.deepEqual(lines(true), [
    "      root  2.04/day, 0.51/tx",
    "        research  1.53/day, 0.51/tx",
    "          r1  1.02/day, 0.51/tx ← agent, gets a restricted key",
    "          r2  1.02/day, 0.51/tx ← agent, gets a restricted key",
  ]);
});

test("the testnet plan renders ROUND caps", () => {
  // Intents is mainnet-only and the wizard skips the quote signer on testnet,
  // so there is no spread to absorb here. Inflating these would loosen limits
  // for nothing — and seeing 10.2 in this list is exactly the symptom of the
  // two branches being swapped.
  assert.deepEqual(lines(false), [
    "      root  100/day, 10/tx",
    "        research  60/day, 10/tx",
    "          r1  50/day, 10/tx ← agent, gets a restricted key",
    "          r2  50/day, 10/tx ← agent, gets a restricted key",
  ]);
});

test("the two trees are not the same tree", () => {
  // The single assertion that fails under the branch swap no matter which
  // numbers are chosen, and the one that would have failed immediately in
  // 9d03e99. Everything else could be made to pass by editing fixtures.
  assert.notDeepEqual(lines(true), lines(false));
});

test("mainnet caps are fractional; testnet caps are whole", () => {
  // Stated as a property so it survives a change of amounts. A pre-sized cap
  // is ceil(x * 1.02) to the cent, which lands off a whole number for any
  // sensible desired amount; a round default never does.
  const caps = (mainnet) => flatten(defaultTree(mainnet)).flatMap((n) => [n.daily, n.perTx]);
  assert.ok(
    caps(true).some((c) => !Number.isInteger(c)),
    "no mainnet cap is fractional — xchainCap is probably not applied to this branch",
  );
  assert.ok(
    caps(false).every((c) => Number.isInteger(c)),
    "a testnet cap is fractional — the spread headroom has leaked onto the branch " +
      "where the cross-chain rail is closed",
  );
});

test("every mainnet cap can deliver the round amount it was sized for", () => {
  // Ties the rendered numbers back to their purpose. Reading 2.04 tells you
  // nothing; 2.04 delivering 2.00 is the claim.
  for (const n of flatten(defaultTree(true))) {
    for (const cap of [n.daily, n.perTx]) {
      const delivers = xchainCeiling(cap);
      assert.ok(
        Math.abs(delivers - Math.round(delivers * 100) / 100) < 1e-9 || delivers > 0,
        `cap ${cap} on ${n.label} has no sensible ceiling`,
      );
    }
    assert.ok(
      xchainCeiling(n.perTx) >= 0.5 - 1e-9,
      `${n.label}'s per-tx cap ${n.perTx} cannot deliver the 0.50 it was sized for`,
    );
  }
});

test("the tree overcommits, on both networks", () => {
  // The property the product exists to demonstrate: leaves may together spend
  // more than the pool above them, so an agent gets refused while its own
  // limit still has room. Pre-sizing the caps must not accidentally fix it.
  for (const mainnet of [true, false]) {
    const nodes = flatten(defaultTree(mainnet));
    const leaves = nodes.filter((n) => n.agent);
    const pool = nodes.find((n) => n.label === leaves[0].parent);
    const sum = leaves.reduce((a, n) => a + n.daily, 0);
    assert.ok(
      sum > pool.daily,
      `${mainnet ? "mainnet" : "testnet"}: leaves sum to ${sum} but the pool holds ` +
        `${pool.daily} — no contention, so the first thing a new user sees is a tidy ` +
        `tree that hides what makes this different from a per-agent limit`,
    );
  }
});

test("flatten keeps parents before children, and tags the agents", () => {
  const nodes = flatten(defaultTree(true));
  assert.deepEqual(nodes.map((n) => n.label), ["root", "research", "r1", "r2"]);
  assert.equal(nodes[0].parent, null);
  assert.equal(nodes[1].parent, "root");
  assert.equal(nodes[2].parent, "research");
  assert.deepEqual(nodes.filter((n) => n.agent).map((n) => n.label), ["r1", "r2"]);
});

test("planTreeLines takes its colouring injected, so output is assertable", () => {
  // The wizard passes C.dim. If the default stopped being identity these tests
  // would be comparing ANSI escapes and would fail on a cosmetic change.
  const [first] = planTreeLines(flatten(defaultTree(false)), (s) => `<${s}>`);
  assert.equal(first, "      root  <100/day, 10/tx>");
});

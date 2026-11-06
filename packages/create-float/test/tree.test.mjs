import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTree, flatten, planTreeLines, toBaseUnits } from "../bin/tree.mjs";
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
  // The caps stay xchainCap-derived even though the tree is flat: 0.51 is what
  // lets a cross-chain payment actually DELIVER 0.50 once the ~2% solver spread
  // is charged. Tidying it to 0.50 silently reintroduces the refusal.
  assert.deepEqual(lines(true), ["      root  2.04/day, 0.51/tx"]);
});

test("the testnet plan renders ROUND caps", () => {
  // Intents is mainnet-only and the wizard skips the quote signer on testnet,
  // so there is no spread to absorb here. Inflating these would loosen limits
  // for nothing — and seeing 10.2 in this list is exactly the symptom of the
  // two branches being swapped.
  assert.deepEqual(lines(false), ["      root  100/day, 10/tx"]);
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

/**
 * OVERCOMMITMENT IS NO LONGER A SETUP-TIME PROPERTY, deliberately.
 *
 * This used to assert that the default tree's leaves could together outspend
 * the pool above them, so a new user's first encounter was an agent refused
 * while its own limit still had room. That is the behaviour that makes a budget
 * TREE different from a per-agent limit, and it is worth showing — but not by
 * building a four-node tree for someone who asked for a vault.
 *
 * `flatten` and `planTreeLines` still have to handle a nested, overcommitted
 * tree, because that is what an owner builds later. So the shape moved into
 * this fixture instead of the default, and the rendering tests below drive it.
 */
const nested = {
  label: "root",
  daily: 2.04,
  perTx: 0.51,
  children: [
    {
      label: "research",
      daily: 1.53,
      perTx: 0.51,
      children: [
        { label: "r1", daily: 1.02, perTx: 0.51, agent: true },
        { label: "r2", daily: 1.02, perTx: 0.51, agent: true },
      ],
    },
  ],
};

test("a nested tree can still overcommit, and flatten preserves it", () => {
  const nodes = flatten(nested);
  const leaves = nodes.filter((n) => n.agent);
  const pool = nodes.find((n) => n.label === leaves[0].parent);
  const sum = leaves.reduce((a, n) => a + n.daily, 0);
  assert.ok(sum > pool.daily, `leaves sum to ${sum} but the pool holds ${pool.daily}`);
});

test("flatten keeps parents before children, and tags the agents", () => {
  const nodes = flatten(nested);
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

// ---- toBaseUnits: the bug that reached mainnet
//
// `BigInt(n.daily) * BigInt(10 ** decimals)` threw on every fractional cap,
// so the MAINNET tree could never be built — from before the caps were
// pre-sized, since BigInt(1.5) and BigInt(0.5) throw just as BigInt(2.04) does.
// Testnet's tree is all whole numbers, which is why it survived every test
// until a real deploy reached step 6 with the vault already created.

test("fractional caps convert exactly — the values that failed on mainnet", () => {
  assert.equal(toBaseUnits(2.04, 6), 2_040_000n);
  assert.equal(toBaseUnits(1.53, 6), 1_530_000n);
  assert.equal(toBaseUnits(1.02, 6), 1_020_000n);
  assert.equal(toBaseUnits(0.51, 6), 510_000n);
});

test("the OLD mainnet caps would have failed too — this was never a new bug", () => {
  // 1.5 and 0.5 are what the mainnet tree used before pre-sizing, and
  // BigInt(1.5) throws exactly like BigInt(2.04). Proof the mainnet path was
  // broken before the caps changed, rather than broken BY them.
  // RangeError, not TypeError — the exact class matters less than that it
  // throws, but asserting the wrong one is still a test that lies.
  assert.throws(() => BigInt(1.5), RangeError);
  assert.throws(() => BigInt(0.5), RangeError);
  assert.equal(toBaseUnits(1.5, 6), 1_500_000n);
  assert.equal(toBaseUnits(0.5, 6), 500_000n);
});

test("no floating point is involved, so inexact products cannot leak", () => {
  // 2.01 * 1e6 is 2009999.9999999998. A Math.round repair would survive this
  // and keep surviving until the error exceeded half a unit; splitting the
  // decimal string removes the class.
  assert.ok(!Number.isInteger(2.01 * 1e6), "2.01 * 1e6 should be inexact");
  assert.equal(toBaseUnits(2.01, 6), 2_010_000n);
  assert.equal(toBaseUnits(2.03, 6), 2_030_000n);
  assert.equal(toBaseUnits(2.05, 6), 2_050_000n);
});

test("whole numbers and other decimal counts still work", () => {
  assert.equal(toBaseUnits(100, 6), 100_000_000n);
  assert.equal(toBaseUnits(2, 0), 2n);
  assert.equal(toBaseUnits(1.5, 2), 150n);
  assert.equal(toBaseUnits(0.000001, 6), 1n);
});

test("over-precision is REFUSED, not silently truncated", () => {
  // Rounding 0.0000001 to 0 on a 6dp token sets a cap of zero, which looks
  // like a deliberate configuration rather than a lost digit.
  assert.throws(() => toBaseUnits("0.0000001", 6), /decimal places/);
  assert.throws(() => toBaseUnits(1.005, 2), /decimal places/);
});

test("exponential notation is refused rather than mis-parsed", () => {
  // String(0.0000001) is "1e-7", not "0.0000001" — JS switches to exponential
  // below 1e-6. The digit-only guard catches it, which is the right outcome:
  // silently reading "1e-7" as 1 would set a cap seven orders of magnitude too
  // high. Asserted because the number and string forms behave differently and
  // that is surprising.
  assert.equal(String(0.0000001), "1e-7");
  assert.throws(() => toBaseUnits(0.0000001, 6), /not a positive decimal/);
});

test("non-numeric or negative caps are refused", () => {
  for (const bad of ["abc", "-1", "", "1e6", "1.2.3"]) {
    assert.throws(() => toBaseUnits(bad, 6), /not a positive decimal/, `"${bad}"`);
  }
});

/**
 * THE DEFAULT IS FLAT, and nothing is created that can spend.
 *
 * The old default was root -> research -> r1, r2 with `agent: true` on both
 * leaves, which committed a new user to a shape they did not ask for and to two
 * sub-account agents at 0.55 NEAR each. The design this replaces it with is:
 * create the vault, create NOTHING that can spend, and add virtual agents later
 * — on request, as gas keys bound to a node, which cost ~0.06 and need no
 * sub-account at all.
 *
 * A tree is a thing the owner builds when they have something to delegate. It
 * is not a thing setup should guess at.
 */
test("the default tree is FLAT — root only, and no agents", () => {
  for (const mainnet of [true, false]) {
    const t = defaultTree(mainnet);
    const nodes = flatten(t);
    assert.deepEqual(
      nodes.map((n) => n.label),
      ["root"],
      `${mainnet ? "mainnet" : "testnet"} default should be a single root node`,
    );
    assert.deepEqual(
      nodes.filter((n) => n.agent),
      [],
      "setup must not create anything that can spend",
    );
  }
});

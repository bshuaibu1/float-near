/**
 * The default budget tree, and the lines the wizard prints for it.
 *
 * Extracted from create-float.mjs so both can be asserted. That file calls
 * `main()` unconditionally, so a test importing it would launch the wizard, and
 * its `--dry-run` path is not testable either: step 3 ends with
 * `await ownerAcct.getBalance()`, a live RPC read that needs a real funded
 * account. A subprocess test would therefore be network-, credential- and
 * account-dependent — three ways to go red for reasons that have nothing to do
 * with the code. Pure functions here, asserted directly.
 *
 * WHY THE RENDERER IS IN HERE TOO. The bug this exists to prevent was not in
 * the numbers, it was in WHICH TREE GOT THEM — `xchainCap` applied to the
 * testnet branch instead of the mainnet one. A test over the data alone would
 * have caught that. But the thing that actually caught it was reading the
 * rendered plan, so the rendering is pinned as well: a tree whose caps are
 * right and whose output shows the wrong node's numbers is still a bug the user
 * sees first.
 */
import { xchainCap } from "./xchain.mjs";

/**
 * The default tree deliberately OVERCOMMITS: the leaves may together spend more
 * than the pool above them, so a new user's first encounter is an agent refused
 * while its own limit still has room. A tidy non-overlapping tree would hide
 * the behaviour that makes this different from a per-agent spending limit.
 *
 * MIND WHICH BRANCH IS WHICH. Mainnet gets the SMALL tree — real money, sized
 * so a total loss is a rounding error. Testnet gets the GENEROUS one — fake
 * tokens, sized to make the hierarchy legible. Reading these backwards is the
 * mistake that shipped in 9d03e99 and was fixed in e00c5bb.
 */
export function defaultTree(mainnet) {
  return mainnet
    ? {
        // CAPS PRE-SIZED FOR THE CROSS-CHAIN SPREAD, via xchainCap(). The
        // numbers in the calls are what the operator wants to DELIVER; the caps
        // come out ~2% above so a quote's amountIn fits. A derivation rather
        // than a literal 0.51, because a bare 0.51 invites someone to tidy it
        // back to 0.50, which silently reintroduces the refusal.
        //
        // This tree's scale is where the spread is WORST. Measured live:
        // delivering 0.50 is charged 0.507579 (1.52%), so a flat 0.50 per-tx
        // cap cannot deliver 0.50 cross-chain at all.
        //
        // These caps apply to BOTH rails: 0.51 lets a NearDirect payment spend
        // 0.51, not 0.50. That is a real 2% loosening, bought to make round
        // cross-chain amounts clear, and the wizard says so rather than leaving
        // it to be discovered.
        label: "root",
        daily: xchainCap(2),
        perTx: xchainCap(0.5),
        children: [
          {
            label: "research",
            daily: xchainCap(1.5),
            perTx: xchainCap(0.5),
            children: [
              { label: "r1", daily: xchainCap(1), perTx: xchainCap(0.5), agent: true },
              { label: "r2", daily: xchainCap(1), perTx: xchainCap(0.5), agent: true },
            ],
          },
        ],
      }
    : {
        // Testnet. ROUND CAPS, deliberately NOT pre-sized: Intents is
        // mainnet-only (packages/mcp/src/quote.ts:27) and the wizard skips the
        // quote signer here, so the cross-chain rail is closed and there is no
        // spread to absorb. Inflating these would loosen limits for nothing.
        label: "root",
        daily: 100,
        perTx: 10,
        children: [
          {
            label: "research",
            daily: 60,
            perTx: 10,
            children: [
              { label: "r1", daily: 50, perTx: 10, agent: true },
              { label: "r2", daily: 50, perTx: 10, agent: true },
            ],
          },
        ],
      };
}

/**
 * Human amount -> base units, EXACTLY, without touching floating point.
 *
 * `BigInt(n.daily) * BigInt(10 ** decimals)` was the original, and it threw on
 * every fractional cap: `BigInt(2.04)` is a TypeError, because BigInt refuses
 * any non-integer. So did `BigInt(1.5)` and `BigInt(0.5)` — meaning the MAINNET
 * tree never worked, from before the caps were pre-sized. Testnet's tree is
 * 100/60/50/10, all whole, which is why it went unnoticed until a real mainnet
 * deploy reached step 6 with the vault already created and funded.
 *
 * The obvious repair is `BigInt(Math.round(human * 10 ** decimals))`, and for
 * TODAY's caps it would work — 2.04, 1.53, 1.02 and 0.51 all multiply to exact
 * integers at 1e6. That is luck, not a property. Neighbouring values do not:
 *
 *     2.01 * 1e6 = 2009999.9999999998
 *     2.03 * 1e6 = 2029999.9999999998
 *     2.05 * 1e6 = 2049999.9999999998
 *
 * So anyone choosing 2.01 as a cap would hit it. Math.round would paper over
 * those three and keep papering until a value where the error exceeds half a
 * unit. Splitting the decimal string removes the whole class instead of the
 * instances, which is worth more than the two lines it costs.
 *
 * This splits the decimal string instead, so no float arithmetic happens at
 * all. Over-precision is REFUSED rather than truncated: silently turning
 * 0.0000001 into 0 on a 6dp token would set a cap of zero and look like a
 * configuration choice.
 */
export function toBaseUnits(human, decimals) {
  const s = String(human);
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`cap "${human}" is not a positive decimal number`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `cap ${human} has ${frac.length} decimal places but the token has ${decimals}. ` +
        `Rounding it would change the limit silently.`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

/** Depth-first, parent label attached. The order the plan prints in. */
export const flatten = (n, parent = null, out = []) => {
  out.push({ ...n, parent });
  for (const c of n.children ?? []) flatten(c, n.label, out);
  return out;
};

/**
 * The exact lines step 3 prints for the tree.
 *
 * `dim` is injected rather than imported so a test sees plain text; the wizard
 * passes its ANSI helper. Asserting against escape-laden strings would make the
 * test unreadable and would fail on a colour change that users cannot see.
 */
export function planTreeLines(nodes, dim = (s) => s) {
  return nodes.map((n) => {
    const indent = n.parent === null ? "" : n.parent === "root" ? "  " : "    ";
    const tag = n.agent ? dim(" ← agent, gets a restricted key") : "";
    return `      ${indent}${n.label}  ${dim(`${n.daily}/day, ${n.perTx}/tx`)}${tag}`;
  });
}

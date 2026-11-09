#!/usr/bin/env node
/**
 * Do the two copies of the gas-key arithmetic still agree?
 *
 * `packages/mcp/src/gas-math.ts` mirrors `packages/create-float/bin/gas-key.mjs`
 * deliberately: the two packages are siblings, published separately and
 * installed independently, so importing across them would couple their release
 * cycles — and this repo has already lost an afternoon to a workspace range
 * that silently resolved to a PUBLISHED sibling instead of the local one.
 *
 * The cost of mirroring is drift, and drift here is not cosmetic. The MCP
 * QUOTES a top-up ("0.05 buys 89 payments") and the CLI CHARGES for it. If the
 * constants diverge, a user is told one number and billed another — and both
 * halves would look correct in isolation, which is exactly the failure mode
 * this repo keeps meeting.
 *
 * So: compare the values, and compare them by COMPUTING with both copies
 * rather than by grepping two files for the same literal. A regex can match a
 * constant that is no longer used; running the function cannot.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const MCP = resolve("packages/mcp/dist/gas-math.js");
const CF = resolve("packages/create-float/bin/gas-key.mjs");

for (const [label, p] of [["mcp", MCP], ["create-float", CF]]) {
  if (!existsSync(p)) {
    console.error(`BROKEN: ${label} gas math missing at ${p}`);
    if (p === MCP) console.error(`  Build it: npm run build --workspace @floatonnear/mcp`);
    process.exit(1);
  }
}

const a = await import(pathToFileURL(MCP).href);
const b = await import(pathToFileURL(CF).href);

let problems = 0;
const fail = (m) => {
  console.error(`BROKEN: ${m}`);
  problems++;
};

// CONSTANTS, compared as values.
if (a.PAYMENT_BURN !== b.PAYMENT_BURN) {
  fail(`PAYMENT_BURN differs: mcp ${a.PAYMENT_BURN} vs create-float ${b.PAYMENT_BURN}`);
}
if (a.MIN_TGAS !== b.MIN_TGAS) {
  fail(`MIN_TGAS differs: mcp ${a.MIN_TGAS} vs create-float ${b.MIN_TGAS}`);
}

/**
 * BEHAVIOUR, exercised rather than inspected.
 *
 * Matching constants do not prove matching answers — a changed formula with
 * unchanged inputs is exactly the drift that would quote one price and charge
 * another. So run both copies over a spread that includes the cases that bite:
 * an empty key (below the reservation), a key sitting exactly ON it, and a
 * healthy one.
 */
const tgasCases = [50, 60, 100];
const balances = [0n, a.gasReservation(60), a.gasReservation(60) + a.PAYMENT_BURN * 40n];
for (const tgas of tgasCases) {
  if (a.gasReservation(tgas) !== b.gasReservation(tgas)) {
    fail(`gasReservation(${tgas}) differs: ${a.gasReservation(tgas)} vs ${b.gasReservation(tgas)}`);
  }
  for (const balance of balances) {
    for (const payments of [0, 1, 50, 500]) {
      const x = a.topUpFor({ balance, tgas, payments });
      const y = b.topUpFor({ balance, tgas, payments });
      if (x !== y) fail(`topUpFor(bal=${balance}, tgas=${tgas}, n=${payments}): ${x} vs ${y}`);
    }
    for (const amount of [0n, 10n ** 22n, 10n ** 24n]) {
      const x = a.paymentsAfterTopUp({ balance, tgas, amount });
      const y = b.paymentsAfterTopUp({ balance, tgas, amount });
      if (x !== y) fail(`paymentsAfterTopUp(bal=${balance}, tgas=${tgas}, amt=${amount}): ${x} vs ${y}`);
    }
  }
}

if (problems) {
  console.error(
    `\n  The MCP quotes a top-up and the CLI charges for it. Divergence means a\n` +
      `  user is told one number and billed another, with both halves looking\n` +
      `  correct on their own. Fix both copies, not one.`,
  );
  process.exit(1);
}
console.log(
  `gas math: mcp and create-float agree across ${tgasCases.length * balances.length * 7} cases`,
);

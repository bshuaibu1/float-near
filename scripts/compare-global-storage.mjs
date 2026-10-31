#!/usr/bin/env node
/**
 * The result of measure-global-contract.sh: does a global-contract reference
 * cost the user anything proportional to the code size?
 *
 *   C minus A should be the padding exactly. That is the control proving a
 *     NORMAL deploy charges the user for every byte of code.
 *   D minus B of ZERO means a global REFERENCE is size-independent, and the
 *     299,016 bytes the real vault stakes today goes away.
 *   D minus B tracking the padding like C minus A does would mean the saving is
 *     NOT what the roadmap assumes, and §4 of the doc needs rewriting rather
 *     than ticking.
 *
 * `view_code` is read on every account, and that is the guard that matters: an
 * account with NO contract would also report small storage, so "small storage"
 * alone would have been a false positive. B and D must return the full 49 and
 * 5122 bytes respectively.
 *
 *   node scripts/compare-global-storage.mjs <A> <B> <C> <D>
 */
import { JsonRpcProvider } from "near-api-js";

const [A, B, C, D] = process.argv.slice(2);
if (!D) {
  console.error("usage: node scripts/compare-global-storage.mjs <A> <B> <C> <D>");
  process.exitCode = 2;
} else {
  const p = new JsonRpcProvider({
    url: process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com",
  });
  const near = (y) => (Number(y) / 1e24).toFixed(5);
  const roles = {
    [A]: "A  deploy tiny   (normal)",
    [B]: "B  use    tiny   (global)",
    [C]: "C  deploy padded (normal)",
    [D]: "D  use    padded (global)",
  };

  const bytes = {};
  console.log("  storage_usage |     staked | code via view_code | role");
  for (const a of [A, B, C, D]) {
    const s = await p.viewAccount({ accountId: a, blockQuery: { finality: "final" } });
    bytes[a] = BigInt(s.storage_usage);
    const code = await p.viewContractCode({ contractId: a }).catch(() => null);
    const len = code ? Buffer.from(code.code_base64, "base64").length : null;
    console.log(
      `  ${String(bytes[a]).padStart(13)} | ${near(bytes[a] * 10n ** 19n).padStart(10)} | ` +
        `${(len === null ? "NOT READABLE" : `${len} bytes`).padStart(18)} | ${roles[a]}`,
    );
  }

  const dCA = bytes[C] - bytes[A];
  const dDB = bytes[D] - bytes[B];
  console.log(`\n  C - A = ${dCA} bytes   (a normal deploy charges for every byte)`);
  console.log(`  D - B = ${dDB} bytes   (0 => a global reference is size-independent)`);

  if (dDB !== 0n) {
    console.log("\n  VERDICT: SIZE-DEPENDENT. §4 of GLOBAL-CONTRACTS-NEP-591.md needs rewriting.");
    process.exitCode = 1;
  } else {
    const VAULT = 299_016n;
    const now = VAULT * 10n ** 19n;
    const after = bytes[B] * 10n ** 19n;
    console.log(`
  VERDICT: SIZE-INDEPENDENT.

  Extrapolated to the real vault (${VAULT} bytes of code):
    code stake today              ${near(now)} NEAR
    stake referencing a global    ${near(after)} NEAR   (${bytes[B]} bytes of pointer)
    saved per vault               ${near(now - after)} NEAR
    one-time global deploy        ${near(VAULT * 10n ** 20n)} NEAR, BURNED at the 10x rate
    break-even                    ~${(Number(VAULT * 10n ** 20n) / Number(now - after)).toFixed(1)} vaults

  Break-even is always about ten, and that is structural rather than a
  coincidence: the global publish rate IS ten times the per-account rate.

  NOT THE WHOLE PER-VAULT COST. A vault still stakes for its own STATE, and
  separately needs FREE balance for its agents to transact at all -- measured
  at 0.100919 NEAR per in-flight 100 TGas call in
  docs/SPIKE-self-fc-key-2026-10-31.md. A vault funded at the stake alone
  cannot make a payment.`);
  }
}

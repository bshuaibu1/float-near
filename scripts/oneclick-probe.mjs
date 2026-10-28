#!/usr/bin/env node
/**
 * Read-only probe of the live 1Click API.
 *
 * STRICTLY `dry: true`, and that is a correctness requirement rather than
 * caution. quote.ts:187 states it: "A dry quote has no deposit address — it is
 * a price, not an instruction." A non-dry quote RESERVES a deposit address and
 * is an instruction to a solver; that would not be a read. Nothing here can
 * move funds — no key is loaded and no transaction is built.
 *
 * It calls the project's OWN getQuote rather than re-implementing the request,
 * so what is under test is the integration that would run in production. A
 * hand-rolled fetch here would prove the API works and tell us nothing about
 * packages/mcp/src/quote.ts.
 *
 * Three questions:
 *   1. Is the live API reachable, and does it accept our request shape
 *      unauthenticated? (`jwt` is optional in getQuote.)
 *   2. What does EXACT_OUTPUT actually cost? The vault is charged `amountIn`
 *      while the payee receives `amountOut`, so the spread is solver fee plus
 *      destination gas — and it is the budget-relevant number, because the
 *      daily cap governs real outflow.
 *   3. Does a 10 USDC balance clear a cross-chain payment at all? That was
 *      stated as the mainnet funding and has never been checked against a
 *      real quote.
 *
 * Usage: node --experimental-strip-types scripts/oneclick-probe.mjs
 */
import { getQuote, ASSETS, ONE_CLICK_URL, encodeBinding } from "../packages/mcp/src/quote.ts";

const PAYEE = "0x4200000000000000000000000000000000000006"; // a real Base address, never paid

/**
 * refundTo must be a MAINNET NEAR account, and this is a trap worth knowing.
 *
 * Both production callers pass `refundTo: vault` (mcp/src/server.ts:208,
 * float-adapter/src/server.ts:338), which is right — a refund should land back
 * in the vault. But the asset ids in ASSETS are mainnet-only, so pointing a
 * TESTNET vault at them is internally inconsistent, and 1Click rejects it with
 *
 *     HTTP 400 {"message":"Internal server error", ...}
 *
 * which names nothing and is indistinguishable from an outage on their side.
 * Measured 2026-10-28: refundTo `floatv4.testnet` -> 400 every time, while the
 * same request with `wrap.near` -> 201 and a real quote. If you ever see that
 * 400, check the network of refundTo before suspecting 1Click.
 *
 * Override with ONE_CLICK_REFUND_TO once a real mainnet vault exists.
 */
const REFUND = process.env.ONE_CLICK_REFUND_TO ?? "wrap.near";

console.log(`endpoint      : ${ONE_CLICK_URL}/v0/quote`);
console.log(`origin asset  : ${ASSETS.usdcNear}`);
console.log(`dest asset    : ${ASSETS.usdcBase}`);
console.log(`refundTo      : ${REFUND}`);
console.log("mode          : dry=true (a price, not an instruction)\n");

// Positive control for the trap documented above: show the testnet refundTo
// failing in the same run, so "it works" and "it fails this specific way"
// are both observed rather than one being remembered.
{
  const bad = await getQuote({
    amountOut: 1_000_000n, payee: PAYEE, refundTo: "floatv4.testnet",
    deadline: new Date(Date.now() + 30 * 60 * 1000), dry: true,
  }).then(() => "UNEXPECTEDLY SUCCEEDED").catch((e) => e.message.slice(0, 60));
  console.log(`  control, refundTo=floatv4.testnet (testnet vs mainnet assets):\n    ${bad}\n`);
}

const deadline = new Date(Date.now() + 30 * 60 * 1000);
const sizes = [1n, 5n, 10n, 25n]; // whole USDC, 6dp
const rows = [];

for (const usd of sizes) {
  const amountOut = usd * 1_000_000n;
  try {
    const q = await getQuote({ amountOut, payee: PAYEE, refundTo: REFUND, deadline, dry: true });
    const spread = q.amountIn - q.amountOut;
    rows.push({ usd, in: q.amountIn, out: q.amountOut, spread, eta: q.timeEstimateSec, dep: q.depositAddress });
    console.log(
      `  out ${String(usd).padStart(3)} USDC -> vault pays ${(Number(q.amountIn) / 1e6).toFixed(6)}` +
      `  spread ${(Number(spread) / 1e6).toFixed(6)} (${(Number(spread) / Number(q.amountOut) * 100).toFixed(2)}%)` +
      `  eta ${q.timeEstimateSec}s` +
      `  depositAddress=${q.depositAddress === "" ? "(none, as expected for dry)" : q.depositAddress}`,
    );
  } catch (e) {
    console.log(`  out ${String(usd).padStart(3)} USDC -> FAILED: ${e.message}`);
  }
}

if (rows.length) {
  console.log("\n--- what this means for the stated 10 USDC mainnet balance ---");
  for (const r of rows) {
    const verdict = r.in <= 10_000_000n ? "fits in 10 USDC" : "EXCEEDS a 10 USDC balance";
    console.log(`  paying ${String(r.usd).padStart(3)} USDC out requires ${(Number(r.in) / 1e6).toFixed(6)} in  -> ${verdict}`);
  }

  // The encoder is the part that silently breaks. Prove it runs on real quote
  // values and is deterministic; the byte-for-byte agreement with the contract
  // is pinned by quote_binding_borsh_vector on the Rust side and quote.test.ts
  // here, so this only checks it accepts live input.
  const r = rows[0];
  const enc = encodeBinding({
    vault: "v4.floatv4.testnet", requestId: "probe-1", token: "usdc.fakes.testnet",
    amount: r.in, payee: PAYEE, depositAddress: "solver.floatv4.testnet",
    deadlineNs: BigInt(deadline.getTime()) * 1_000_000n,
  });
  console.log(`\n--- encoder against live quote values ---`);
  console.log(`  encodeBinding(amountIn=${r.in}) -> ${enc.length} bytes, head ${Buffer.from(enc).toString("hex").slice(0, 32)}`);
}

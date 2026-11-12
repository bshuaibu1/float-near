#!/usr/bin/env node
/**
 * Capture a SETTLED baseline for a before/after measurement, in exact yocto.
 *
 * WHY THIS EXISTS, written into DECISIONS.md 2026-11-12 as the named end state
 * for an amber claim. The gas-key question — "does the AGENT pay for the call,
 * or does the vault?" — was half-answered: the agent key demonstrably dropped
 * 0.00023 NEAR, but the vault half rested on a 4-decimal read (3.3484) against
 * an apparent 0.00001 change. The baseline admitted +/-0.00005, five times the
 * effect being inferred from it.
 *
 * This repo's memory is explicit about the trap: "polling protects a READING,
 * not a BASELINE — settle the account (two identical reads of balance AND
 * storage) before the FIRST read of a before/after pair, because a refund
 * landing inside the window can never be polled away afterwards." A NEAR gas
 * RESERVATION is `prepaid x 1e9`, refunded a receipt later, so a balance read
 * taken too early can be a whole transaction behind and still look plausible.
 *
 * So: poll until two CONSECUTIVE reads agree on `amount` AND `storage_usage`
 * AND every gas-key balance, then print exact yocto. No rounding anywhere —
 * rounding is what made the last attempt unusable.
 *
 *   node scripts/settle-baseline.mjs            # print a settled baseline
 *   node scripts/settle-baseline.mjs --compare baseline.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";

const LF = String.fromCharCode(10);
const argv = process.argv.slice(2);
const compareTo = argv.includes("--compare") ? argv[argv.indexOf("--compare") + 1] : null;
const outPath = argv.includes("--save") ? argv[argv.indexOf("--save") + 1] : null;

/**
 * A MISSING .mcp.json IS A CONFIGURATION STATE, NOT A CRASH.
 *
 * This read used to throw a raw ENOENT stack trace, which reads like the
 * script is broken rather than like the client is unconfigured — and the
 * commonest time to run it is exactly when you have just reinstalled and have
 * not written the config yet.
 */
function readMcpConfig() {
  if (!existsSync(".mcp.json")) {
    console.error(
      `no .mcp.json in ${process.cwd()}, so there is no MCP server to read.${String.fromCharCode(10)}` +
        `  Configure one (npx -y @floatonnear/mcp, NEAR_VAULT_NETWORK=mainnet,${String.fromCharCode(10)}` +
        `  NEAR_VAULT_FACTORY=usefloat.near), or let create-float write it for you.`,
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(".mcp.json", "utf8"));
}

const cfg = readMcpConfig();
const env = (cfg.mcpServers ?? cfg.servers ?? {})["float-near"]?.env ?? {};
const VAULT = env.NEAR_VAULT_CONTRACT;
const TOKEN = env.NEAR_VAULT_TOKEN;
const NETWORK = env.NEAR_VAULT_NETWORK ?? "mainnet";
const RPC = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" }[
  NETWORK
];

const provider = new JsonRpcProvider({ url: RPC });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot() {
  const acct = await provider.viewAccount({
    accountId: VAULT,
    blockQuery: { finality: "final" },
  });
  const keys = (
    await provider.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })
  ).keys;
  const gas = {};
  for (const k of keys) {
    const p = k.access_key.permission?.GasKeyFunctionCall;
    if (p) gas[k.public_key] = String(p.balance);
  }
  const usdc = await provider.callFunction({
    contractId: TOKEN,
    method: "ft_balance_of",
    args: { account_id: VAULT },
    blockQuery: { finality: "final" },
  });
  return { amount: String(acct.amount), storage_usage: acct.storage_usage, gas, usdc: String(usdc) };
}

const same = (a, b) =>
  a.amount === b.amount &&
  a.storage_usage === b.storage_usage &&
  a.usdc === b.usdc &&
  JSON.stringify(a.gas) === JSON.stringify(b.gas);

/** Poll until two CONSECUTIVE reads agree on everything. */
let prev = await snapshot();
let settled = null;
for (let i = 0; i < 20; i += 1) {
  await sleep(1500);
  const next = await snapshot();
  if (same(prev, next)) {
    settled = next;
    console.log(`settled after ${i + 1} confirming read(s)`);
    break;
  }
  console.log(`  read ${i + 1}: still moving, re-reading`);
  prev = next;
}
if (!settled) {
  console.error(
    "NOT SETTLED after 20 reads — the account is still changing, so no baseline is valid here.",
  );
  process.exit(1);
}

const near = (y) => `${(Number(BigInt(y)) / 1e24).toFixed(24).replace(/0+$/, "")}`;

console.log(`${LF}${VAULT}  (${NETWORK})`);
console.log(`  amount        ${settled.amount}  yocto   (${near(settled.amount)} NEAR)`);
console.log(`  storage_usage ${settled.storage_usage} B`);
console.log(`  USDC          ${settled.usdc}  base units`);
for (const [pk, bal] of Object.entries(settled.gas)) {
  console.log(`  gas key       ${pk.slice(0, 24)}…  ${bal} yocto  (${near(bal)} NEAR)`);
}

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(settled, null, 2)}${LF}`);
  console.log(`${LF}saved -> ${outPath}`);
}

if (compareTo) {
  const before = JSON.parse(readFileSync(compareTo, "utf8"));
  const d = (a, b) => BigInt(b) - BigInt(a);
  const dAmount = d(before.amount, settled.amount);
  const dUsdc = d(before.usdc, settled.usdc);
  const dStorage = settled.storage_usage - before.storage_usage;

  console.log(`${LF}--- delta vs ${compareTo} ---`);
  console.log(`  USDC          ${dUsdc > 0n ? "+" : ""}${dUsdc} base units`);
  console.log(`  storage_usage ${dStorage > 0 ? "+" : ""}${dStorage} B`);
  console.log(
    `  vault amount  ${dAmount > 0n ? "+" : ""}${dAmount} yocto  (${dAmount > 0n ? "+" : ""}${near(dAmount < 0n ? -dAmount : dAmount) * (dAmount < 0n ? -1 : 1)} NEAR)`,
  );
  for (const pk of Object.keys({ ...before.gas, ...settled.gas })) {
    const dg = d(before.gas[pk] ?? "0", settled.gas[pk] ?? "0");
    console.log(`  gas key ${pk.slice(0, 20)}…  ${dg > 0n ? "+" : ""}${dg} yocto`);
  }

  /**
   * THE PREDICATE, stated rather than assumed.
   *
   * On MAINNET `burnt_gas_reward` is [3,10] — a contract earns 30% of the gas
   * burnt in its own execution — so a vault can come out AHEAD on a payment.
   * "The vault's balance did not drop" is therefore the WRONG test: a vault
   * that gained passes it for the wrong reason. What matters is whether the
   * AGENT's key funded the call, and whether the vault's own movement is
   * explained by storage growth plus that reward.
   */
  console.log(`${LF}  storage cost of those ${dStorage} B: ${BigInt(dStorage) * 10n ** 19n} yocto`);
  console.log(
    `  (mainnet pays the contract 30% of its own burnt gas, so a vault can END UP AHEAD;` +
      `${LF}   compare 'vault amount' against the storage cost, not against zero)`,
  );
}

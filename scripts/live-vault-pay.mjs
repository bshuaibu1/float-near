/**
 * Prove a creation-time agent can actually spend, and that it pays its OWN gas.
 *
 * This runs the MCP server's real `sendRequestPayment`, with the credential
 * the adapter loaded from `.float/agent-keys.json` — not a hand-built
 * transaction. The point is that nothing special happens here: the key bound
 * by the factory at creation is used exactly as an ordinary agent's would be.
 *
 * WHAT IT MEASURES, and why each one is separate:
 *
 *   the token moved        the payment settled, not merely dispatched
 *   the GAS KEY's balance  fell — the agent paid for its own execution
 *   the VAULT's balance    barely moved — it was not charged for the agent
 *
 * The third is the one that would have been missed. A gas key funded from the
 * wrong place still works; it just drains somebody else. That is exactly the
 * bug the factory had — it funded the key out of its own balance and would
 * have bled 0.12 NEAR per vault until it fell under its storage stake.
 *
 * Balances are SETTLED before the first read: two identical reads in a row.
 * A `final`-finality read right after a write can be a whole transaction
 * behind, and a refund landing inside the measurement window cannot be polled
 * away afterwards — it corrupts the baseline, not the reading.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JsonRpcProvider } from "near-api-js";

import { sendRequestPayment } from "../packages/mcp/dist/sign.js";

const ROOT = resolve(import.meta.dirname, "..");
const RPC = "https://test.rpc.fastnear.com";
const VAULT = process.env.VAULT ?? "rudeisland4178-testnet.fac.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "usdc.fakes.testnet";
const RECIPIENT = process.env.RECIPIENT ?? "rudeisland4178.testnet";
const AMOUNT = BigInt(process.env.AMOUNT ?? "5000000"); // 5.0 at 6dp, under the 10.0 per-tx cap

const p = new JsonRpcProvider({ url: RPC });
const near = (y) => {
  const n = y < 0n;
  const v = n ? -y : y;
  return `${n ? "-" : ""}${v / 10n ** 24n}.${(v % 10n ** 24n).toString().padStart(24, "0").slice(0, 6)}`;
};
const usd = (b) => (Number(b) / 1e6).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const view = (c, m, a = {}) =>
  p.callFunction({ contractId: c, method: m, args: a, blockQuery: { finality: "final" } });
const ft = async (id) => BigInt(await view(TOKEN, "ft_balance_of", { account_id: id }));
/** One node's committed spend for today: executed + in-flight. */
const committed = async (nodeId) => {
  const b = await view(VAULT, "get_node_budget", { node_id: nodeId, token: TOKEN, day: null });
  return b ? BigInt(b.executed) + BigInt(b.pending) : null;
};
const amountOf = async (id) =>
  BigInt((await p.viewAccount({ accountId: id, blockQuery: { finality: "final" } })).amount);

/** The gas key's own balance, which is its spending cap. */
async function gasKeyBalance(pk) {
  const keys = (await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } }))
    .keys;
  const k = keys.find((x) => x.public_key === pk);
  if (!k) return null;
  const perm = k.access_key.permission;
  if (typeof perm === "string") return null;
  const v = perm[Object.keys(perm)[0]];
  // Balance is at the TOP LEVEL of the variant, not under `gas_key_info` —
  // near-api-js's typings suggest otherwise and reading the wrong place
  // yields undefined, which formats as a plausible-looking zero.
  return BigInt(v.balance ?? v.gas_key_info?.balance ?? 0);
}

/** Read until two consecutive reads agree, so the baseline is not mid-refund. */
async function settled(label, read) {
  let prev = await read();
  for (let i = 0; i < 25; i++) {
    await sleep(1200);
    const now = await read();
    if (now === prev) return now;
    prev = now;
  }
  console.warn(`  WARNING: ${label} never settled; using the last read`);
  return prev;
}

// ---- the credential the ADAPTER would load ---------------------------------
const ROLE = process.env.ROLE ?? null;
const ring = JSON.parse(readFileSync(resolve(ROOT, ".float", "agent-keys.json"), "utf8"));
// Same predicate `loadKeyring` uses. An entry failing it is skipped there in
// silence, so finding one here that the adapter would drop proves nothing.
const loadable = ring.filter(
  (e) => e && typeof e.agentId === "string" && typeof e.secret === "string",
);
const forVault = loadable.filter((e) => e.agentId === VAULT);
const cred = ROLE ? forVault.find((e) => e.role === ROLE) : forVault[0];

if (!cred) {
  console.error(`FATAL: no loadable credential${ROLE ? ` with role '${ROLE}'` : ""} for ${VAULT}.`);
  console.error(`  Roles on this vault: ${forVault.map((e) => e.role ?? "(none)").join(", ") || "none"}`);
  process.exit(1);
}
// REFUSE TO GUESS when a vault has several agents and none was named. Which
// key signs IS which budget is charged, so an arbitrary pick does not fail —
// it succeeds against the wrong node.
if (!ROLE && forVault.length > 1) {
  console.error(`FATAL: ${forVault.length} agents on ${VAULT} and no ROLE given.`);
  console.error(`  Roles: ${forVault.map((e) => e.role ?? "(none)").join(", ")}`);
  console.error(`  The signing key decides which budget is charged; pick one.`);
  process.exit(1);
}
const PK = cred.publicKey;

console.log(`vault     ${VAULT}`);
console.log(`agent     ${PK}`);
console.log(`role      ${cred.role ?? "(none)"}  node ${cred.nodeId ?? "(unknown)"}`);
console.log(`paying    ${usd(AMOUNT)} ${TOKEN} -> ${RECIPIENT}\n`);

console.log(`settling balances before measuring…`);
const gas0 = await settled("gas key", () => gasKeyBalance(PK));
const vault0 = await settled("vault NEAR", () => amountOf(VAULT));
const tokV0 = await ft(VAULT);
const tokR0 = await ft(RECIPIENT);

if (gas0 === null) {
  console.error(`FATAL: ${PK} is not an access key on ${VAULT}.`);
  process.exit(1);
}

// THE NODE LEDGERS ARE THE POINT once a vault has a fleet. The gas key
// proves who PAID; these prove whose BUDGET was charged, and they are
// different claims — a payment can burn the right key and bill the wrong node.
const OWN_NODE = cred.nodeId;
const own0 = typeof OWN_NODE === "number" ? await committed(OWN_NODE) : null;
const root0 = await committed(0);

console.log(`  gas key balance   ${near(gas0)}`);
console.log(`  vault NEAR        ${near(vault0)}`);
console.log(`  vault tokens      ${usd(tokV0)}`);
console.log(`  payee tokens      ${usd(tokR0)}`);
if (own0 !== null) console.log(`  node ${OWN_NODE} committed   ${usd(own0)}`);
console.log(`  node 0 committed  ${usd(root0)}   (root)\n`);

// ---- pay --------------------------------------------------------------------
const requestId = process.env.REQUEST_ID ?? `live-${gas0.toString().slice(-6)}`;
console.log(`request   ${requestId}\nsending…`);

let out;
try {
  out = await sendRequestPayment({
    rpcUrl: RPC,
    vault: VAULT,
    agentId: cred.agentId,
    agentKey: cred.secret,
    requestId,
    token: TOKEN,
    amount: AMOUNT,
    recipient: RECIPIENT,
    memo: "first payment from a vault created in one signature",
    gasTgas: 60,
  });
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
}
console.log(`  -> ${JSON.stringify(out)}\n`);

// ---- what actually moved ----------------------------------------------------
console.log(`settling after…`);
const tokR1 = await settled("payee tokens", () => ft(RECIPIENT));
const gas1 = await settled("gas key", () => gasKeyBalance(PK));
const vault1 = await amountOf(VAULT);
const tokV1 = await ft(VAULT);

console.log(`\n  payee tokens      ${usd(tokR0)} -> ${usd(tokR1)}   (${usd(tokR1 - tokR0)})`);
console.log(`  vault tokens      ${usd(tokV0)} -> ${usd(tokV1)}   (${usd(tokV1 - tokV0)})`);
console.log(`  gas key balance   ${near(gas0)} -> ${near(gas1)}   (${near(gas1 - gas0)})`);
console.log(`  vault NEAR        ${near(vault0)} -> ${near(vault1)}   (${near(vault1 - vault0)})`);

const own1 = typeof OWN_NODE === "number" ? await committed(OWN_NODE) : null;
const root1 = await committed(0);
if (own0 !== null) {
  console.log(`  node ${OWN_NODE} committed   ${usd(own0)} -> ${usd(own1)}   (${usd(own1 - own0)})`);
}
console.log(`  node 0 committed  ${usd(root0)} -> ${usd(root1)}   (${usd(root1 - root0)})`);

console.log();
const moved = tokR1 - tokR0 === AMOUNT;
const agentPaid = gas1 < gas0;
// The role's OWN node must absorb the spend, and root must move by the same
// amount as its ancestor — not more, which would mean double-charging, and
// not less, which would mean the fleet could out-spend the master cap.
const ownCharged = own0 === null ? null : own1 - own0 === AMOUNT;
const rootCharged = root1 - root0 === AMOUNT;
console.log(`  payment settled           ${moved ? "YES" : "NO"}`);
console.log(`  agent paid its own gas    ${agentPaid ? "YES" : "NO"}`);
console.log(`  its OWN node charged      ${ownCharged === null ? "n/a" : ownCharged ? "YES" : "NO"}`);
console.log(`  root charged as parent    ${rootCharged ? "YES" : "NO"}`);
console.log(`  vault NEAR delta          ${near(vault1 - vault0)}`);
process.exitCode = moved && agentPaid ? 0 : 1;

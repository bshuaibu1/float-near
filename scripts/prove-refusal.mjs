#!/usr/bin/env node
/**
 * Prove the contract REFUSES an over-cap payment, on mainnet, safely.
 *
 * WHY A SEPARATE SCRIPT FROM drive-mcp.mjs. That one refuses `vault_pay`
 * outright, and the reason stands: a convenience script that can spend is one
 * typo from spending. `15` mistyped as `1.5` is under the per-tx cap, would
 * SETTLE, and would move real USDC out of a real vault.
 *
 * So this does not ask me to be careful. It makes the mistake IMPOSSIBLE:
 *
 *   1. read the effective per-tx cap for this node FROM THE CHAIN
 *   2. refuse to sign unless the requested amount EXCEEDS it
 *   3. only then sign
 *
 * A transfer therefore cannot happen on the path this script can reach. If the
 * amount is payable, nothing is sent and it says why. That is a precondition
 * checked against live state, not an intention.
 *
 * It uses the PRODUCT's own signing function (`sendRequestPayment` from the
 * built MCP), not a reimplementation, so what it proves is what the demo does.
 * Everything else — the vault, network, token, keyring — comes from
 * `.mcp.json`, so it cannot disagree with the server being demoed.
 *
 *   node scripts/prove-refusal.mjs 15 test015.near
 */
import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";
import { sendRequestPayment } from "../packages/mcp/dist/sign.js";

const LF = String.fromCharCode(10);
const [amountArg, recipientArg] = process.argv.slice(2);
if (!amountArg || !recipientArg) {
  console.error("usage: node scripts/prove-refusal.mjs <amount> <recipient>");
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(".mcp.json", "utf8"));
const env = (cfg.mcpServers ?? cfg.servers ?? {})["float-near"]?.env ?? {};
const VAULT = env.NEAR_VAULT_CONTRACT;
const NETWORK = env.NEAR_VAULT_NETWORK ?? "mainnet";
const TOKEN = env.NEAR_VAULT_TOKEN;
const DECIMALS = Number(env.NEAR_VAULT_TOKEN_DECIMALS ?? "6");
const RPC = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" }[
  NETWORK
];
if (!VAULT || !TOKEN || !RPC) {
  console.error("prove-refusal: .mcp.json is missing vault/token/network");
  process.exit(2);
}

const provider = new JsonRpcProvider({ url: RPC });
const view = (contractId, method, args = {}) =>
  provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });

const toBase = (human) => {
  const [i, f = ""] = String(human).split(".");
  return BigInt(i + (f + "0".repeat(DECIMALS)).slice(0, DECIMALS));
};
const fromBase = (v) => (Number(v) / 10 ** DECIMALS).toString();

// ---- Which key, and therefore which node pays.
const keyring = JSON.parse(
  readFileSync(env.NEAR_VAULT_AGENT_KEYS, "utf8").replace(/^﻿/, ""),
);
const entry = keyring.find((e) => (e.agentId ?? e.vault) === VAULT);
if (!entry) {
  console.error(`prove-refusal: no keyring entry for ${VAULT}`);
  process.exit(2);
}
const secret = entry.privateKey ?? entry.secret ?? entry.agentKey;
const nodeId = await view(VAULT, "get_virtual_agent_node", { public_key: entry.publicKey });

console.log(`${LF}vault    ${VAULT}  (${NETWORK})`);
console.log(`node     #${nodeId}  via role "${entry.role ?? "(unnamed)"}"`);

// ---- THE GUARD. Read every per-tx cap on the chain from this node up, and
// take the SMALLEST: that is the one a payment is actually checked against.
const tree = await view(VAULT, "get_tree", {});
const byId = new Map(tree.map((n) => [n.id, n]));
const chain = [];
for (let cur = byId.get(nodeId); cur; cur = cur.parent === null ? null : byId.get(cur.parent)) {
  chain.push(cur);
}

/**
 * The SMALLEST per-tx cap in the chain is what makes the guard sound: if the
 * amount exceeds the minimum, every level rejects it and no transfer is
 * reachable.
 *
 * It does NOT tell you which node the contract will BLAME. `dispatch_payment`
 * walks root-first, so with equal caps the ancestor reports first and the code
 * is PARENT_PER_TX_LIMIT even though this loop (strict `<`, self seen first)
 * names the self node. Measured 2026-11-12: both caps were 10, this printed
 * "node #1 agent" and the contract returned PARENT_PER_TX_LIMIT. The guard is
 * unaffected -- it only needs the minimum -- so the label is reported as
 * "no greater than" rather than as the binding node.
 */
let binding = null;
for (const n of chain) {
  const lim = (n.limits ?? []).find((l) => l.token === TOKEN);
  if (!lim) continue;
  const cap = BigInt(lim.per_tx_cap);
  if (binding === null || cap < binding.cap) binding = { cap, node: n };
}
if (binding === null) {
  console.error(`prove-refusal: no limit for ${TOKEN} anywhere in node #${nodeId}'s chain`);
  process.exit(2);
}

const want = toBase(amountArg);
console.log(`chain    ${chain.map((n) => `#${n.id} ${n.label}`).join(" <- ")}`);
console.log(`smallest per-tx cap  ${fromBase(binding.cap)}  (the contract may blame any level at this cap)`);
console.log(`requested            ${amountArg}`);

if (want <= binding.cap) {
  console.error(
    `${LF}REFUSING TO SIGN. ${amountArg} is WITHIN the ${fromBase(binding.cap)} per-transaction cap, so this` +
      `${LF}would SETTLE and move real funds — which is not what this script is for.` +
      `${LF}It only sends amounts the contract is guaranteed to reject. Nothing was signed.` +
      `${LF}${LF}To make a real payment, do it deliberately through the MCP client.`,
  );
  process.exit(1);
}

console.log(
  `${LF}=> ${amountArg} exceeds the cap, so a transfer is IMPOSSIBLE on this path. Signing.${LF}`,
);

const before = await view(TOKEN, "ft_balance_of", { account_id: VAULT });

const out = await sendRequestPayment({
  rpcUrl: RPC,
  agentId: VAULT, // self-submit: the gas key lives ON the vault
  agentKey: secret,
  vault: VAULT,
  requestId: `refusal-proof-${nodeId}-${want}`,
  token: TOKEN,
  amount: want,
  recipient: recipientArg,
  memo: "over-cap refusal proof",
  gasTgas: 100,
});

console.log("contract returned:");
console.log(JSON.stringify(out, null, 2));

const after = await view(TOKEN, "ft_balance_of", { account_id: VAULT });
console.log(`${LF}vault USDC before  ${fromBase(BigInt(before))}`);
console.log(`vault USDC after   ${fromBase(BigInt(after))}`);
console.log(
  before === after
    ? "=> UNCHANGED. The refusal moved nothing."
    : "=> *** BALANCE CHANGED — investigate immediately ***",
);

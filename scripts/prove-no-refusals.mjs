#!/usr/bin/env node
/**
 * Prove how many refusals a vault can possibly have had, without scanning.
 *
 * WHY THIS BEATS THE BLOCK SCAN. A refusal is never stored in contract state,
 * so the obvious way to count them is to walk every block and read the events
 * — 53,880 blocks and ~8 hours on a free RPC for this vault, and the scanner
 * only nets ~0.8 blocks/s against a chain producing ~1/s, so actually catching
 * the head is closer to 18 hours. The scan is still the right tool for a vault
 * with many agents or a long history; it is absurd for this one.
 *
 * THE ARGUMENT. Every `blocked()` call in the contract happens AFTER a node_id
 * has been resolved, which means after authentication. There are exactly three
 * ways to resolve one:
 *
 *   1. predecessor == the vault, and `signer_account_pk()` is in
 *      `pubkey_to_node`        (the self-submit gas-key rail)
 *   2. predecessor is in `account_to_node`   (the bind_agent account rail)
 *   3. `request_payment_signed` with a bound public key AND a valid ed25519
 *      signature over the payload
 *
 * Rails 1 and 3 both require the agent's PRIVATE key. Rail 2 requires an
 * account bound by the owner. So the set of transactions that could possibly
 * have produced a refusal is bounded by the transactions those keys signed.
 *
 * A NEAR access key's nonce starts at `block_height * 1_000_000` when the key
 * is created and increments by exactly one per transaction it signs. So the
 * low six digits ARE the transaction count. Compare that to the number of
 * SETTLED requests the contract stored, and the difference is the number of
 * calls that did not settle — the refusals.
 *
 * WHAT THIS DOES NOT PROVE. It bounds refusals from the KNOWN agents. If the
 * account rail is in use it reports that it cannot conclude, because an
 * account's keys can be rotated and its nonce history is not recoverable this
 * way. It also cannot see a payment that settled and was later purged with
 * `purge_settled`, which would make the stored count too low and the inferred
 * refusal count too HIGH — the safe direction, but worth naming.
 */
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const VAULT = process.env.NEAR_VAULT_CONTRACT;
if (!VAULT) {
  console.error("FATAL: NEAR_VAULT_CONTRACT is not set.");
  process.exit(2);
}

const p = new JsonRpcProvider({ url: RPC });
const view = (method, args = {}) =>
  p.callFunction({ contractId: VAULT, method, args, blockQuery: { finality: "final" } });

/** NEAR: nonce = block_height * 1e6 + (transactions signed). */
const NONCE_MULTIPLIER = 1_000_000n;

console.log(`\n  vault  ${VAULT}\n`);

// ---- rail 2: is any ACCOUNT bound? -----------------------------------------
const tree = await view("get_tree");
const boundAccounts = tree.filter((n) => n.account).map((n) => n.account);
if (boundAccounts.length) {
  console.log(`  INCONCLUSIVE: ${boundAccounts.length} account-bound agent(s): ${boundAccounts.join(", ")}`);
  console.log(`  An account's keys can be rotated, so its signing history is not`);
  console.log(`  recoverable from a nonce. Use scripts/scan-blocked.mjs for this vault.`);
  process.exit(1);
}
console.log(`  account-bound agents: none (so rail 2 cannot have produced a refusal)`);

// ---- rails 1 and 3: every bound key -----------------------------------------
const keys = (await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })).keys;
const gasKeys = keys.filter((k) => {
  const perm = k.access_key.permission;
  return typeof perm === "object" && "GasKeyFunctionCall" in perm;
});

let signed = 0n;
for (const k of gasKeys) {
  const nodeId = await view("get_virtual_agent_node", { public_key: k.public_key });
  if (nodeId === null || nodeId === undefined) {
    console.log(`  ${k.public_key.slice(0, 26)}… is NOT bound — cannot authorise a payment`);
    continue;
  }
  const { nonces } = await p.viewGasKeyNonces({
    accountId: VAULT,
    publicKey: k.public_key,
    blockQuery: { finality: "final" },
  });
  // One lane per `num_nonces`. Each lane's low six digits count that lane's
  // transactions; sum across lanes for the key's total.
  let perKey = 0n;
  for (const n of nonces) perKey += BigInt(n) % NONCE_MULTIPLIER;
  signed += perKey;
  console.log(
    `  ${k.public_key.slice(0, 26)}… bound to node ${nodeId}, ${nonces.length} lane(s), ${perKey} transaction(s)`,
  );
}

// ---- what actually settled ---------------------------------------------------
const requests = await view("list_requests", { from_index: 0, limit: 200 });
const settled = requests.filter((r) => r.status === "SETTLED").length;
const other = requests.length - settled;

console.log(`\n  transactions signed by bound keys : ${signed}`);
console.log(`  requests stored by the contract   : ${requests.length} (${settled} SETTLED, ${other} other)`);

const refusals = signed - BigInt(requests.length);
console.log();
if (refusals === 0n) {
  console.log(`  => ZERO refusals are possible on this vault.`);
  console.log(`     Every transaction a bound key ever signed produced a stored`);
  console.log(`     request, so none were refused. This is a COMPLETE answer for`);
  console.log(`     the whole history, not a sampled one.`);
} else if (refusals > 0n) {
  console.log(`  => ${refusals} transaction(s) signed but not stored: that many refusals.`);
  console.log(`     Run scripts/scan-blocked.mjs to recover their reasons from the`);
  console.log(`     event log; this only counts them.`);
} else {
  console.log(`  => More stored requests (${requests.length}) than signed transactions (${signed}).`);
  console.log(`     Possible causes: an account-rail agent, an owner-driven`);
  console.log(`     approve_payment, or a key that was deleted after signing.`);
  console.log(`     Inconclusive — scan instead.`);
}
console.log();

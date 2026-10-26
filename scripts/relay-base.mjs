#!/usr/bin/env node
/**
 * Relays a Base transaction the vault has already signed.
 *
 * THIS SCRIPT IS OUTSIDE THE TRUST MODEL, deliberately and completely. It
 * holds no key, signs nothing, and cannot cause a payment. Everything that
 * decides WHERE value goes was fixed on NEAR before this runs: the vault built
 * the ERC-20 calldata and the EIP-1559 transaction from the amount and payee
 * it had already checked against every level of the budget tree, and the MPC
 * network signed that. A relayer can broadcast that transaction or fail to —
 * nothing else. If this script is wrong, hostile, or absent, the worst outcome
 * is that a payment does not land; no payment that the vault refused can be
 * made to happen here.
 *
 * It reconstructs the unsigned transaction from the request the CONTRACT
 * stored, not from anything the caller supplies, then proves the
 * reconstruction is byte-identical to what was signed by recovering the sender
 * and checking it against the vault's MPC-derived address. A single byte of
 * disagreement in the RLP yields a different sender, so that check is a real
 * proof rather than a formality.
 *
 * Usage:
 *   node scripts/relay-base.mjs <near-tx-hash> <signer-account-id> [--broadcast]
 *
 * Without --broadcast it stops after verification and prints the raw
 * transaction. Nothing is sent.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const NEAR_RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v3.floatvault-12329.testnet";

// ---------------------------------------------------------------- utilities

const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (s) => Buffer.from(s.replace(/^0x/, ""), "hex");

/** base58, for NEAR's `secp256k1:<base58>` public keys. */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58 char ${c}`);
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return Buffer.from(h, "hex");
}

// RLP, mirroring contracts/vault/src/evm.rs exactly. The Rust side is pinned
// against the canonical spec vectors; this must agree with it byte for byte or
// the recovered sender will not match.
function beMinimal(n) {
  if (n === 0n) return Buffer.alloc(0);
  let h = n.toString(16);
  if (h.length % 2) h = "0" + h;
  return Buffer.from(h, "hex");
}
function rlpBytes(b) {
  if (b.length === 1 && b[0] <= 0x7f) return Buffer.from(b);
  if (b.length <= 55) return Buffer.concat([Buffer.from([0x80 + b.length]), b]);
  const len = beMinimal(BigInt(b.length));
  return Buffer.concat([Buffer.from([0xb7 + len.length]), len, b]);
}
const rlpUint = (n) => rlpBytes(beMinimal(n));
function rlpList(items) {
  const payload = Buffer.concat(items);
  if (payload.length <= 55) return Buffer.concat([Buffer.from([0xc0 + payload.length]), payload]);
  const len = beMinimal(BigInt(payload.length));
  return Buffer.concat([Buffer.from([0xf7 + len.length]), len, payload]);
}

const addressOf = (uncompressed64) => "0x" + hex(keccak_256(uncompressed64).slice(-20));

async function rpc(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
  return r.json();
}

async function nearView(account, method, args) {
  const d = await rpc(NEAR_RPC, {
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: account,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  });
  if (d.error) throw new Error(`view ${method}: ${JSON.stringify(d.error).slice(0, 200)}`);
  if (d.result?.error) throw new Error(`view ${method}: ${d.result.error}`);
  return JSON.parse(Buffer.from(d.result.result).toString("utf8"));
}

/**
 * Pull the MPC signature out of the NEAR transaction.
 *
 * The signature is NOT stored on-chain by the vault — the callback only checks
 * whether the promise succeeded. It exists only in the receipt outcome of the
 * `sign` call, so the relayer reads it from the transaction itself.
 */
async function signatureFromTx(txHash, senderId) {
  const d = await rpc(NEAR_RPC, {
    method: "EXPERIMENTAL_tx_status",
    params: [txHash, senderId],
  });
  if (d.error) throw new Error(`tx_status: ${JSON.stringify(d.error).slice(0, 300)}`);
  const outcomes = d.result?.receipts_outcome ?? [];
  for (const o of outcomes) {
    const sv = o.outcome?.status?.SuccessValue;
    if (!sv) continue;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
    } catch {
      continue;
    }
    if (parsed && parsed.big_r && parsed.s) return parsed;
  }
  throw new Error(
    "no MPC signature found in this transaction's receipts. Was it a Base-routed " +
      "payment that reached the signer? A BLOCKED payment never calls sign.",
  );
}

// ------------------------------------------------------------------- main

const [txHash, senderId] = process.argv.slice(2);
const doBroadcast = process.argv.includes("--broadcast");
if (!txHash || !senderId) {
  console.error("usage: node scripts/relay-base.mjs <near-tx-hash> <signer-account-id> [--broadcast]");
  process.exit(2);
}

// 1. What the CONTRACT recorded. Not what the caller claims.
const cfg = await nearView(VAULT, "get_base_config", {});
if (!cfg) throw new Error("the Base rail is closed on this vault");

const sig = await signatureFromTx(txHash, senderId);
console.log("MPC signature    :", sig.scheme ?? "(no scheme field)");

// Find the request this transaction settled, by matching the signature's tx.
const reqId = process.env.RELAY_REQUEST_ID;
if (!reqId) {
  console.error(
    "\nSet RELAY_REQUEST_ID to the request_id of the payment in that transaction.\n" +
      "The vault stores payments by request id, not by NEAR tx hash, so the two\n" +
      "cannot be linked from chain data alone.",
  );
  process.exit(2);
}
const req = await nearView(VAULT, "get_request", { request_id: reqId });
if (!req) throw new Error(`no stored request ${reqId}`);
if (req.reason_code !== "SIGNED") {
  throw new Error(`request ${reqId} is ${req.reason_code}, not SIGNED — nothing to relay`);
}
const route = req.route?.base_usdc;
if (!route) throw new Error(`request ${reqId} was not routed over Base`);

// 2. Rebuild the EXACT transaction the contract built.
const to = fromHex(cfg.usdc_address);
const payee = fromHex(req.recipient);
const data = Buffer.concat([
  Buffer.from("a9059cbb", "hex"), // transfer(address,uint256)
  Buffer.alloc(12),
  payee,
  Buffer.alloc(16),
  Buffer.from(BigInt(req.amount).toString(16).padStart(32, "0"), "hex"),
]);

const fields = [
  rlpUint(BigInt(cfg.chain_id)),
  rlpUint(BigInt(route.nonce)),
  rlpUint(BigInt(route.max_priority_fee_per_gas)),
  rlpUint(BigInt(route.max_fee_per_gas)),
  rlpUint(BigInt(route.gas_limit)),
  rlpBytes(to),
  rlpUint(0n), // value: an ERC-20 transfer moves no native ETH
  rlpBytes(data),
  rlpList([]), // empty access list
];
const unsigned = Buffer.concat([Buffer.from([0x02]), rlpList(fields)]);
const sighash = keccak_256(unsigned);
console.log("rebuilt sighash  : 0x" + hex(sighash));

// 3. THE PROOF. Recover the sender from the signature over OUR reconstruction
//    and compare it to the vault's MPC-derived address. If our RLP differed
//    from the contract's by a single byte, this would not match.
const r = BigInt("0x" + sig.big_r.affine_point.slice(2)); // strip the 02/03 prefix byte
const s = BigInt("0x" + sig.s.scalar);
const recid = sig.recovery_id;

const signature = new secp256k1.Signature(r, s).addRecoveryBit(recid);
const recovered = signature.recoverPublicKey(sighash).toRawBytes(false).slice(1);
const recoveredAddr = addressOf(recovered);

const derivedPk = await nearView("v1.signer-prod.testnet", "derived_public_key", {
  path: cfg.derivation_path,
  predecessor: VAULT,
  domain_id: cfg.domain_id,
});
const expectedAddr = addressOf(b58decode(derivedPk.split(":")[1]));

console.log("recovered sender : " + recoveredAddr);
console.log("vault's address  : " + expectedAddr);
if (recoveredAddr !== expectedAddr) {
  console.error(
    "\nMISMATCH. The reconstruction does not match what was signed, so this raw\n" +
      "transaction would be attributed to the wrong sender. Not broadcasting.",
  );
  process.exit(1);
}
console.log("MATCH — the reconstruction is byte-identical to what the vault signed.\n");

// 4. Assemble the signed transaction.
const signed = Buffer.concat([
  Buffer.from([0x02]),
  rlpList([...fields, rlpUint(BigInt(recid)), rlpUint(r), rlpUint(s)]),
]);
const raw = "0x" + hex(signed);
console.log("raw transaction  :", raw.slice(0, 80) + "... (" + signed.length + " bytes)");

// 5. Broadcast, if asked.
if (!doBroadcast) {
  console.log("\nNot broadcasting (pass --broadcast to send it to Base).");
  process.exit(0);
}

const sent = await rpc(BASE_RPC, { method: "eth_sendRawTransaction", params: [raw] });
if (sent.error) {
  console.error("\nBase rejected it:", JSON.stringify(sent.error));
  process.exit(1);
}
console.log("\nBroadcast. Base tx hash:", sent.result);

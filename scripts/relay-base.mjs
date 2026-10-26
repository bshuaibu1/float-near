#!/usr/bin/env node
/**
 * Delivers a Base payment the NEAR vault has already authorized.
 *
 * TWO MODES, ONE AUTHORIZATION GATE.
 *
 *   --mode vault     broadcast the transaction the MPC signed. Needs the
 *                    vault's own derived Base address funded with ETH + USDC.
 *                    Non-custodial: nobody but the MPC can move those funds.
 *
 *   --mode operator  send USDC from an OPERATOR address and pay the Base gas,
 *                    so the user funds NEAR only. CUSTODIAL ON THE BASE LEG —
 *                    the operator holds that float and could in principle not
 *                    deliver. Say so plainly anywhere this is described.
 *
 * What makes operator mode safe is the gate they share. Before either mode
 * moves anything, the script rebuilds the exact transaction from the request
 * THE CONTRACT STORED, and checks that the MPC signature over that rebuild
 * recovers to the vault's derived address. That proves the vault authorized
 * this payee for this amount. Without that check, operator mode would mean
 * "whoever can call the adapter can spend the operator's money".
 *
 * THIS SCRIPT IS OUTSIDE THE TRUST MODEL for the NEAR side. It cannot cause a
 * payment the vault refused, cannot change a budget, and holds no NEAR key.
 * The budget tree on NEAR remains the only source of truth for what may be
 * spent; delivery on Base is an off-chain fact recorded off-chain.
 *
 * Usage:
 *   node scripts/relay-base.mjs <near-tx-hash> <signer-account-id> [options]
 *     --mode vault|operator   default: vault
 *     --send                  actually move funds. Without it, verify only.
 *   env:
 *     RELAY_REQUEST_ID        required — the vault indexes by request id
 *     OPERATOR_PRIVATE_KEY    required for --mode operator (hex, 32 bytes)
 *     RELAY_LEDGER            default .demo/relay-ledger.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const NEAR_RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v3.floatvault-12329.testnet";
const SIGNER = process.env.MPC_CONTRACT ?? "v1.signer-prod.testnet";
const LEDGER = process.env.RELAY_LEDGER ?? ".demo/relay-ledger.json";

// ---------------------------------------------------------------- utilities

const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (s) => Buffer.from(s.replace(/^0x/, ""), "hex");

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

// RLP, mirroring contracts/vault/src/evm.rs. The Rust side is pinned against
// the canonical spec vectors; this must agree byte for byte or the recovered
// sender will not match — which is exactly how the gate below detects drift.
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

/** ERC-20 transfer(to, amount) calldata. */
function transferCalldata(payee, amount) {
  return Buffer.concat([
    Buffer.from("a9059cbb", "hex"),
    Buffer.alloc(12),
    payee,
    Buffer.alloc(16),
    Buffer.from(amount.toString(16).padStart(32, "0"), "hex"),
  ]);
}

async function rpc(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
  if (!r.ok) throw new Error(`${url} returned HTTP ${r.status}`);
  return r.json();
}
const baseCall = async (method, params) => {
  const d = await rpc(BASE_RPC, { method, params });
  if (d.error) throw new Error(`${method}: ${JSON.stringify(d.error)}`);
  return d.result;
};

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
 * The MPC signature, from the NEAR transaction's receipts.
 *
 * It is NOT stored on-chain — the vault's callback only checks whether the
 * promise succeeded, so the signature exists only in the receipt outcome.
 */
async function signatureFromTx(txHash, senderId) {
  const d = await rpc(NEAR_RPC, { method: "EXPERIMENTAL_tx_status", params: [txHash, senderId] });
  if (d.error) throw new Error(`tx_status: ${JSON.stringify(d.error).slice(0, 300)}`);
  for (const o of d.result?.receipts_outcome ?? []) {
    const sv = o.outcome?.status?.SuccessValue;
    if (!sv) continue;
    try {
      const parsed = JSON.parse(Buffer.from(sv, "base64").toString("utf8"));
      if (parsed?.big_r && parsed?.s) return parsed;
    } catch {
      /* not the signature receipt */
    }
  }
  throw new Error(
    "no MPC signature in this transaction's receipts. A BLOCKED payment never " +
      "reaches the signer, which is the point — there is nothing to deliver.",
  );
}

// ------------------------------------------------- the authorization gate

/**
 * Proves the vault authorized this exact payee and amount.
 *
 * Everything here comes from the CONTRACT's stored request, never from the
 * caller. Returns the verified facts both modes rely on.
 */
async function verifyAuthorization(requestId, txHash, senderId) {
  const cfg = await nearView(VAULT, "get_base_config", {});
  if (!cfg) throw new Error("the Base rail is closed on this vault");

  const req = await nearView(VAULT, "get_request", { request_id: requestId });
  if (!req) throw new Error(`no stored request ${requestId}`);
  if (req.reason_code !== "SIGNED") {
    throw new Error(
      `request ${requestId} is ${req.reason_code}, not SIGNED. Nothing was authorized.`,
    );
  }
  const route = req.route?.base_usdc;
  if (!route) throw new Error(`request ${requestId} was not routed over Base`);

  const sig = await signatureFromTx(txHash, senderId);

  const to = fromHex(cfg.usdc_address);
  const payee = fromHex(req.recipient);
  const amount = BigInt(req.amount);
  const data = transferCalldata(payee, amount);

  const fields = [
    rlpUint(BigInt(cfg.chain_id)),
    rlpUint(BigInt(route.nonce)),
    rlpUint(BigInt(route.max_priority_fee_per_gas)),
    rlpUint(BigInt(route.max_fee_per_gas)),
    rlpUint(BigInt(route.gas_limit)),
    rlpBytes(to),
    rlpUint(0n),
    rlpBytes(data),
    rlpList([]),
  ];
  const unsigned = Buffer.concat([Buffer.from([0x02]), rlpList(fields)]);
  const sighash = keccak_256(unsigned);

  const r = BigInt("0x" + sig.big_r.affine_point.slice(2));
  const s = BigInt("0x" + sig.s.scalar);
  const recovered = new secp256k1.Signature(r, s)
    .addRecoveryBit(sig.recovery_id)
    .recoverPublicKey(sighash)
    .toRawBytes(false)
    .slice(1);
  const recoveredAddr = addressOf(recovered);

  const derivedPk = await nearView(SIGNER, "derived_public_key", {
    path: cfg.derivation_path,
    predecessor: VAULT,
    domain_id: cfg.domain_id,
  });
  const vaultAddr = addressOf(b58decode(derivedPk.split(":")[1]));

  if (recoveredAddr !== vaultAddr) {
    throw new Error(
      `AUTHORIZATION MISMATCH. Rebuilt transaction recovers to ${recoveredAddr}, ` +
        `but the vault's address is ${vaultAddr}. Refusing to move anything.`,
    );
  }

  const rawSigned =
    "0x" +
    hex(
      Buffer.concat([
        Buffer.from([0x02]),
        rlpList([...fields, rlpUint(BigInt(sig.recovery_id)), rlpUint(r), rlpUint(s)]),
      ]),
    );

  return { cfg, req, route, payee, amount, usdc: to, sighash, vaultAddr, rawSigned };
}

// -------------------------------------------------------------- the ledger

/**
 * Delivery is an OFF-CHAIN fact and is recorded off-chain. The NEAR budget
 * already moved when the vault signed; nothing here may change it.
 *
 * It also makes delivery idempotent: paying the same request twice would spend
 * the operator's float for one authorization.
 */
function readLedger() {
  if (!existsSync(LEDGER)) return {};
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return {};
  }
}
function writeLedger(l) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n");
}

// ---------------------------------------------------------- operator mode

function operatorKey() {
  const k = process.env.OPERATOR_PRIVATE_KEY;
  if (!k) {
    throw new Error(
      "OPERATOR_PRIVATE_KEY is not set. Operator mode sends USDC from an address " +
        "you control and pays the Base gas, so the user funds NEAR only. That leg " +
        "is CUSTODIAL — describe it as operator-facilitated, never as trustless.",
    );
  }
  return fromHex(k);
}

/** Builds, signs and (optionally) sends a transfer from the operator. */
async function operatorSend({ usdc, payee, amount, chainId, send }) {
  const priv = operatorKey();
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  const from = addressOf(pub);
  console.log("operator address :", from);

  // Preflight, so an underfunded operator fails with a sentence rather than a
  // chain error after the fact.
  const [balHex, ethHex, nonceHex, feeHex] = await Promise.all([
    baseCall("eth_call", [
      { to: "0x" + hex(usdc), data: "0x70a08231" + "0".repeat(24) + from.slice(2) },
      "latest",
    ]),
    baseCall("eth_getBalance", [from, "latest"]),
    baseCall("eth_getTransactionCount", [from, "latest"]),
    baseCall("eth_gasPrice", []),
  ]);
  const usdcBal = BigInt(balHex === "0x" ? "0x0" : balHex);
  const ethBal = BigInt(ethHex);
  const nonce = BigInt(nonceHex);
  const gasPrice = BigInt(feeHex);
  const gasLimit = 120000n;
  const maxFee = gasPrice * 2n;
  const gasCost = gasLimit * maxFee;

  console.log(`operator USDC    : ${usdcBal} (need ${amount})`);
  console.log(`operator ETH     : ${ethBal} wei (need ~${gasCost} for gas)`);

  if (usdcBal < amount) {
    throw new Error(
      `operator USDC balance ${usdcBal} is below the ${amount} this payment needs. ` +
        `Top up ${from} on Base. The NEAR reservation has ALREADY been consumed — ` +
        `the vault signed — so this payment is authorized but undelivered.`,
    );
  }
  if (ethBal < gasCost) {
    throw new Error(
      `operator ETH balance ${ethBal} wei cannot cover ~${gasCost} wei of gas. ` +
        `Top up ${from} on Base.`,
    );
  }

  const data = transferCalldata(payee, amount);
  const fields = [
    rlpUint(BigInt(chainId)),
    rlpUint(nonce),
    rlpUint(gasPrice),
    rlpUint(maxFee),
    rlpUint(gasLimit),
    rlpBytes(usdc),
    rlpUint(0n),
    rlpBytes(data),
    rlpList([]),
  ];
  const sighash = keccak_256(Buffer.concat([Buffer.from([0x02]), rlpList(fields)]));
  const sig = secp256k1.sign(sighash, priv);
  const raw =
    "0x" +
    hex(
      Buffer.concat([
        Buffer.from([0x02]),
        rlpList([
          ...fields,
          rlpUint(BigInt(sig.recovery)),
          rlpUint(sig.r),
          rlpUint(sig.s),
        ]),
      ]),
    );

  if (!send) {
    console.log("\nPreflight passed. Not sending (pass --send).");
    return null;
  }
  return baseCall("eth_sendRawTransaction", [raw]);
}

// ------------------------------------------------------------------- main

const argv = process.argv.slice(2);
const [txHash, senderId] = argv.filter((a) => !a.startsWith("--"));
const mode = (argv.find((a) => a.startsWith("--mode"))?.split("=")[1] ??
  (argv.includes("--mode") ? argv[argv.indexOf("--mode") + 1] : null) ??
  "vault");
const send = argv.includes("--send");
const requestId = process.env.RELAY_REQUEST_ID;

if (!txHash || !senderId || !requestId) {
  console.error(
    "usage: RELAY_REQUEST_ID=<id> node scripts/relay-base.mjs <near-tx-hash> " +
      "<signer-account-id> [--mode vault|operator] [--send]",
  );
  process.exit(2);
}

const ledger = readLedger();
if (ledger[requestId]?.baseTxHash) {
  console.log(`Already delivered: ${ledger[requestId].baseTxHash} (${ledger[requestId].mode})`);
  console.log("Refusing to pay twice for one authorization.");
  process.exit(0);
}

const v = await verifyAuthorization(requestId, txHash, senderId);
console.log("request          :", requestId);
console.log("authorized payee :", v.req.recipient);
console.log("authorized amount:", v.amount.toString(), "base units");
console.log("vault's address  :", v.vaultAddr);
console.log("AUTHORIZED — the vault's signature covers exactly this payee and amount.\n");

let baseTxHash = null;
if (mode === "operator") {
  baseTxHash = await operatorSend({
    usdc: v.usdc,
    payee: v.payee,
    amount: v.amount,
    chainId: v.cfg.chain_id,
    send,
  });
} else if (mode === "vault") {
  console.log("raw (vault-signed):", v.rawSigned.slice(0, 72) + "...");
  if (!send) {
    console.log("\nNot broadcasting (pass --send).");
  } else {
    baseTxHash = await baseCall("eth_sendRawTransaction", [v.rawSigned]);
  }
} else {
  throw new Error(`unknown --mode ${mode}; expected vault or operator`);
}

if (baseTxHash) {
  ledger[requestId] = {
    mode,
    baseTxHash,
    payee: v.req.recipient,
    amount: v.amount.toString(),
    at: new Date().toISOString(),
  };
  writeLedger(ledger);
  console.log("\nDelivered on Base:", baseTxHash);
  console.log("recorded in", LEDGER);
}

#!/usr/bin/env node
/**
 * Live testnet round-trip for a virtual agent.
 *
 * Proves three things against a real runtime, in one run:
 *   1. a signed payment settles through the on_transfer_result callback
 *   2. the nonce advances on-chain
 *   3. a replay is refused BY THE CONTRACT
 *
 * On (3): relay() pre-checks the nonce client-side and throws before paying
 * gas, so replaying through relay() would only prove the JS guard works. That
 * guard is a cost control, not the security boundary. To test the boundary we
 * must submit the identical signed payload DIRECTLY, bypassing relay(), and
 * read what the contract does with it.
 *
 * Usage: node scripts/roundtrip-virtual-agent.mjs <step>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Same import surface the project's own float-adapter uses.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { sign, relay, encodeBinding } from "../packages/create-float/bin/float-relay.mjs";

const VAULT = "v4.floatv4.testnet";
const OWNER = "floatv4.testnet";
const TOKEN = "ft.floatv4.testnet";
const PAYEE = "floatv4.testnet";
const NODE_ID = 0;
const STATE = join(process.cwd(), ".demo", "roundtrip-state.json");

const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });

function credPath(account) {
  return join(homedir(), ".near-credentials", "testnet", `${account}.json`);
}

function ownerAccount() {
  const { private_key, secret_key } = JSON.parse(readFileSync(credPath(OWNER), "utf8"));
  const signer = new KeyPairSigner(KeyPair.fromString(private_key ?? secret_key));
  return new Account(OWNER, provider, signer);
}

function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
}
function saveState(s) {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

const view = (method, args = {}) =>
  provider.callFunction({ contractId: VAULT, method, args });

const ftBalance = (account_id) =>
  provider.callFunction({ contractId: TOKEN, method: "ft_balance_of", args: { account_id } });

// ---------------------------------------------------------------- steps

/** Generate the agent keypair. Never leaves this machine; no account needed. */
async function keygen() {
  const kp = KeyPair.fromRandom("ed25519");
  const s = loadState();
  s.agentSecret = kp.toString();
  s.agentPublic = kp.getPublicKey().toString();
  saveState(s);
  console.log("agent public key:", s.agentPublic);
  console.log("(no NEAR account created - this is the whole point of a virtual agent)");
}

/** Sign fully offline, then show the exact bytes that were signed. */
async function signOffline() {
  const s = loadState();
  if (!s.agentSecret) throw new Error("run keygen first");

  // Deadline well in the future; nonce taken from chain but signing itself is
  // offline. Read it here only to pick a fresh value.
  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
  const deadlineNs = String((BigInt(Date.now()) + 3600_000n) * 1_000_000n);

  const binding = {
    vault: VAULT,
    nonce,
    deadlineNs,
    requestId: `vrt-${Date.now()}`,
    token: TOKEN,
    amount: "2500000", // 2.5 tokens at 6dp
    recipient: PAYEE,
    memo: "virtual agent live round-trip",
    route: null, // NearDirect
  };

  const signed = sign(s.agentSecret, binding);
  const bytes = encodeBinding(binding);

  s.binding = binding;
  s.signed = signed;
  saveState(s);

  console.log("signed offline (no network used by sign())");
  console.log("  nonce          :", nonce);
  console.log("  request_id     :", binding.requestId);
  console.log("  amount         :", binding.amount);
  console.log("  borsh bytes    :", bytes.length, "B sha256-free hex head:", bytes.toString("hex").slice(0, 48));
  console.log("  public_key     :", signed.public_key);
  console.log("  signature(b64) :", signed.signature.slice(0, 32) + "...");
}

/** Relay as owner, through the project's own relay(). */
async function doRelay() {
  const s = loadState();
  const before = {
    vault: await ftBalance(VAULT),
    payee: await ftBalance(PAYEE),
    nonce: await view("get_virtual_agent_nonce", { public_key: s.signed.public_key }),
  };
  console.log("BEFORE:", JSON.stringify(before));

  // relay() uses Account.callFunction, which resolves to the PARSED return
  // value, not the execution outcome -- so there is no gas detail to read
  // here. Gas is measured by the `measure` step, which submits the identical
  // call via callFunctionRaw.
  const value = await relay({
    provider,
    ownerAccount: ownerAccount(),
    vault: VAULT,
    binding: s.binding,
    signed: s.signed,
  });
  console.log("relay() returned:", JSON.stringify(value));

  const after = {
    vault: await ftBalance(VAULT),
    payee: await ftBalance(PAYEE),
    nonce: await view("get_virtual_agent_nonce", { public_key: s.signed.public_key }),
  };
  console.log("AFTER :", JSON.stringify(after));
  console.log("request on-chain:", JSON.stringify(await view("get_request", { request_id: s.binding.requestId })));
  saveState({ ...s, before, after });
}

/** The raw args shape `request_payment_signed` takes. */
function callArgs(b, signed) {
  return {
    request_id: b.requestId,
    token: b.token,
    amount: String(b.amount),
    recipient: b.recipient,
    memo: b.memo,
    route: b.route ?? null,
    public_key: signed.public_key,
    nonce: Number(b.nonce),
    deadline_ns: String(b.deadlineNs),
    signature: signed.signature,
  };
}

/** Print the full gas/status breakdown of an execution outcome. */
function reportOutcome(o) {
  const txGas = Number(o.transaction_outcome.outcome.gas_burnt);
  const rcptGas = o.receipts_outcome.reduce((a, r) => a + Number(r.outcome.gas_burnt), 0);
  console.log("tx:", o.transaction_outcome.id);
  console.log(`gas burned: tx=${(txGas / 1e12).toFixed(2)} receipts=${(rcptGas / 1e12).toFixed(2)} TOTAL=${((txGas + rcptGas) / 1e12).toFixed(2)} TGas`);
  for (const r of o.receipts_outcome) {
    const kind = Object.keys(r.outcome.status)[0];
    console.log(`  receipt ${r.id.slice(0, 10)} gas=${(Number(r.outcome.gas_burnt) / 1e12).toFixed(2)}TGas ${kind}` +
      (kind === "Failure" ? " " + JSON.stringify(r.outcome.status.Failure) : ""));
    for (const l of r.outcome.logs) console.log("      log:", l);
  }
  const sv = o.status?.SuccessValue;
  if (sv !== undefined) console.log("RETURN:", Buffer.from(sv, "base64").toString() || "(empty)");
  else console.log("STATUS:", JSON.stringify(o.status));
}

/**
 * Sign a FRESH nonce and submit at a chosen gas budget, reporting the full
 * breakdown. This is how the "does signature verification fit inside 100
 * TGas" question gets an answer from the runtime instead of from reasoning.
 *
 *   node scripts/roundtrip-virtual-agent.mjs measure [TGas]
 */
async function measure() {
  const tgas = BigInt(process.argv[3] ?? "100");
  // `deep` selects the agent bound at MAX_DEPTH, which is the worst case for
  // the two reservation passes: they walk every ancestor. Measuring only the
  // root would understate the hot path by three levels.
  const deep = process.argv[4] === "deep";
  const s = loadState();
  const secret = deep ? s.deepSecret : s.agentSecret;
  const pub = deep ? s.deepPublic : s.agentPublic;
  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: pub }));
  const binding = {
    vault: VAULT,
    nonce,
    deadlineNs: String((BigInt(Date.now()) + 3600_000n) * 1_000_000n),
    requestId: `vrt-m${tgas}${deep ? "d" : ""}-${Date.now()}`,
    token: TOKEN,
    amount: "1000000",
    recipient: PAYEE,
    memo: `gas probe at ${tgas} TGas${deep ? " depth4" : ""}`,
    route: null,
  };
  const signed = sign(secret, binding);
  console.log(`submitting nonce=${nonce} at ${tgas} TGas (${deep ? "depth 4 / node 3" : "depth 1 / node 0"})`);
  const payee0 = await ftBalance(PAYEE);

  let o;
  try {
    o = await ownerAccount().callFunctionRaw({
      contractId: VAULT,
      methodName: "request_payment_signed",
      args: callArgs(binding, signed),
      gas: tgas * 10n ** 12n,
      deposit: 0n,
    });
  } catch (e) {
    console.log("THREW:", e.message);
    console.log("nonce after:", await view("get_virtual_agent_nonce", { public_key: pub }));
    console.log("payee delta:", BigInt(await ftBalance(PAYEE)) - BigInt(payee0));
    return;
  }
  reportOutcome(o);
  console.log("request:", JSON.stringify(await view("get_request", { request_id: binding.requestId })));
  console.log("nonce after:", await view("get_virtual_agent_nonce", { public_key: pub }));
  console.log("payee delta:", BigInt(await ftBalance(PAYEE)) - BigInt(payee0));
}

/**
 * Replay the IDENTICAL signed payload, bypassing relay()'s client-side nonce
 * pre-check, so that what refuses it is the contract and nothing else.
 */
async function replay() {
  const s = loadState();
  const b = s.binding;
  console.log("replaying identical payload directly (relay() pre-check bypassed on purpose)");
  console.log("  nonce:", b.nonce, " chain expects >=",
    await view("get_virtual_agent_nonce", { public_key: s.signed.public_key }));

  const payee0 = await ftBalance(PAYEE);
  const outcome = await ownerAccount().callFunctionRaw({
    contractId: VAULT,
    methodName: "request_payment_signed",
    args: callArgs(b, s.signed),
    gas: 100n * 10n ** 12n,
    deposit: 0n,
  });
  reportOutcome(outcome);
  const payee1 = await ftBalance(PAYEE);
  console.log(`payee balance: before=${payee0} after=${payee1} delta=${BigInt(payee1) - BigInt(payee0)} (must be 0)`);
}

/**
 * Isolate what ed25519 verification actually costs.
 *
 * A fresh nonce with a TAMPERED signature reaches borsh-encode +
 * env::ed25519_verify and then stops, so its receipt gas minus the
 * nonce-rejected path's receipt gas is the cost of the crypto itself. Without
 * this subtraction, "the settle path burns N TGas" says nothing about whether
 * signature verification is what makes it expensive.
 */
async function sigcost() {
  const s = loadState();
  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
  const binding = {
    vault: VAULT,
    nonce,
    deadlineNs: String((BigInt(Date.now()) + 3600_000n) * 1_000_000n),
    requestId: `vrt-badsig-${Date.now()}`,
    token: TOKEN,
    amount: "1000000",
    recipient: PAYEE,
    memo: "tampered signature probe",
    route: null,
  };
  const good = sign(s.agentSecret, binding);
  // Flip one byte: still 64 bytes, so it reaches ed25519_verify rather than
  // being rejected on length.
  const raw = Buffer.from(good.signature, "base64");
  raw[0] ^= 0xff;
  const tampered = { ...good, signature: raw.toString("base64") };

  console.log(`submitting nonce=${nonce} with a TAMPERED 64-byte signature at 100 TGas`);
  const o = await ownerAccount().callFunctionRaw({
    contractId: VAULT,
    methodName: "request_payment_signed",
    args: callArgs(binding, tampered),
    gas: 100n * 10n ** 12n,
    deposit: 0n,
  });
  reportOutcome(o);
  console.log("nonce after:", await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
}

/**
 * Does a post-burn `blocked()` actually consume the nonce?
 *
 * The contract burns the nonce after authentication but before dispatch, so
 * that "one signature is worth at most one attempt". A validly-signed payment
 * to a NON-allowlisted recipient is authenticated (burn happens) and then
 * rejected by dispatch via a value-returning `blocked()`, which does not
 * revert. So the nonce must advance. If it did not, a rejected-but-valid
 * payload would stay replayable.
 */
async function blockedNonce() {
  const s = loadState();
  // Optional key selector so this can also be pointed at a NEVER-USED key, in
  // which case the storage delta isolates the pubkey_to_nonce entry (a blocked
  // payment stores no PaymentRequest).
  const which = process.argv[3] ?? "agent";
  const secret = { agent: s.agentSecret, deep: s.deepSecret, deep2: s.deep2Secret }[which];
  const pub = { agent: s.agentPublic, deep: s.deepPublic, deep2: s.deep2Public }[which];
  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: pub }));
  const binding = {
    vault: VAULT,
    nonce,
    deadlineNs: String((BigInt(Date.now()) + 3600_000n) * 1_000_000n),
    requestId: `vrt-notallowed-${Date.now()}`,
    token: TOKEN,
    amount: "1000000",
    recipient: "notallowed.testnet", // valid account id, absent from the allowlist
    memo: "post-burn blocked path",
    route: null,
  };
  const signed = sign(secret, binding);
  console.log(`submitting VALIDLY SIGNED nonce=${nonce} (key=${which}) to a non-allowlisted recipient`);
  const o = await ownerAccount().callFunctionRaw({
    contractId: VAULT,
    methodName: "request_payment_signed",
    args: callArgs(binding, signed),
    gas: 100n * 10n ** 12n,
    deposit: 0n,
  });
  reportOutcome(o);
  const after = await view("get_virtual_agent_nonce", { public_key: pub });
  console.log(`nonce: before=${nonce} after=${after} (must advance, else the payload stays replayable)`);
}

const steps = {
  keygen, sign: signOffline, relay: doRelay, replay, measure, sigcost,
  "blocked-nonce": blockedNonce,
};
const step = process.argv[2];
if (!steps[step]) {
  console.error(`usage: node scripts/roundtrip-virtual-agent.mjs <${Object.keys(steps).join("|")}>`);
  process.exit(1);
}
steps[step]().catch((e) => {
  console.error("FAILED:", e.message);
  if (e.context) console.error(JSON.stringify(e.context, null, 2));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Route::Intents dry run on testnet, against a REAL NEP-141.
 *
 * WHAT THIS PROVES, AND WHAT IT CANNOT.
 *
 * NEAR Intents has no testnet — `packages/mcp/src/quote.ts:27` says so, and
 * the 1Click asset ids there are mainnet-only. So the solver half of this flow
 * cannot be exercised anywhere but mainnet, and nothing here pretends to.
 *
 * What IS exercised, end to end, on chain:
 *   - the quote-signer gate: the rail is closed (QUOTE_SIGNER_UNSET) until the
 *     owner registers a key, and the key must have signed the exact binding
 *   - the address-to-payee binding: money leaves to a deposit_address that is
 *     NOT on the payee allowlist, permitted only because the owner's signature
 *     ties it to an allowlisted payee. This is the property that keeps the
 *     allowlist from being decorative
 *   - a REAL NEP-141 (usdc.fakes.testnet, 6dp, real storage accounting) rather
 *     than mock_ft, inside the vault's fixed 10 Tgas ft_transfer budget
 *   - virtual-agent authorisation, with per-key nonce replay protection
 *   - real gas, to compare against the NearDirect baseline of 7.85 Tgas
 *
 * What is NOT proven: that a solver fills the order. The deposit_address here
 * is an account we control standing in for a one-time quote address. On
 * mainnet the owner's backend gets that address from 1Click and signs the same
 * binding — the signing step is the production mechanism, not a stub, but the
 * counterparty is absent.
 *
 * Usage: node scripts/intents-dryrun.mjs <keygen|register|pay|verify>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

const VAULT = "v4.floatv4.testnet";
const OWNER = "floatv4.testnet";
const TOKEN = "usdc.fakes.testnet";
const PAYEE = "floatv4.testnet";          // on the allowlist
const DEPOSIT = "solver.floatv4.testnet"; // deliberately NOT on the allowlist
const NODE = 24;
const STATE = ".demo/intents-dryrun.json";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC });

function ownerAccount() {
  const p = join(homedir(), ".near-credentials", "testnet", `${OWNER}.json`);
  const { private_key, secret_key } = JSON.parse(readFileSync(p, "utf8"));
  return new Account(OWNER, provider, new KeyPairSigner(KeyPair.fromString(private_key ?? secret_key)));
}
const view = (m, a = {}) => provider.callFunction({ contractId: VAULT, method: m, args: a });
const ft = (m, a) => provider.callFunction({ contractId: TOKEN, method: m, args: a });
const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s) => { mkdirSync(".demo", { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); };

// ---- borsh primitives, same shape as float-relay.mjs
const bstr = (s) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const bu64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const bu128 = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };

/**
 * QuoteBinding, from contracts/vault/src/types.rs. Field order is load-bearing:
 *   vault, request_id, token, amount, payee, deposit_address, deadline_ns
 * `payee` is a String (recipient.to_string()), not an AccountId — same bytes.
 */
const encodeQuote = (q) => Buffer.concat([
  bstr(q.vault), bstr(q.requestId), bstr(q.token), bu128(q.amount),
  bstr(q.payee), bstr(q.depositAddress), bu64(q.deadlineNs),
]);

/**
 * VirtualAgentBinding with Route::Intents. The Route enum is borsh-tagged by
 * POSITION: NearDirect=0, Intents=1.
 */
const encodeAgent = (b) => Buffer.concat([
  bstr(b.vault), bu64(b.nonce), bu64(b.deadlineNs), bstr(b.requestId),
  bstr(b.token), bu128(b.amount), bstr(b.recipient), bstr(b.memo),
  Buffer.from([1]),
  bstr(b.route.depositAddress), bu64(b.route.quoteDeadlineNs),
  (() => { const s = Buffer.from(b.route.signature, "base64"); const l = Buffer.alloc(4); l.writeUInt32LE(s.length); return Buffer.concat([l, s]); })(),
]);

async function keygen() {
  const s = load();
  const quote = KeyPair.fromRandom("ed25519");
  const agent = KeyPair.fromRandom("ed25519");
  s.quoteSecret = quote.toString();
  s.quotePublic = quote.getPublicKey().toString();
  s.agentSecret = agent.toString();
  s.agentPublic = agent.getPublicKey().toString();
  // set_quote_signer takes the RAW 32 bytes, base64 — not the ed25519: form.
  s.quoteRaw32 = Buffer.from(quote.getPublicKey().data).toString("base64");
  save(s);
  console.log("  quote signer :", s.quotePublic);
  console.log("  raw32 (b64)  :", s.quoteRaw32);
  console.log("  agent key    :", s.agentPublic);
}

async function register() {
  const s = load();
  const acct = ownerAccount();
  console.log("  rail closed before registering? ", JSON.stringify(await view("get_quote_signer")));
  await acct.callFunction({ contractId: VAULT, methodName: "set_quote_signer",
    args: { public_key: s.quoteRaw32 }, gas: 50n * 10n ** 12n, deposit: 1n });
  console.log("  quote signer now:", JSON.stringify(await view("get_quote_signer")));
  await acct.callFunction({ contractId: VAULT, methodName: "bind_virtual_agent",
    args: { node_id: NODE, public_key: s.agentPublic }, gas: 50n * 10n ** 12n, deposit: 1n });
  console.log("  agent bound to node:", await view("get_virtual_agent_node", { public_key: s.agentPublic }));
}

async function pay() {
  const s = load();
  const acct = ownerAccount();
  const amount = 25_000_000n; // 25.00 at 6dp, under the 50.00 per-tx cap
  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
  const nowNs = BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp);
  const deadlineNs = String(nowNs + 3_600_000_000_000n);
  const requestId = `intents-${nonce}-${String(nowNs).slice(-6)}`;

  // 1. the OWNER's quote signer binds deposit_address -> allowlisted payee.
  const quote = { vault: VAULT, requestId, token: TOKEN, amount: String(amount),
    payee: PAYEE, depositAddress: DEPOSIT, deadlineNs };
  const quoteSig = Buffer.from(KeyPair.fromString(s.quoteSecret).sign(encodeQuote(quote)).signature).toString("base64");

  // 2. the AGENT signs the payment, carrying that quote signature inside it.
  const binding = { vault: VAULT, nonce, deadlineNs, requestId, token: TOKEN,
    amount: String(amount), recipient: PAYEE, memo: "intents dry run",
    route: { depositAddress: DEPOSIT, quoteDeadlineNs: deadlineNs, signature: quoteSig } };
  const agentSig = Buffer.from(KeyPair.fromString(s.agentSecret).sign(encodeAgent(binding)).signature).toString("base64");

  const before = { vault: await ft("ft_balance_of", { account_id: VAULT }),
                   deposit: await ft("ft_balance_of", { account_id: DEPOSIT }),
                   payee: await ft("ft_balance_of", { account_id: PAYEE }) };
  console.log("  BEFORE:", JSON.stringify(before));
  console.log(`  paying ${amount} to deposit_address ${DEPOSIT} (NOT allowlisted), payee ${PAYEE}`);

  const out = await acct.callFunctionRaw({
    contractId: VAULT, methodName: "request_payment_signed",
    args: { request_id: requestId, token: TOKEN, amount: String(amount),
      recipient: PAYEE, memo: "intents dry run",
      // `intents`, lowercase: Route carries #[serde(rename_all = "snake_case")],
      // so the JSON variant tag is `intents` and `near_direct`. The borsh tag is
      // positional (0/1) and unaffected — two different encodings of one enum,
      // and only the JSON one is spelled this way.
      route: { intents: { deposit_address: DEPOSIT, quote_deadline_ns: deadlineNs, signature: quoteSig } },
      public_key: s.agentPublic, nonce, deadline_ns: deadlineNs, signature: agentSig },
    gas: 100n * 10n ** 12n, deposit: 0n,
  });

  const txGas = Number(out.transaction_outcome.outcome.gas_burnt);
  const rcpt = out.receipts_outcome.reduce((a, r) => a + Number(r.outcome.gas_burnt), 0);
  console.log("  tx:", out.transaction_outcome.id);
  console.log(`  GAS: tx=${(txGas / 1e12).toFixed(2)} receipts=${(rcpt / 1e12).toFixed(2)} TOTAL=${((txGas + rcpt) / 1e12).toFixed(2)} TGas  (NearDirect baseline 7.85)`);
  for (const r of out.receipts_outcome) {
    const k = Object.keys(r.outcome.status)[0];
    console.log(`    ${r.id.slice(0, 10)} ${(Number(r.outcome.gas_burnt) / 1e12).toFixed(2)}TGas ${k}` + (k === "Failure" ? " " + JSON.stringify(r.outcome.status.Failure) : ""));
    for (const l of r.outcome.logs) console.log("      log:", l);
  }
  const sv = out.status?.SuccessValue;
  console.log("  RETURN:", sv !== undefined ? Buffer.from(sv, "base64").toString() : JSON.stringify(out.status));
  save({ ...s, requestId });
}

async function verify() {
  const s = load();
  console.log("  request:", JSON.stringify(await view("get_request", { request_id: s.requestId })));
  for (const [n, a] of [["vault", VAULT], ["deposit_address", DEPOSIT], ["payee", PAYEE]]) {
    console.log(`  ${n.padEnd(16)} ${await ft("ft_balance_of", { account_id: a })}`);
  }
  console.log("  agent nonce:", await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
}

/**
 * THE DECISIVE NEGATIVE TEST. An agent substitutes its OWN deposit address,
 * keeping the owner's quote signature for the original one.
 *
 * Without this, the happy path proves only that a correctly-signed quote is
 * accepted — not that an incorrectly-signed one is refused, which is the
 * property the allowlist's meaning rests on. The deposit address can never be
 * on the payee allowlist (it is one-time), so if an agent could choose it
 * freely it would quote a swap paying itself and the vault would fund it with
 * every other check passing.
 *
 * The agent signs its OWN binding honestly here — it is entitled to. What it
 * cannot do is produce the OWNER's signature over a deposit address the owner
 * never approved. So the expected refusal is QUOTE_BAD_SIGNATURE, and getting
 * BAD_AGENT_SIGNATURE instead would mean this test is being carried by the
 * wrong clause.
 */
async function tamper() {
  const s = load();
  const acct = ownerAccount();
  const amount = 25_000_000n;
  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
  const nowNs = BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp);
  const deadlineNs = String(nowNs + 3_600_000_000_000n);
  const requestId = `intents-tamper-${nonce}-${String(nowNs).slice(-6)}`;
  const THIEF = "ft.floatv4.testnet"; // an account the agent controls, never quoted

  // The owner's signer approves the LEGITIMATE deposit address only.
  const honest = { vault: VAULT, requestId, token: TOKEN, amount: String(amount),
    payee: PAYEE, depositAddress: DEPOSIT, deadlineNs };
  const quoteSig = Buffer.from(KeyPair.fromString(s.quoteSecret).sign(encodeQuote(honest)).signature).toString("base64");

  // The agent swaps the address and re-signs its own binding around it.
  const binding = { vault: VAULT, nonce, deadlineNs, requestId, token: TOKEN,
    amount: String(amount), recipient: PAYEE, memo: "intents dry run",
    route: { depositAddress: THIEF, quoteDeadlineNs: deadlineNs, signature: quoteSig } };
  const agentSig = Buffer.from(KeyPair.fromString(s.agentSecret).sign(encodeAgent(binding)).signature).toString("base64");

  const before = await ft("ft_balance_of", { account_id: THIEF });
  console.log(`  owner signed deposit_address = ${DEPOSIT}`);
  console.log(`  agent SUBMITS  deposit_address = ${THIEF}  <-- redirect attempt`);

  const out = await acct.callFunctionRaw({
    contractId: VAULT, methodName: "request_payment_signed",
    args: { request_id: requestId, token: TOKEN, amount: String(amount),
      recipient: PAYEE, memo: "intents dry run",
      route: { intents: { deposit_address: THIEF, quote_deadline_ns: deadlineNs, signature: quoteSig } },
      public_key: s.agentPublic, nonce, deadline_ns: deadlineNs, signature: agentSig },
    gas: 100n * 10n ** 12n, deposit: 0n,
  });
  const sv = out.status?.SuccessValue;
  const o = sv !== undefined ? JSON.parse(Buffer.from(sv, "base64").toString()) : null;
  console.log("  RETURN:", JSON.stringify(o));
  const after = await ft("ft_balance_of", { account_id: THIEF });
  console.log(`  thief balance: before=${before} after=${after} delta=${BigInt(after) - BigInt(before)} (must be 0)`);

  if (o?.reason_code === "QUOTE_BAD_SIGNATURE" && BigInt(after) === BigInt(before)) {
    console.log("\n  PASS: the redirect was refused by the QUOTE signature, and nothing moved.");
    console.log("        An agent cannot point the vault at an address the owner never approved.");
  } else {
    console.log(`\n  FAIL: expected QUOTE_BAD_SIGNATURE with no movement, got ${o?.reason_code}`);
    process.exitCode = 1;
  }
}

const steps = { keygen, register, pay, verify, tamper };
const step = process.argv[2];
if (!steps[step]) { console.error(`usage: node scripts/intents-dryrun.mjs <${Object.keys(steps).join("|")}>`); process.exit(1); }
steps[step]().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });

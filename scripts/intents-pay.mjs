#!/usr/bin/env node
/**
 * A REAL cross-chain payment on mainnet: vault USDC on NEAR -> USDC on Base.
 *
 * This is the first thing in the repo that spends real money against a real
 * solver. scripts/intents-dryrun.mjs proves the vault's half of the rail on
 * testnet with an account we control standing in for the deposit address;
 * NEAR Intents has no testnet (packages/mcp/src/quote.ts:27), so the solver
 * half cannot be exercised anywhere else.
 *
 * WHY A SCRIPT AND NOT A SEQUENCE OF CLI CALLS. Three signatures have to agree
 * on one set of bytes:
 *
 *   1. the QUOTE SIGNER's, over QuoteBinding — binding the one-time deposit
 *      address to the allowlisted payee. Without it the allowlist is
 *      decorative: quote a swap paying yourself and every other check passes.
 *   2. the VIRTUAL AGENT's, over VirtualAgentBinding — authorising the spend
 *      from a node without owning a NEAR account.
 *   3. the solver's quote itself, which EXPIRES. amountIn and depositAddress
 *      are only valid until `deadline`.
 *
 * Any mismatch fails identically and silently — QUOTE_BAD_SIGNATURE tells you
 * nothing about which of the two borsh encodings drifted. Doing this by hand
 * across three terminals, against a clock, is how you burn a real quote.
 *
 * THE OWNER CANNOT PAY. `request_payment` derives its node from
 * `account_to_node[predecessor]`, and `assert_bindable` refuses to bind the
 * owner or the vault (lib.rs:1677). So a payment needs either a real agent
 * sub-account at 0.55 NEAR, or a virtual agent key at ~0.001 NEAR. This uses
 * the second: cheaper, revocable, and the surface with the most coverage.
 *
 * Usage:
 *   node --experimental-strip-types scripts/intents-pay.mjs keygen
 *   node --experimental-strip-types scripts/intents-pay.mjs check   # read-only
 *   node --experimental-strip-types scripts/intents-pay.mjs setup   # 2 owner txs
 *   node --experimental-strip-types scripts/intents-pay.mjs quote   # price only
 *   node --experimental-strip-types scripts/intents-pay.mjs pay
 *   node --experimental-strip-types scripts/intents-pay.mjs verify
 *
 * PAYEE / DELIVER may be overridden by env. Defaults are the first live run.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { getQuote, signBinding, publicKeyOf, toBase64 } from "../packages/mcp/src/quote.ts";

const NETWORK = "mainnet";
const VAULT = process.env.FLOAT_VAULT ?? "float.test015.near";
const OWNER = process.env.FLOAT_OWNER ?? "test015.near";
const TOKEN = process.env.FLOAT_TOKEN ??
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NODE_ID = Number(process.env.FLOAT_NODE ?? 0);

/**
 * The payee, LOWERCASED, and that is not cosmetic.
 *
 * A Base destination rides in the vault's ordinary `recipient` field as a
 * lowercase `0x…` string, which is a valid NEAR account id (lib.rs:1140). The
 * checksummed mixed-case form that wallets display is NOT: NEAR account ids
 * are lowercase-only, so `0xBa82…` is rejected before any of this runs.
 *
 * It matters a second time because the allowlist check is exact string
 * equality and `QuoteBinding.payee` is `recipient.to_string()`. The same
 * canonical string therefore has to reach the allowlist, the signature and
 * 1Click. EVM addresses are case-insensitive, so lowercase is safe to send to
 * the solver; sending the checksummed form there and the lowercase form
 * on-chain would work, but leaves two spellings of one address in the audit
 * trail for no benefit.
 */
const PAYEE_IN = process.env.FLOAT_PAYEE ?? "0xBa82e1aCf6058d345e083624b4F841b25F755449";
const PAYEE = PAYEE_IN.toLowerCase();

/** What the PAYEE receives, in base units. The vault is charged more. */
const DELIVER = BigInt(process.env.FLOAT_DELIVER ?? "500000");

const STATE = join(".float", "mainnet-intents.json");
const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://free.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC });

const TGAS = 10n ** 12n;
const view = (m, a = {}) => provider.callFunction({ contractId: VAULT, method: m, args: a });
const ftView = (m, a = {}) => provider.callFunction({ contractId: TOKEN, method: m, args: a });
/**
 * One node, tolerating the deployment that cannot answer `get_node`.
 *
 * float.test015.near shipped with an orphaned `#[private]` on `get_node` (see
 * tests/views.rs and M38), so on that build every view call to it returns
 * `ProhibitedInView`. `get_tree` was unaffected. This script needs node data to
 * read the per-tx cap and the allowlist, and refusing to run until the contract
 * is redeployed would make the fix a prerequisite for the payment it was found
 * by — so it falls back, and SAYS it is falling back. A silent fallback would
 * leave the stale build undetectable from here.
 */
let warnedGetNode = false;
async function getNode(id) {
  try {
    return await view("get_node", { node_id: id });
  } catch (err) {
    if (!String(err).includes("ProhibitedInView")) throw err;
    if (!warnedGetNode) {
      console.log("  NOTE: this vault's get_node is the pre-M38 build (orphaned #[private]);");
      console.log("        reading the node from get_tree instead. Redeploy to fix the view.");
      warnedGetNode = true;
    }
    const tree = await view("get_tree");
    const n = tree.find((x) => Number(x.id) === Number(id));
    if (!n) throw new Error(`node ${id} not in get_tree`);
    return n;
  }
}

const load = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s) => {
  mkdirSync(".float", { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n");
};
const usdc = (n) => `${(Number(n) / 1e6).toFixed(6)} USDC`;

function ownerAccount() {
  const p = join(homedir(), ".near-credentials", NETWORK, `${OWNER}.json`);
  if (!existsSync(p)) throw new Error(`no key for ${OWNER} at ${p}`);
  const { private_key, secret_key } = JSON.parse(readFileSync(p, "utf8"));
  return new Account(OWNER, provider, new KeyPairSigner(KeyPair.fromString(private_key ?? secret_key)));
}

/**
 * The quote signer's secret, from .float/adapter.env, as 32 RAW BYTES.
 *
 * FLOAT_QUOTE_SIGNER_KEY is 32-byte HEX, not near-api-js's
 * `ed25519:<base58>`. Both production consumers read it that way —
 * packages/mcp/src/server.ts:199 and packages/float-adapter/src/server.ts:328
 * — and this script originally fed it to `KeyPair.fromString`, which rejected
 * it outright with "Invalid encoded key format". A loud failure, fortunately;
 * the quiet version of this mistake is a key that parses and signs with the
 * wrong bytes, which is indistinguishable from a borsh drift.
 *
 * Parsed with the same one-liner as the MCP server, deliberately, rather than
 * a tidier equivalent — if that ever changes, this should fail to match rather
 * than silently diverge.
 *
 * Never printed. Only the derived PUBLIC key is echoed, and that is on chain.
 */
function quoteSecret() {
  const p = join(".float", "adapter.env");
  if (!existsSync(p)) throw new Error(`${p} not found — the wizard writes it at step 8`);
  const m = readFileSync(p, "utf8").match(/^FLOAT_QUOTE_SIGNER_KEY=(.+)$/m);
  if (!m) throw new Error(`FLOAT_QUOTE_SIGNER_KEY absent from ${p}`);
  const hex = m[1].trim().replace(/^0x/, "");
  const sk = Uint8Array.from(Buffer.from(hex, "hex"));
  if (sk.length !== 32) {
    throw new Error(
      `FLOAT_QUOTE_SIGNER_KEY must be 32-byte hex; got ${sk.length} bytes. ` +
        `An ed25519:<base58> value will not work here — see packages/mcp/src/server.ts:199.`,
    );
  }
  return sk;
}

// ---- borsh. Byte-identical to intents-dryrun.mjs, which is byte-identical to
// ---- contracts/vault/src/types.rs. A drift here fails exactly like a wrong
// ---- key, which is why the vector is pinned on both sides.
const bstr = (s) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };
const bu64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const bu128 = (n) => { const b = Buffer.alloc(16); let v = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
const bbytes = (buf) => { const l = Buffer.alloc(4); l.writeUInt32LE(buf.length); return Buffer.concat([l, buf]); };

// QuoteBinding is NOT re-encoded here. encodeBinding/signBinding in
// packages/mcp/src/quote.ts are the production encoder, asserted against the
// Rust side by `quote_binding_borsh_vector`; a second copy in this file would
// be one more thing that can drift into a silent QUOTE_BAD_SIGNATURE. The
// VirtualAgentBinding encoder below has no equivalent there, so it stays.

/** VirtualAgentBinding + Route::Intents. The Route tag is POSITIONAL: Intents = 1. */
const encodeAgent = (b) => Buffer.concat([
  bstr(b.vault), bu64(b.nonce), bu64(b.deadlineNs), bstr(b.requestId),
  bstr(b.token), bu128(b.amount), bstr(b.recipient), bstr(b.memo),
  Buffer.from([1]),
  bstr(b.route.depositAddress), bu64(b.route.quoteDeadlineNs),
  bbytes(Buffer.from(b.route.signature, "base64")),
]);

const sign = (kp, msg) => Buffer.from(kp.sign(msg).signature).toString("base64");

// ---------------------------------------------------------------- steps

async function keygen() {
  const s = load();
  if (s.agentSecret) {
    console.log("  agent key already exists:", s.agentPublic);
    console.log("  delete .float/mainnet-intents.json to rotate (then re-run setup)");
    return;
  }
  const agent = KeyPair.fromRandom("ed25519");
  s.agentSecret = agent.toString();
  s.agentPublic = agent.getPublicKey().toString();
  save(s);
  console.log("  agent key :", s.agentPublic);
  console.log(`  written to ${STATE} — gitignored, holds a spending key`);
}

/**
 * The two owner transactions, and a check that the quote signer is OURS.
 *
 * That last one is the cheap decisive test. The vault stores only the signer's
 * public key; if .float/adapter.env holds a different secret — a stale file, a
 * rotated key, a vault configured by another machine — every Intents payment
 * returns QUOTE_BAD_SIGNATURE, which is indistinguishable from a borsh drift.
 * Comparing the derived public key against `get_quote_signer` settles it before
 * a quote is ever bought.
 */
async function setup() {
  const s = load();
  if (!s.agentSecret) throw new Error("run keygen first");
  const acct = ownerAccount();

  const registered = await view("get_quote_signer");
  const derived = toBase64(publicKeyOf(quoteSecret()));
  console.log("  quote signer registered :", JSON.stringify(registered));
  console.log("  derived from adapter.env:", derived);
  if (!registered) throw new Error("no quote signer registered — the Intents rail is closed");
  if (registered !== derived) {
    throw new Error(
      `quote-signer MISMATCH. The vault trusts ${registered} but .float/adapter.env ` +
      `holds the secret for ${derived}. Every Intents payment would be refused ` +
      `with QUOTE_BAD_SIGNATURE. Fix the env file, or set_quote_signer to rotate.`,
    );
  }
  console.log("  -> match: signatures from this machine will verify\n");

  // 1. The payee allowlist. set_recipients REPLACES the list, so the existing
  //    entries are read and re-sent. Dropping the owner would strand the
  //    vault's balance: it is the only account that can receive a withdrawal.
  const node = await getNode(NODE_ID);
  const current = node.recipients ?? [];
  console.log("  current recipients:", JSON.stringify(current));
  if (current.includes(PAYEE)) {
    console.log("  payee already allowlisted — skipping set_recipients");
  } else {
    const next = [...current, PAYEE];
    if (!current.includes(OWNER)) {
      console.log(`  NOTE: ${OWNER} is not on this list; not adding it, but a withdrawal`);
      console.log("        needs an allowlisted recipient to land on.");
    }
    console.log("  set_recipients ->", JSON.stringify(next));
    await acct.callFunction({
      contractId: VAULT, methodName: "set_recipients",
      args: { node_id: NODE_ID, recipients: next }, gas: 50n * TGAS, deposit: 1n,
    });
    console.log("  recipients now:", JSON.stringify((await getNode(NODE_ID)).recipients));
  }

  // 2. The virtual agent.
  const bound = await view("get_virtual_agent_node", { public_key: s.agentPublic });
  if (bound !== null && bound !== undefined) {
    console.log(`  agent key already bound to node ${bound}`);
  } else {
    await acct.callFunction({
      contractId: VAULT, methodName: "bind_virtual_agent",
      args: { node_id: NODE_ID, public_key: s.agentPublic }, gas: 50n * TGAS, deposit: 1n,
    });
    console.log("  agent bound to node:", await view("get_virtual_agent_node", { public_key: s.agentPublic }));
  }
}

/**
 * Everything `setup` and `pay` depend on, READ ONLY.
 *
 * Split out because the quote-signer comparison is the single most valuable
 * check here and it used to be reachable only by running `setup`, which also
 * sends two owner transactions. A check you cannot run without spending is a
 * check people skip.
 */
async function check() {
  const s = load();
  const registered = await view("get_quote_signer");
  console.log("  quote signer registered :", JSON.stringify(registered));
  let derived = null;
  try {
    derived = toBase64(publicKeyOf(quoteSecret()));
    console.log("  derived from adapter.env:", derived);
  } catch (err) {
    console.log("  derived from adapter.env: FAILED —", String(err.message ?? err));
  }
  console.log("  signer match            :",
    registered && derived === registered ? "yes" : "NO — Intents payments would be refused");

  const node = await getNode(NODE_ID);
  const rec = node.recipients ?? [];
  console.log(`  node ${NODE_ID} recipients     :`, JSON.stringify(rec));
  console.log("  payee allowlisted       :", rec.includes(PAYEE) ? "yes" : "no — run setup");

  if (s.agentPublic) {
    const bound = await view("get_virtual_agent_node", { public_key: s.agentPublic });
    console.log("  agent key               :", s.agentPublic);
    console.log("  bound to node           :",
      bound === null || bound === undefined ? "NOT BOUND — run setup" : bound);
  } else {
    console.log("  agent key               : none — run keygen");
  }
  const bal = BigInt(await ftView("ft_balance_of", { account_id: VAULT }));
  console.log(`  vault balance           : ${usdc(bal)}`);
}

/** A dry quote: a price, not an instruction. No deposit address is issued. */
async function quote() {
  const q = await getQuote({
    amountOut: DELIVER, payee: PAYEE, refundTo: VAULT,
    deadline: new Date(Date.now() + 10 * 60_000), dry: true,
  });
  const inAmt = BigInt(q.amountIn);
  const lim = await view("get_node_budget", { node_id: NODE_ID, token: TOKEN });
  const bal = BigInt(await ftView("ft_balance_of", { account_id: VAULT }));
  const node = await getNode(NODE_ID);
  const perTx = BigInt(node.limits.find((l) => l.token === TOKEN).per_tx_cap);

  console.log(`  deliver on Base      : ${usdc(DELIVER)} -> ${PAYEE}`);
  console.log(`  charged to the vault : ${usdc(inAmt)}  (spread ${((Number(inAmt) / Number(DELIVER) - 1) * 100).toFixed(2)}%)`);
  console.log(`  per-tx cap           : ${usdc(perTx)}   ${inAmt <= perTx ? "OK" : "EXCEEDED -> PER_TX_LIMIT"}`);
  console.log(`  daily available      : ${usdc(lim.available)}   ${inAmt <= BigInt(lim.available) ? "OK" : "EXCEEDED -> DAILY_LIMIT"}`);
  console.log(`  vault balance        : ${usdc(bal)}   ${inAmt <= bal ? "OK" : "INSUFFICIENT -> transfer would fail"}`);
  console.log(`  eta                  : ~${q.timeEstimateSec}s`);
  return { inAmt, perTx, available: BigInt(lim.available), bal };
}

async function pay() {
  const s = load();
  if (!s.agentSecret) throw new Error("run keygen first");
  const agent = KeyPair.fromString(s.agentSecret);
  const qsk = quoteSecret();

  // Refuse before buying a quote, not after. Every one of these is a condition
  // the contract would reject anyway — but it would reject it AFTER a real
  // deposit address was issued and the clock started.
  const pre = await quote();
  if (pre.inAmt > pre.perTx) throw new Error("quote exceeds the per-tx cap");
  if (pre.inAmt > pre.available) throw new Error("quote exceeds today's remaining budget");
  if (pre.inAmt > pre.bal) throw new Error("vault does not hold enough to pay this");
  const bound = await view("get_virtual_agent_node", { public_key: s.agentPublic });
  if (bound === null || bound === undefined) throw new Error("agent key is not bound — run setup");
  const node = await getNode(NODE_ID);
  if (!(node.recipients ?? []).includes(PAYEE)) {
    throw new Error(`${PAYEE} is not on node ${NODE_ID}'s allowlist — run setup`);
  }

  // The real quote. From here a deposit address exists and is expiring.
  console.log("\n  buying a REAL quote...");
  const deadline = new Date(Date.now() + 10 * 60_000);
  const q = await getQuote({ amountOut: DELIVER, payee: PAYEE, refundTo: VAULT, deadline, dry: false });
  const amount = BigInt(q.amountIn);
  if (!q.depositAddress) throw new Error("a non-dry quote returned no deposit address");
  if (amount > pre.perTx) throw new Error(`real quote ${amount} moved above the cap ${pre.perTx}`);
  console.log(`  depositAddress : ${q.depositAddress}`);
  console.log(`  amountIn       : ${usdc(amount)}`);
  console.log(`  quote deadline : ${q.deadlineNs}`);

  const nonce = Number(await view("get_virtual_agent_nonce", { public_key: s.agentPublic }));
  const nowNs = BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp);
  const requestId = `base-${nonce}-${String(nowNs).slice(-8)}`;

  // The quote signer binds deposit address <-> payee.
  const qsig = toBase64(signBinding({
    vault: VAULT, requestId, token: TOKEN, amount,
    payee: PAYEE, depositAddress: q.depositAddress, deadlineNs: BigInt(q.deadlineNs),
  }, qsk));

  // The agent authorises the spend. Its own deadline is separate from the
  // quote's and must also be in the future at execution.
  const agentDeadlineNs = String(nowNs + 600_000_000_000n);
  const payload = {
    vault: VAULT, nonce, deadlineNs: agentDeadlineNs, requestId, token: TOKEN,
    amount, recipient: PAYEE, memo: "first mainnet cross-chain payment",
    route: { depositAddress: q.depositAddress, quoteDeadlineNs: String(q.deadlineNs), signature: qsig },
  };
  const asig = sign(agent, encodeAgent(payload));

  // FLAT, not wrapped in a `payload` object. request_payment_signed takes ten
  // positional parameters (lib.rs:991), and near-sdk deserializes JSON args by
  // PARAMETER NAME — so a nested `payload` yields
  // `missing field \`request_id\``, which reads like the field is absent when it
  // is merely one level too deep. scripts/intents-dryrun.mjs has had the
  // correct shape since it was written; this was copied from nothing.
  //
  // `vault` is NOT an argument. The contract fills it from
  // env::current_account_id() when it rebuilds the binding, which is what makes
  // a signature non-replayable against another vault.
  //
  // Two numeric encodings, and they differ: `nonce: u64` serializes as a JSON
  // NUMBER, while `deadline_ns: U64` and `amount: U128` are near-sdk wrappers
  // that serialize as STRINGS. Sending a string nonce is another
  // missing/invalid-field error.
  const args = {
    request_id: requestId,
    token: TOKEN,
    amount: String(amount),
    recipient: PAYEE,
    memo: payload.memo,
    route: {
      // `intents` lowercase: Route carries #[serde(rename_all = "snake_case")].
      // The borsh tag is positional (1) and unaffected — two encodings of one
      // enum, and only the JSON one is spelled this way.
      intents: {
        deposit_address: q.depositAddress,
        quote_deadline_ns: String(q.deadlineNs),
        signature: qsig,
      },
    },
    public_key: s.agentPublic,
    nonce,
    deadline_ns: agentDeadlineNs,
    signature: asig,
  };

  console.log("\n  submitting request_payment_signed...");
  const acct = ownerAccount(); // a RELAYER here: it pays gas, it does not authorise
  const out = await acct.callFunction({
    contractId: VAULT, methodName: "request_payment_signed",
    args, gas: 100n * TGAS, deposit: 0n,
  });
  console.log("  outcome:", JSON.stringify(out));

  s.lastRequestId = requestId;
  s.lastDepositAddress = q.depositAddress;
  s.lastAmountIn = String(amount);
  save(s);
  console.log(`\n  request_id saved: ${requestId}`);
  console.log("  run `verify` in ~30s — the solver fills on Base asynchronously");
}

async function verify() {
  const s = load();
  const bal = BigInt(await ftView("ft_balance_of", { account_id: VAULT }));
  console.log(`  vault balance : ${usdc(bal)}`);
  if (s.lastRequestId) {
    const r = await view("get_request", { request_id: s.lastRequestId });
    console.log(`  request ${s.lastRequestId}:`);
    console.log(`    status      : ${r?.status}`);
    console.log(`    reason_code : ${r?.reason_code}`);
    console.log(`    amount      : ${r ? usdc(r.amount) : "-"}`);
    console.log(`    recipient   : ${r?.recipient}`);
    console.log("\n  SETTLED means the NEP-141 transfer to the deposit address landed.");
    console.log("  It does NOT mean the solver delivered on Base — that is off-chain.");
    console.log(`  Check the payee: https://basescan.org/address/${PAYEE}`);
  }
  const lim = await view("get_node_budget", { node_id: NODE_ID, token: TOKEN });
  console.log(`\n  node ${NODE_ID} today: executed ${usdc(lim.executed)} pending ${usdc(lim.pending)} available ${usdc(lim.available)}`);
}

const steps = { keygen, check, setup, quote, pay, verify };
const step = process.argv[2];
if (!steps[step]) {
  console.error(`usage: node --experimental-strip-types scripts/intents-pay.mjs <${Object.keys(steps).join("|")}>`);
  process.exit(2);
}
console.log(`network ${NETWORK}  vault ${VAULT}  node ${NODE_ID}`);
console.log(`payee   ${PAYEE}${PAYEE !== PAYEE_IN ? `  (lowercased from ${PAYEE_IN})` : ""}\n`);
await steps[step]();

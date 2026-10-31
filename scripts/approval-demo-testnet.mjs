#!/usr/bin/env node
/**
 * Drives the approval gate against a REAL chain (testnet).
 *
 * WHY THIS EXISTS. The approval gate has 18 unit tests and a mutation pass,
 * but the unit tier runs in near-sdk's test VM: no promises resolve, no
 * callback fires, no ft_transfer happens. The integration tier that WOULD
 * exercise it on a node is the sandbox, which needs a Linux `neard` and does
 * not build on Windows at all. So before this script the gate had never
 * executed on a chain.
 *
 * Deploying a contract to mainnet whose new code path has only ever run in a
 * test VM is exactly the kind of confidence that has been wrong twice this
 * week, so this closes that gap on testnet first.
 *
 * near-api-js rather than near-cli on purpose: every JSON argument here would
 * otherwise cross a shell boundary, and this repo has lost five probes to
 * quote-stripping and backslash collapse.
 *
 * Idempotent. Each step checks whether it is already done, so a failed run is
 * resumed rather than restarted — the same rule create-float follows.
 *
 * Usage:
 *   node scripts/approval-demo-testnet.mjs
 *   VAULT=approve.floatv4.testnet OWNER=floatv4.testnet node scripts/...
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const OWNER = process.env.OWNER ?? "floatv4.testnet";
const VAULT = process.env.VAULT ?? "approve.floatv4.testnet";
const AGENT = process.env.AGENT ?? "solver.floatv4.testnet";
const TOKEN = process.env.TOKEN ?? "ft.floatv4.testnet";
const WASM = process.env.WASM ?? "packages/create-float/res/vault.wasm";

const C = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const skip = (m) => console.log(`    ${C.d("skip")} ${C.d(m)}`);
const bad = (m) => console.log(`    ${C.r("FAIL")} ${m}`);
const info = (m) => console.log(`    ${C.d(m)}`);

const provider = new JsonRpcProvider({ url: RPC });
const credPath = (a) => join(homedir(), ".near-credentials", "testnet", `${a}.json`);
function signer(account) {
  const p = credPath(account);
  if (!existsSync(p)) throw new Error(`no testnet key for ${account} at ${p}`);
  const k = JSON.parse(readFileSync(p, "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
}
const acct = (id) => new Account(id, provider, signer(id));

const GAS = 100n * 10n ** 12n;
const YOCTO = 1n;
const usdc = (n) => String(BigInt(Math.round(n * 1e6)));

async function view(id, method, args = {}) {
  // v7 takes an OBJECT, not positional args.
  //
  // OPTIMISTIC finality, deliberately. The default is `final`, which lags the
  // chain head by a few blocks — so a read issued immediately after a write
  // sees the state BEFORE it. That raced here: `add_node` reported ok and the
  // very next get_tree did not contain the node, which reads as a contract bug
  // and is really a script reading the past.
  return await provider.callFunction({
    contractId: id,
    method,
    args,
    blockQuery: { finality: "optimistic" },
  });
}
async function viewSafe(id, method, args = {}) {
  try {
    return await view(id, method, args);
  } catch {
    return null;
  }
}

/**
 * Poll until a condition holds, because a view right after a write can still
 * miss it.
 *
 * Optimistic finality was not enough on its own: `callFunction` resolves when
 * the transaction is executed, but a VIEW runs against a block whose state may
 * not yet include the receipt. "ticket gone after reject" failed exactly that
 * way -- the reject had succeeded and the read was a block early.
 */
async function until(fn, tries = 8, waitMs = 400) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}

/** Run a payment and return the decoded outcome, whichever rail it took. */
async function pay(from, { requestId, amount, recipient }) {
  const r = await acct(from).callFunction({
    contractId: VAULT,
    methodName: "request_payment",
    args: { request_id: requestId, token: TOKEN, amount, recipient, memo: "approval-demo", route: null },
    gas: GAS,
    deposit: 0n,
  });
  // A BLOCKED outcome is a RETURN VALUE, not an error — that is the contract's
  // design and the reason an agent can branch on it.
  //
  // `callFunction` returns getTransactionLastResult(outcome), i.e. the value
  // already decoded. A NAME COLLISION cost four false failures here: I read
  // `r.status.SuccessValue` as the TRANSACTION status, but `r` is the
  // PaymentOutcome and its own `status` field is the string "BLOCKED". So the
  // lookup was undefined and every BLOCKED outcome read as a dispatch — while
  // the ticket checks beside it passed, which is what gave the lie away.
  //
  // A DISPATCH does not decode to null either: the promise chain resolves and
  // getTransactionLastResult gives the CALLBACK's outcome, so a successful
  // payment comes back SETTLED. "Dispatched" therefore means "not BLOCKED",
  // and the strongest form of it is status === SETTLED, which only holds once
  // the ft_transfer callback has actually fired.
  return r ?? null;
}

// --------------------------------------------------------------------------
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  (pass ? ok : bad)(`${name}${detail ? ` ${C.d(detail)}` : ""}`);
};

step(0, "Preflight");
if (!existsSync(WASM)) throw new Error(`no contract at ${WASM}`);
const code = readFileSync(WASM);
info(`contract ${(code.length / 1024).toFixed(0)} KB`);
const ownerState = await provider.viewAccount({ accountId: OWNER });
info(`${OWNER} holds ${(Number(ownerState.amount) / 1e24).toFixed(3)} NEAR`);

step(1, "Vault account");
let vaultExists = true;
try {
  await provider.viewAccount({ accountId: VAULT });
} catch {
  vaultExists = false;
}
if (vaultExists) {
  skip(`${VAULT} already exists`);
} else {
  const key = KeyPair.fromRandom("ed25519");
  await acct(OWNER).createSubAccount({
    accountOrPrefix: VAULT,
    publicKey: key.getPublicKey(),
    nearToTransfer: 3_300_000_000_000_000_000_000_000n,
  });
  mkdirSync(dirname(credPath(VAULT)), { recursive: true });
  writeFileSync(
    credPath(VAULT),
    JSON.stringify({ account_id: VAULT, public_key: key.getPublicKey().toString(), private_key: key.toString() }, null, 2),
  );
  ok(`${VAULT} created with 3.300 NEAR`);
}

step(2, "Deploy + initialise");
const cfg0 = await viewSafe(VAULT, "get_config");
if (cfg0) {
  skip(`already initialised, owner ${cfg0.owner}`);
} else {
  await acct(VAULT).deployContract(code);
  await acct(VAULT).callFunction({
    contractId: VAULT,
    methodName: "new",
    args: { owner: OWNER, network: "testnet", strict_allocation: false },
    gas: GAS,
    deposit: 0n,
  });
  ok("deployed and initialised");
}
// The gate must EXIST on what we just deployed, before anything else is tried.
// MethodNotFound is the decisive signal: a vault running older code simply
// does not have this method, and every check below would be meaningless.
const probe = await provider
  .callFunction({ contractId: VAULT, method: "get_approval_threshold", args: { node_id: 0 }, blockQuery: { finality: "optimistic" } })
  .then(() => true)
  .catch((e) => !/MethodNotFound/.test(String(e)));
check("the deployed contract HAS the approval gate", probe, "get_approval_threshold resolves");
if (!probe) {
  bad("the deployed wasm predates the approval gate — nothing below can pass");
  process.exit(1);
}

step(3, "Budget tree");
let tree = (await viewSafe(VAULT, "get_tree")) ?? [];
const byLabel = new Map(tree.map((n) => [n.label, n.id]));
const limits = [{ token: TOKEN, daily_cap: usdc(100), per_tx_cap: usdc(50) }];
if (!byLabel.has("root")) {
  await acct(OWNER).callFunction({
    contractId: VAULT,
    methodName: "add_node",
    args: { parent: null, label: "root", limits, cooldown_sec: 0, recipients: [OWNER] },
    gas: GAS,
    deposit: YOCTO,
  });
  ok(`root  daily 100 / per-tx 50, payee allowlist [${OWNER}]`);
} else skip("root exists");
tree = (await viewSafe(VAULT, "get_tree")) ?? [];
const rootId = tree.find((n) => n.label === "root").id;
if (!tree.some((n) => n.label === "leaf")) {
  await acct(OWNER).callFunction({
    contractId: VAULT,
    methodName: "add_node",
    args: { parent: rootId, label: "leaf", limits, cooldown_sec: 0, recipients: null },
    gas: GAS,
    deposit: YOCTO,
  });
  ok("leaf  daily 100 / per-tx 50, inherits the allowlist");
} else skip("leaf exists");
tree = await view(VAULT, "get_tree");
const leafId = tree.find((n) => n.label === "leaf").id;

// Caps are RE-SET on every run, deliberately.
//
// The daily ledger is real state and this script spends ~35 per run. With a
// daily cap of 100 the fourth run hit DAILY_BUDGET instead of the threshold,
// step 12 was never held, and the reject then panicked NO_SUCH_APPROVAL --
// which reads as a broken gate and was really a demo that exhausts its own
// budget. A high daily cap keeps the run repeatable; per-tx stays at 50 so
// step 10 still has a cap to exceed.
for (const id of [rootId, leafId]) {
  await acct(OWNER).callFunction({
    contractId: VAULT,
    methodName: "set_node_caps",
    args: { node_id: id, limits: [{ token: TOKEN, daily_cap: usdc(1_000_000), per_tx_cap: usdc(50) }] },
    gas: GAS,
    deposit: YOCTO,
  });
}
ok("caps reset: daily 1,000,000 / per-tx 50 on root and leaf");

step(4, "Bind the agent");
if (tree.find((n) => n.id === leafId).account === AGENT) {
  skip(`${AGENT} already bound to leaf`);
} else {
  await acct(OWNER).callFunction({
    contractId: VAULT,
    methodName: "bind_agent",
    args: { node_id: leafId, account_id: AGENT },
    gas: GAS,
    deposit: YOCTO,
  });
  ok(`${AGENT} bound to leaf (node ${leafId})`);
}

step(5, "Fund the vault");
const reg = await viewSafe(TOKEN, "storage_balance_of", { account_id: VAULT });
if (!reg) {
  await acct(OWNER).callFunction({
    contractId: TOKEN,
    methodName: "storage_deposit",
    args: { account_id: VAULT, registration_only: true },
    gas: GAS,
    deposit: 1_250_000_000_000_000_000_000n,
  });
  ok("vault registered on the token");
} else skip("vault already registered on the token");
let bal = BigInt((await viewSafe(TOKEN, "ft_balance_of", { account_id: VAULT })) ?? "0");
if (bal < BigInt(usdc(60))) {
  await acct(OWNER).callFunction({
    contractId: TOKEN,
    methodName: "mint",
    args: { account_id: VAULT, amount: usdc(100) },
    gas: GAS,
    deposit: 0n,
  });
  bal = BigInt(await view(TOKEN, "ft_balance_of", { account_id: VAULT }));
  ok(`minted — vault holds ${(Number(bal) / 1e6).toFixed(2)}`);
} else skip(`vault already holds ${(Number(bal) / 1e6).toFixed(2)}`);
// The payee must be registered too, or ft_transfer panics "not registered".
if (!(await viewSafe(TOKEN, "storage_balance_of", { account_id: OWNER }))) {
  await acct(OWNER).callFunction({
    contractId: TOKEN,
    methodName: "storage_deposit",
    args: { account_id: OWNER, registration_only: true },
    gas: GAS,
    deposit: 1_250_000_000_000_000_000_000n,
  });
  ok(`${OWNER} registered on the token (the payee)`);
}

step(5.5, "Agent gas");
// An agent account pays its OWN gas. create-float gives a real one 0.5 NEAR
// for this; solver.floatv4.testnet is a reused testnet account and ran dry
// mid-demo with "Not enough balance (balance 0.070, cost 0.101)". The cost is
// an UPFRONT reservation for attached gas, most of which is refunded -- but it
// must be available at send time.
const agentBal = BigInt((await provider.viewAccount({ accountId: AGENT })).amount);
if (agentBal < 250_000_000_000_000_000_000_000n) {
  await acct(OWNER).transfer({ receiverId: AGENT, amount: 250_000_000_000_000_000_000_000n });
  ok(`topped ${AGENT} up to pay its own gas`);
} else skip(`${AGENT} holds ${(Number(agentBal) / 1e24).toFixed(3)} NEAR`);

step(6, "BASELINE: no threshold, so the gate is inert");
// CLEAR it first. The threshold is chain state and survives the run that set
// it, so on a re-run this "baseline" inherited last time's threshold and the
// payment came back APPROVAL_REQUIRED -- a step asserting the gate is inert,
// failing because the gate was still armed from before.
//
// Third time this script assumed a fresh chain: the budget ledger and the
// threshold both persist. Every step has to establish its own precondition.
// Passing null is also the documented way to remove a threshold, so this
// exercises that path too.
await acct(OWNER).callFunction({
  contractId: VAULT,
  methodName: "set_approval_threshold",
  args: { node_id: leafId, amount: null },
  gas: GAS,
  deposit: YOCTO,
});
check("removing the threshold leaves none in the chain", (await view(VAULT, "get_effective_threshold", { node_id: leafId })) === null);
const nonce = Date.now();
const r0 = await pay(AGENT, { requestId: `d-base-${nonce}`, amount: usdc(10), recipient: OWNER });
check("a payment with no threshold SETTLES", r0?.status === "SETTLED", `status ${r0?.status}, reason ${r0?.reason_code}`);

step(7, "Set the approval threshold");
await acct(OWNER).callFunction({
  contractId: VAULT,
  methodName: "set_approval_threshold",
  args: { node_id: leafId, amount: usdc(5) },
  gas: GAS,
  deposit: YOCTO,
});
const thr = await view(VAULT, "get_effective_threshold", { node_id: leafId });
check("threshold reads back", thr === usdc(5), `${Number(thr) / 1e6} on node ${leafId}`);

step(8, "UNDER the threshold still runs unattended");
const r1 = await pay(AGENT, { requestId: `d-under-${nonce}`, amount: usdc(5), recipient: OWNER });
check("5 (== threshold) SETTLES, so the boundary is > not >=", r1?.status === "SETTLED", `status ${r1?.status}`);

step(9, "OVER the threshold is HELD");
const before = await view(VAULT, "get_node_budget", { node_id: leafId, token: TOKEN, day: null });
const r2 = await pay(AGENT, { requestId: `d-held-${nonce}`, amount: usdc(20), recipient: OWNER });
check("20 is blocked with APPROVAL_REQUIRED", r2?.reason_code === "APPROVAL_REQUIRED", JSON.stringify(r2?.reason_code));
const after = await view(VAULT, "get_node_budget", { node_id: leafId, token: TOKEN, day: null });
check("nothing was charged while held", before.available === after.available, `available ${Number(after.available) / 1e6}`);
const ticket = await viewSafe(VAULT, "get_pending_approval", { request_id: `d-held-${nonce}` });
check("the owner can see the ticket", ticket?.amount === usdc(20), `amount ${Number(ticket?.amount ?? 0) / 1e6}, payee ${ticket?.recipient}`);
check("it is NOT in the request ledger yet", (await viewSafe(VAULT, "get_request", { request_id: `d-held-${nonce}` })) === null);

step(10, "OVER THE CAP is still refused by the CAP, not the gate");
const r3 = await pay(AGENT, { requestId: `d-cap-${nonce}`, amount: usdc(500), recipient: OWNER });
check("500 reports a cap, not APPROVAL_REQUIRED", r3?.reason_code === "PerTxLimit" || /PER_TX/.test(String(r3?.reason_code)), String(r3?.reason_code));
check("and no ticket was created for it", (await viewSafe(VAULT, "get_pending_approval", { request_id: `d-cap-${nonce}` })) === null);

step(11, "APPROVE the held payment");
const payeeBefore = BigInt(await view(TOKEN, "ft_balance_of", { account_id: OWNER }));
await acct(OWNER).callFunction({
  contractId: VAULT,
  methodName: "approve_payment",
  args: { request_id: `d-held-${nonce}` },
  // 100 TGas, not 300: the reservation is upfront and the owner is thin.
  // request_payment dispatches the same promise chain on 100 and succeeds.
  gas: GAS,
  deposit: YOCTO,
});
await until(async () => (await viewSafe(VAULT, "get_request", { request_id: `d-held-${nonce}` })) !== null);
const req = await viewSafe(VAULT, "get_request", { request_id: `d-held-${nonce}` });
check("the request is now in the ledger", req !== null, `status ${req?.status}, reason ${req?.reason_code}`);
check("the ticket is consumed", await until(async () => (await viewSafe(VAULT, "get_pending_approval", { request_id: `d-held-${nonce}` })) === null));
const payeeAfter = BigInt(await view(TOKEN, "ft_balance_of", { account_id: OWNER }));
check("the payee was actually paid 20", payeeAfter - payeeBefore === BigInt(usdc(20)), `+${Number(payeeAfter - payeeBefore) / 1e6}`);

step(12, "REJECT a held payment");
const r4 = await pay(AGENT, { requestId: `d-rej-${nonce}`, amount: usdc(30), recipient: OWNER });
check("held again", r4?.reason_code === "APPROVAL_REQUIRED");
const balBefore = BigInt(await view(TOKEN, "ft_balance_of", { account_id: OWNER }));
await acct(OWNER).callFunction({
  contractId: VAULT,
  methodName: "reject_payment",
  args: { request_id: `d-rej-${nonce}` },
  gas: GAS,
  deposit: YOCTO,
});
check("ticket gone after reject", await until(async () => (await viewSafe(VAULT, "get_pending_approval", { request_id: `d-rej-${nonce}` })) === null));
check("no ledger entry for a rejected payment", (await viewSafe(VAULT, "get_request", { request_id: `d-rej-${nonce}` })) === null);
check("payee balance unchanged", BigInt(await view(TOKEN, "ft_balance_of", { account_id: OWNER })) === balBefore);

step(13, "An AGENT cannot approve its own payment");
const r5 = await pay(AGENT, { requestId: `d-self-${nonce}`, amount: usdc(25), recipient: OWNER });
check("held", r5?.reason_code === "APPROVAL_REQUIRED");
let refused = false;
try {
  await acct(AGENT).callFunction({
    contractId: VAULT,
    methodName: "approve_payment",
    args: { request_id: `d-self-${nonce}` },
    gas: GAS,
    deposit: YOCTO,
  });
} catch (e) {
  refused = /NOT_OWNER|NotEnoughAllowance|not permitted|MethodNameMismatch|method/i.test(String(e));
}
check("the agent's approval is refused", refused, "its key is restricted to request_payment");
// Tidy up so a re-run starts clean.
await acct(OWNER).callFunction({
  contractId: VAULT,
  methodName: "reject_payment",
  args: { request_id: `d-self-${nonce}` },
  gas: GAS,
  deposit: YOCTO,
});

console.log(`\n${C.b("Result")}`);
const failed = results.filter((r) => !r.pass);
console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  ${C.r("FAILED")} ${f.name}`);
console.log(`  vault ${VAULT}  https://testnet.nearblocks.io/address/${VAULT}`);
process.exit(failed.length ? 1 : 0);

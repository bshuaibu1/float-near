#!/usr/bin/env node
/**
 * Rebuild the testnet demo fixture: a vault with a tree, money, a bound agent
 * and real payment history.
 *
 * WHY THIS EXISTS. `scripts/teardown-vault.mjs` can now delete a vault
 * cleanly, which means the populated vault the dashboard is developed against
 * is disposable — and the first time one was torn down, nothing could render
 * the agents table or the activity feed any more. The rebuild was a dozen
 * hand-typed transactions with the deposit arithmetic done in my head. This is
 * that, written down.
 *
 * It is the INVERSE of teardown-vault.mjs and deliberately mirrors its
 * discipline: every figure is derived from the real artifact, nothing is
 * hardcoded that the chain can be asked, and it refuses rather than guesses.
 *
 * WHAT IT BUILDS, matching the shape the dashboard was designed against:
 *
 *   root (100 USDC/day, 2 USDC/tx, pays the owner)
 *   └── marketing (25/day, 5/tx)
 *   + one agent bound to root, holding a NEP-611 gas key
 *   + funded with USDC
 *   + a few settled payments and one BLOCKED one, so the activity table has
 *     both outcomes to render
 *
 * THE BLOCKED PAYMENT IS NOT A MISTAKE. A fixture where everything succeeded
 * cannot show what a refusal looks like, and the blocked path is the one with
 * a reason code, a coverage banner and its own rendering — the parts most
 * likely to be wrong and least likely to be noticed.
 *
 * Usage:
 *   NETWORK=testnet OWNER=you.testnet FACTORY=fac.floatv4.testnet \
 *   TOKEN=usdc.fakes.testnet node scripts/seed-fixture.mjs [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");

/**
 * Required, for the same reason teardown-vault.mjs requires them: a default
 * that is wrong does not fail, it acts on the wrong thing. There the cost was
 * a deleted vault; here it is a deposit sent somewhere unverified.
 */
const need = (name, hint) => {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    console.error(`\nFATAL: ${name} is required — this script will not guess it.`);
    console.error(`  ${hint}\n`);
    process.exit(2);
  }
  return v.trim();
};

const NETWORK = process.env.NETWORK ?? "testnet";
const OWNER = need("OWNER", "The account that will own the vault and pay the deposit.");
const FACTORY = need("FACTORY", "The vault factory, e.g. fac.floatv4.testnet");
const TOKEN = need("TOKEN", "The fungible token to fund it with, e.g. usdc.fakes.testnet");
const LABEL = process.env.LABEL ?? "fleet";
const RPC =
  process.env.RPC ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

if (NETWORK === "mainnet") {
  console.error("FATAL: this seeds a DEMO fixture and spends a real deposit. Testnet only.");
  process.exit(2);
}
if (!/^[a-z0-9]{1,16}$/.test(LABEL)) {
  console.error(`FATAL: LABEL "${LABEL}" must match the page's own rule, /^[a-z0-9]{1,16}$/.`);
  process.exit(2);
}

/**
 * THE ARTIFACT THE CREATE FLOW ACTUALLY SHIPS, and not one of the three other
 * vault wasms in this repo.
 *
 * `res/m21/vault_cargo_near.wasm` is 290,110 bytes and `target/near/...` is a
 * stale-able build output — picking either would deploy different code than
 * every real vault runs, and the deposit derived from its length would be
 * wrong too. The signing page fetches this exact path (web/serve.mjs maps
 * /vault.wasm to it), so this is the one users get.
 */
const WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
if (!existsSync(WASM)) {
  console.error(`FATAL: ${WASM} missing — run scripts/build-wasm.sh`);
  process.exit(1);
}
const wasm = readFileSync(WASM);

const USDC = 1_000_000n; // 6dp, matching the token this fixture uses
const p = new JsonRpcProvider({ url: RPC });
const near = (y) => (Number(y) / 1e24).toFixed(6);
const units = (n) => BigInt(Math.round(n * 1e6));
const human = (b) => (Number(b) / 1e6).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (c, m, a = {}) =>
  p.callFunction({ contractId: c, method: m, args: a, blockQuery: { finality: "final" } });

const credPath = (a) => join(homedir(), ".near-credentials", NETWORK, `${a}.json`);
if (!existsSync(credPath(OWNER))) {
  console.error(`\nFATAL: no credential for ${OWNER} at ${credPath(OWNER)}`);
  process.exit(1);
}
const ownerKp = KeyPair.fromString(
  (() => {
    const k = JSON.parse(readFileSync(credPath(OWNER), "utf8"));
    return k.private_key ?? k.secret_key;
  })(),
);

/** `alice.testnet` -> `alice-testnet`, the factory's own derivation. Dots
 *  become hyphens so alice.near and alice.testnet cannot collapse onto one
 *  vault id. */
const prefix = OWNER.replace(/\./g, "-");
const VAULT = `${prefix}-${LABEL}.${FACTORY}`;

/**
 * The deposit, derived from the artifact exactly as the signing page does it.
 * Hardcoding either figure is how this repo's two stale numbers shipped.
 */
const stake = BigInt(wasm.length) * 10n ** 19n;
const AGENT_GAS = 12n * 10n ** 22n; // AGENT_GAS_KEY_FUNDING in the factory
const deposit = stake + 36n * 10n ** 22n + AGENT_GAS;

/**
 * A FRESH agent keypair, generated here and never reused.
 *
 * The secret is written to a file and NEVER printed — not to stdout, not into
 * an error message. A key echoed into a terminal is in that terminal's
 * scrollback and in the transcript of whatever was driving it, which is the
 * mistake that put a plaintext key in this repo's .mcp.json.
 */
const agentKp = KeyPair.fromRandom("ed25519");
const agentPk = agentKp.getPublicKey().toString();

console.log(`\n  network   ${NETWORK}`);
console.log(`  owner     ${OWNER}`);
console.log(`  factory   ${FACTORY}`);
console.log(`  vault     ${VAULT}`);
console.log(`  token     ${TOKEN}`);
console.log(`  code      ${wasm.length} B from packages/create-float/res/vault.wasm`);
console.log(`  deposit   ${near(deposit)} NEAR  (stake ${near(stake)} + 0.36 + 0.12 agent gas)`);
console.log(`  agent pk  ${agentPk}`);

const ownerAcct = await p.viewAccount({ accountId: OWNER, blockQuery: { finality: "final" } });
const ownerBal = BigInt(ownerAcct.amount);
const ownerTokens = BigInt(await view(TOKEN, "ft_balance_of", { account_id: OWNER }).catch(() => "0"));
console.log(`  owner has ${near(ownerBal)} NEAR, ${human(ownerTokens)} tokens\n`);

/**
 * 200 TGas is RESERVED at prepaid_gas * 1e9 and must be held on top of the
 * deposit at signing time. Checking it here turns a confusing mid-run
 * "does not have enough balance" into a refusal that says what is short.
 */
const RESERVE = 200n * 10n ** 12n * 10n ** 9n;
if (ownerBal < deposit + RESERVE) {
  console.error(
    `FATAL: ${OWNER} holds ${near(ownerBal)} but needs ${near(deposit + RESERVE)} ` +
      `(${near(deposit)} deposit + ${near(RESERVE)} gas reservation).`,
  );
  process.exit(1);
}

const already = await p
  .viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } })
  .then(() => true)
  .catch(() => false);
if (already) {
  console.error(`FATAL: ${VAULT} already exists. Tear it down first, or pass a different LABEL.`);
  process.exit(1);
}

if (DRY) {
  console.log("  --dry-run: nothing signed.\n");
  process.exit(0);
}

const owner = new Account(OWNER, p, new KeyPairSigner(ownerKp));

// ---- 1. one FunctionCall creates the account, deploys, inits and binds -----
console.log(`  [1] create_vault_with_code (${(wasm.length / 1024).toFixed(0)} KB argument)…`);
await owner.callFunction({
  contractId: FACTORY,
  methodName: "create_vault_with_code",
  args: {
    code: wasm.toString("base64"),
    label: LABEL,
    root_limits: [
      { token: TOKEN, daily_cap: (100n * USDC).toString(), per_tx_cap: (2n * USDC).toString() },
    ],
    // The owner, so the vault can pay SOMEONE the moment it exists. A root
    // with no recipients fails every payment with NO_RECIPIENTS_SET.
    root_recipients: [OWNER],
    agent_pk: agentPk,
  },
  gas: 200n * 10n ** 12n,
  deposit,
});
for (let i = 0; i < 30; i++) {
  if (await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } }).catch(() => null)) break;
  await sleep(1000);
}
console.log(`      ${VAULT} is live`);

// ---- 2. register the vault on the token ------------------------------------
// NEP-141 ft_transfer to an UNREGISTERED receiver PANICS. Skipping this makes
// step 3 fail with a message about storage, not about registration.
const reg = await view(TOKEN, "storage_balance_of", { account_id: VAULT }).catch(() => null);
if (reg?.total && BigInt(reg.total) > 0n) {
  console.log(`  [2] already registered on ${TOKEN}`);
} else {
  const bounds = await view(TOKEN, "storage_balance_bounds");
  console.log(`  [2] storage_deposit ${near(BigInt(bounds.min))} to register the vault…`);
  await owner.callFunction({
    contractId: TOKEN,
    methodName: "storage_deposit",
    args: { account_id: VAULT, registration_only: true },
    gas: 30n * 10n ** 12n,
    deposit: BigInt(bounds.min),
  });
}

// ---- 3. fund it ------------------------------------------------------------
const FUND = 46n * USDC + 500_000n; // 46.5, the figure the old fixture held
if (ownerTokens < FUND) {
  console.error(
    `FATAL: ${OWNER} holds ${human(ownerTokens)} tokens, needs ${human(FUND)}. ` +
      `Mint more before re-running; the vault exists and is reusable.`,
  );
  process.exit(1);
}
console.log(`  [3] ft_transfer ${human(FUND)} to the vault…`);
await owner.callFunction({
  contractId: TOKEN,
  methodName: "ft_transfer",
  args: { receiver_id: VAULT, amount: FUND.toString(), memo: "seed the demo fixture" },
  gas: 30n * 10n ** 12n,
  deposit: 1n,
});

// ---- 4. the child node -----------------------------------------------------
console.log(`  [4] add_node "marketing" (25/day, 5/tx)…`);
await owner.callFunction({
  contractId: VAULT,
  methodName: "add_node",
  args: {
    parent: 0,
    label: "marketing",
    limits: [
      { token: TOKEN, daily_cap: (25n * USDC).toString(), per_tx_cap: (5n * USDC).toString() },
    ],
    cooldown_sec: 0,
    recipients: null,
  },
  gas: 30n * 10n ** 12n,
  deposit: 1n,
});

// ---- 5. history, signed BY THE AGENT'S GAS KEY -----------------------------
/**
 * Self-submit: the agent's key is ON the vault, so it signs as the VAULT and
 * `predecessor_account_id()` is the vault itself. The contract then identifies
 * which agent called by `signer_account_pk()`. Paying from the owner instead
 * would produce history attributed to the wrong node and would not exercise
 * the gas key at all.
 */
const agent = new Account(VAULT, p, new KeyPairSigner(agentKp));
const PAYMENTS = [
  { id: `seed-${LABEL}-1`, amount: 1n * USDC + 500_000n, memo: "copywriting" },
  { id: `seed-${LABEL}-2`, amount: 750_000n, memo: "stock photo" },
  { id: `seed-${LABEL}-3`, amount: 2n * USDC, memo: "landing page draft" },
  // DELIBERATELY OVER the root's 2 USDC per-tx cap, so the activity table has
  // a blocked row with a real reason code to render. This is expected to be
  // recorded as blocked, NOT to throw.
  { id: `seed-${LABEL}-blocked`, amount: 5n * USDC, memo: "over the per-tx cap", expectBlocked: true },
];
for (const pay of PAYMENTS) {
  const tag = pay.expectBlocked ? " (expected to be BLOCKED)" : "";
  console.log(`  [5] request_payment ${human(pay.amount)} — ${pay.memo}${tag}`);
  try {
    const out = await agent.callFunctionRaw({
      contractId: VAULT,
      methodName: "request_payment",
      args: {
        request_id: pay.id,
        token: TOKEN,
        amount: pay.amount.toString(),
        recipient: OWNER,
        memo: pay.memo,
        route: null,
      },
      gas: 100n * 10n ** 12n,
      deposit: 0n,
    });
    const failed = typeof out?.status === "object" && out.status !== null && "Failure" in out.status;
    console.log(`      ${failed ? "FAILED" : "submitted"}  ${out?.transaction?.hash ?? ""}`);
  } catch (e) {
    console.log(`      threw: ${String(e.message).slice(0, 120)}`);
  }
  await sleep(1500);
}

// ---- 6. what actually exists now -------------------------------------------
await sleep(2000);
const vaultAcct = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
const vaultTokens = await view(TOKEN, "ft_balance_of", { account_id: VAULT }).catch(() => "?");
const tree = await view(VAULT, "get_tree").catch(() => []);
const reqs = await view(VAULT, "list_requests", { from_index: 0, limit: 20 }).catch(() => []);
const vkeys = (await p.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } })).keys;
const gasKeys = vkeys.filter((k) => k.access_key.permission?.GasKeyFunctionCall);

console.log(`\n  ${VAULT}`);
console.log(`    NEAR      ${near(BigInt(vaultAcct.amount))}`);
console.log(`    tokens    ${human(BigInt(vaultTokens))}`);
console.log(`    storage   ${vaultAcct.storage_usage} B`);
console.log(`    nodes     ${tree.length}  (${tree.map((n) => n.label).join(", ")})`);
console.log(`    gas keys  ${gasKeys.length}`);
console.log(`    requests  ${reqs.length}  (stored in contract state)`);
for (const r of reqs) {
  console.log(`      ${String(r.request_id).padEnd(22)} ${human(BigInt(r.amount))}  ${r.status ?? r.outcome ?? "?"}`);
}

/**
 * A BLOCKED PAYMENT IS NOT IN `list_requests`, AND THAT IS NOT A FAILURE.
 *
 * The contract records a refusal as a `request_blocked` EVENT_JSON log and
 * returns `{"status":"BLOCKED","reason_code":...}` — it does not persist a
 * row, because storing every rejection would grow state an attacker controls.
 * So the count above is one SHORT of the payments submitted, which reads like
 * a half-finished seed unless it is said out loud.
 *
 * Recovering blocked history from transaction receipts is exactly what
 * packages/float-adapter/src/blocked-scan.ts is for, and why the activity
 * page carries a scan-coverage banner at all.
 *
 * Verified on this fixture: the over-cap payment returned
 * `{"request_id":"seed-fleet-blocked","node_id":0,"status":"BLOCKED",
 *   "reason_code":"PER_TX_LIMIT"}` with a matching event log.
 */
const expectedBlocked = PAYMENTS.filter((x) => x.expectBlocked).length;
if (expectedBlocked > 0) {
  console.log(
    `\n    ${expectedBlocked} payment(s) were deliberately blocked and are NOT stored as\n` +
      `    requests — they exist only as request_blocked EVENT_JSON logs. Run the\n` +
      `    blocked scanner to surface them on the activity page.`,
  );
}

/**
 * The scanner's store is keyed by VAULT ID, and this script can recreate a
 * vault at an id that has existed before. A store left from the previous
 * occupant claims a scanned window that belongs to a different account, so
 * the scanner resumes from a height before this vault existed and reports
 * coverage it does not have. Removing it is cheaper than teaching the scanner
 * about account rebirth.
 */
const staleLog = join(ROOT, ".demo", `blocked-log.${VAULT}.json`);
if (existsSync(staleLog)) {
  const { unlinkSync } = await import("node:fs");
  unlinkSync(staleLog);
  console.log(`\n    removed .demo/blocked-log.${VAULT}.json — it described the`);
  console.log(`    PREVIOUS vault at this id and would misreport scan coverage.`);
}

/**
 * The agent credential, written rather than printed.
 *
 * Filed under the vault id because that is what every consumer looks it up
 * by, and because an agent key is only meaningful against the vault it is
 * bound to. `.float/` is gitignored.
 */
const outDir = join(ROOT, ".float");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `fixture-${VAULT}.json`);
writeFileSync(
  outFile,
  `${JSON.stringify({ vault: VAULT, owner: OWNER, token: TOKEN, network: NETWORK, agent_public_key: agentPk, agent_private_key: agentKp.toString() }, null, 2)}\n`,
);
console.log(`\n  agent credential written to .float/fixture-${VAULT}.json`);
console.log(`  (NOT printed here on purpose — read the file if a tool needs it)`);
console.log(`\n  SEEDED.\n`);

#!/usr/bin/env node
/**
 * Recycle approve.floatv4.testnet into spendable testnet balance.
 *
 * WHY. The browser flow needs a deployed factory (~1.58) and a test vault
 * (~3.37) = ~4.95. The pool holds ~4.11 across floatv4 and work12, and the
 * faucet has been unreliable. approve.floatv4.testnet is sitting on ~3.27,
 * almost all of it locked behind a 299 KB vault contract we no longer need.
 *
 * WHY NOT JUST DEPLOY THE FACTORY OVER IT. That frees only the storage
 * DIFFERENCE (1.46), and then does not work at all: near-sdk's `#[init]` panics
 * when state already exists, and the vault's state is still in the trie, so the
 * factory's `new` would be permanently unreachable on that account.
 *
 * And `#[init(ignore_state)]` is NOT the fix. It would let `new` run against
 * existing state — which on a factory means anyone could re-initialise it and
 * take ownership. A deployment convenience is not worth an ownership hole.
 *
 * So the account goes, not just its code. NEAR refuses to delete an account
 * carrying a large contract ("cannot be deleted because it has a large state"),
 * so: shrink to the 33-byte stub first, then delete. Deleting returns the WHOLE
 * balance — ~3.27 rather than the 1.46 overwriting would have freed.
 *
 * WHAT IT COSTS: the testnet vault. Superseded — mainnet is validated 7/7 on
 * the same artifact, float-agent was proven against it end to end, and
 * create-float rebuilds one in a single command.
 *
 * IRREVERSIBLE. Testnet only, by suffix.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const A = process.env.ACCOUNT ?? "approve.floatv4.testnet";
const PARENT = process.env.PARENT ?? "floatv4.testnet";
const STUB = join(ROOT, ".demo", "stub-new.wasm");

for (const [label, id] of [["ACCOUNT", A], ["PARENT", PARENT]]) {
  if (!id.endsWith(".testnet")) {
    console.error(`FATAL: ${label}=${id} is not testnet. This DELETES an account.`);
    process.exit(2);
  }
}
if (!existsSync(STUB)) {
  console.error(`FATAL: ${STUB} missing — run: node scripts/make-stub-wasm.mjs`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
const near = (y) => (Number(y) / 1e24).toFixed(5);
const signer = (a) => {
  const f = join(homedir(), ".near-credentials", "testnet", `${a}.json`);
  if (!existsSync(f)) {
    console.error(`FATAL: no credential for ${a}`);
    process.exit(1);
  }
  const k = JSON.parse(readFileSync(f, "utf8"));
  return new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key));
};
const free = async (id) => {
  const a = await p.viewAccount({ accountId: id, blockQuery: { finality: "final" } });
  return BigInt(a.amount) - BigInt(a.storage_usage) * 10n ** 19n;
};

const before = await p.viewAccount({ accountId: A, blockQuery: { finality: "final" } });
console.log(`${A}: ${near(BigInt(before.amount))} total, ${before.storage_usage} B stored`);
console.log(`${PARENT}: ${near(await free(PARENT))} free\n`);

const acct = new Account(A, p, signer(A));

console.log("  shrinking to the 33-byte stub so NEAR will permit the delete…");
await acct.deployContract(new Uint8Array(readFileSync(STUB)));
await new Promise((r) => setTimeout(r, 3000));
const mid = await p.viewAccount({ accountId: A, blockQuery: { finality: "final" } });
console.log(`  storage ${before.storage_usage} -> ${mid.storage_usage} B`);

console.log(`  deleting ${A}, balance to ${PARENT}…`);
await acct.deleteAccount(PARENT);

// POLL TO AN EXPECTED VALUE. A read taken straight after a delete is a whole
// transaction behind — this project has paid for that eleven times, including
// once in this very pattern, where it reported 0.97 against a real 4.12.
const target = (await free(PARENT)) + BigInt(before.amount) - 2n * 10n ** 22n;
let f = 0n;
let settled = false;
for (let i = 0; i < 30; i++) {
  f = await free(PARENT);
  if (f >= target) {
    settled = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(`\n  ${PARENT} free ${near(f)}${settled ? "" : "   (never reached the expected value — read again)"}`);
console.log(`\n  Factory needs ~1.58, a test vault ~3.37.`);

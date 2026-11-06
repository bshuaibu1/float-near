#!/usr/bin/env node
/**
 * Move FREE testnet balance between accounts you hold keys for.
 *
 * WHY THIS EXISTS. Three spikes in a row have been blocked or distorted by the
 * same thing: this testnet pool holds ~2.7 NEAR spread across six accounts, and
 * almost all of it is LOCKED as storage stake behind contracts. The vault
 * accounts look rich and are not — `approve.floatv4.testnet` shows 3.298 NEAR
 * of which 3.085 is locked, so 0.212 is movable. The first run of
 * spike-self-fc-key.mjs died with LackBalanceForState trying to fund a
 * sub-account from it, and the first two runs of
 * spike-allowance-concurrency.mjs measured an account sitting 0.0014 NEAR from
 * its own threshold and drew the wrong conclusion twice.
 *
 * So: a named tool that computes FREE balance correctly, refuses to dip into
 * the storage stake, and says what it is doing.
 *
 * SAFETY
 *   - testnet only, by account suffix. Refuses anything ending `.near`.
 *   - never sends more than (free - keepBack), so an account cannot be pushed
 *     under its own storage requirement.
 *   - a deny-list for accounts that must not be drained. v4.floatv4.testnet is
 *     the virtual-agent proving ground and v3.floatvault-12329.testnet is the
 *     untouched working demo (see the project memory entry
 *     v4-floatv4-testnet-deployment.md); approve.floatv4.testnet is the 20/20
 *     approval-gate vault.
 *
 * Usage:
 *   node scripts/testnet-fund.mjs --to floatv4.testnet --from p1.floatv4.testnet=0.65 --from ft.floatv4.testnet=0.70
 *   node scripts/testnet-fund.mjs --to floatv4.testnet --from p1.floatv4.testnet=max
 *   node scripts/testnet-fund.mjs --report
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC });
const CRED = join(homedir(), ".near-credentials", "testnet");
const credPath = (a) => join(CRED, `${a}.json`);

/** Accounts whose balance is load-bearing for a demo or a proving ground. */
const PROTECTED = new Set([
  "v4.floatv4.testnet",
  "v3.floatvault-12329.testnet",
  "approve.floatv4.testnet",
]);

/** Leave this much free so an account cannot be pushed under its state cost. */
const KEEP_BACK = 20_000_000_000_000_000_000_000n; // 0.02 NEAR

const near = (y) => (Number(y) / 1e24).toFixed(5);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const one = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const many = (n) => argv.reduce((a, v, i) => (argv[i - 1] === n ? [...a, v] : a), []);

async function state(a) {
  const s = await provider.viewAccount({ accountId: a, blockQuery: { finality: "final" } });
  const balance = BigInt(s.amount);
  const locked = BigInt(s.storage_usage) * 10n ** 19n;
  return { balance, locked, free: balance - locked, bytes: s.storage_usage };
}

if (flag("--report") || argv.length === 0) {
  let total = 0n;
  console.log("     free |   locked |  balance | account");
  for (const f of readdirSync(CRED).filter((f) => f.endsWith(".json"))) {
    const a = f.replace(/\.json$/, "");
    try {
      const s = await state(a);
      total += s.free > 0n ? s.free : 0n;
      console.log(
        `${near(s.free).padStart(9)} | ${near(s.locked).padStart(8)} | ${near(s.balance).padStart(8)} | ${a}${PROTECTED.has(a) ? "  (protected)" : ""}`,
      );
    } catch {
      /* no such account */
    }
  }
  console.log(`${near(total).padStart(9)} | TOTAL FREE`);
  process.exit(0);
}

const to = one("--to");
if (!to) throw new Error("--to <account> is required");
if (/\.near$/.test(to)) throw new Error("testnet only — refusing a .near destination");

for (const spec of many("--from")) {
  const [from, amountSpec] = spec.split("=");
  if (/\.near$/.test(from)) throw new Error(`testnet only — refusing ${from}`);
  if (PROTECTED.has(from)) {
    console.log(`  REFUSED ${from} is protected (demo or proving ground) — skipping`);
    continue;
  }
  if (!existsSync(credPath(from))) {
    console.log(`  skip    ${from}: no key at ${credPath(from)}`);
    continue;
  }
  const s = await state(from);
  const spendable = s.free - KEEP_BACK;
  const want = amountSpec === "max" ? spendable : BigInt(Math.round(Number(amountSpec) * 1e6)) * 10n ** 18n;
  if (want <= 0n || want > spendable) {
    console.log(
      `  skip    ${from}: wanted ${amountSpec}, free ${near(s.free)}, spendable ${near(spendable)}`,
    );
    continue;
  }
  const k = JSON.parse(readFileSync(credPath(from), "utf8"));
  const acct = new Account(from, provider, new KeyPairSigner(KeyPair.fromString(k.private_key ?? k.secret_key)));
  await acct.transfer({ receiverId: to, amount: want });
  console.log(`  sent    ${near(want)} NEAR  ${from} -> ${to}`);
}

const after = await state(to);
console.log(`  ${to}: ${near(after.balance)} NEAR, ${near(after.free)} free`);

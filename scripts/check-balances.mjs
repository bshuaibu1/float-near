/**
 * Balances for the testnet accounts we hold credentials for.
 *
 * Read-only. Used to decide whether an end-to-end owner-method test is
 * possible locally: signing one requires a full-access key, and the live
 * vault's owner (work12.testnet) keeps its key in a browser wallet.
 */
const RPC = "https://test.rpc.fastnear.com";

const ACCOUNTS = [
  "work12.testnet",
  "work12-testnet-fleet.fac.floatv4.testnet",
  "floatv4.testnet",
  "fac.floatv4.testnet",
  "ft.floatv4.testnet",
];

async function view(account_id) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id },
    }),
  });
  const j = await res.json();
  if (j.error || j.result?.error) return null;
  return j.result;
}

const YOCTO = 10n ** 24n;
function near(y) {
  const v = BigInt(y);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 4);
  return `${whole}.${frac}`;
}

for (const a of ACCOUNTS) {
  const r = await view(a);
  if (!r) {
    console.log(`  ${a.padEnd(42)} DOES NOT EXIST`);
    continue;
  }
  console.log(
    `  ${a.padEnd(42)} ${near(r.amount).padStart(12)} NEAR   storage ${String(r.storage_usage).padStart(7)} B`,
  );
}

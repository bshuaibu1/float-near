#!/usr/bin/env node
/**
 * Read an account's free balance and one gas key's own balance, on either
 * network. Used by mainnet-gas-key-test.sh at every step so the claim that
 * matters — the GAS KEY pays, the ACCOUNT does not — is visible rather than
 * asserted.
 *
 *   node scripts/gas-key-state.mjs <account> <publicKey> [mainnet|testnet]
 *
 * Prints three lines of `key=value` so a shell can read them without parsing:
 *   free=<yocto>        the account's balance minus its storage stake
 *   gas=<yocto|none>    the gas key's own balance, or `none` if no such gas key
 *   keys=<n>            how many access keys the account carries
 *
 * `none` and `0` are deliberately DIFFERENT. A gas key that exists with a zero
 * balance and a gas key that does not exist at all are distinct states, and
 * collapsing them is how a cleanup step would silently skip a withdraw.
 */
import { JsonRpcProvider } from "near-api-js";

const [account, publicKey, network = "mainnet"] = process.argv.slice(2);
if (!account || !publicKey) {
  console.error("usage: node scripts/gas-key-state.mjs <account> <publicKey> [network]");
  process.exitCode = 2;
} else {
  const url =
    process.env.NEAR_VAULT_RPC_URL ??
    (network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");
  const p = new JsonRpcProvider({ url });
  const finality = { finality: "final" };

  const s = await p.viewAccount({ accountId: account, blockQuery: finality });
  const free = BigInt(s.amount) - BigInt(s.storage_usage) * 10n ** 19n;
  const list = await p.viewAccessKeyList({ accountId: account, blockQuery: finality });

  const entry = list.keys.find((k) => k.public_key === publicKey);
  // The balance sits at the TOP level of the permission variant, not nested
  // under `gas_key_info` as near-api-js's TypeScript shape suggests. Reading
  // the documented shape produced five false failures in the testnet spike.
  const perm = entry?.access_key?.permission;
  const v = typeof perm === "object" ? (perm.GasKeyFunctionCall ?? perm.GasKeyFullAccess) : null;
  const gas = v?.balance !== undefined ? BigInt(v.balance) : null;

  console.log(`free=${free}`);
  console.log(`gas=${gas === null ? "none" : gas}`);
  console.log(`keys=${list.keys.length}`);
}

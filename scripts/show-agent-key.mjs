#!/usr/bin/env node
/**
 * Show, FROM THE CHAIN, exactly what an agent's key is allowed to do.
 *
 * This is the demo's opening prop and the product's whole claim in six lines of
 * output. The claim is not "we check the agent's requests" — anyone can say
 * that. It is "the key physically cannot name another method or another
 * contract", and the only convincing form of that is NEAR's own access-key
 * record, read live, in front of the audience.
 *
 * Reads `.mcp.json` so it cannot disagree with the server being demoed — a
 * prop that takes its own hardcoded vault would keep printing a confident
 * answer about the wrong account.
 *
 *   node scripts/show-agent-key.mjs
 *   node scripts/show-agent-key.mjs --vault v.near --network mainnet
 */
import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";

const LF = String.fromCharCode(10);
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 || i === argv.length - 1 ? d : argv[i + 1];
};

let cfgEnv = {};
try {
  const cfg = JSON.parse(readFileSync(".mcp.json", "utf8"));
  cfgEnv = (cfg.mcpServers ?? cfg.servers ?? {})["float-near"]?.env ?? {};
} catch {
  // Explicit flags still work with no .mcp.json present.
}

const VAULT = opt("--vault", cfgEnv.NEAR_VAULT_CONTRACT);
const NETWORK = opt("--network", cfgEnv.NEAR_VAULT_NETWORK ?? "mainnet");
const RPC = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" }[
  NETWORK
];

if (!VAULT) {
  console.error("show-agent-key: no vault — pass --vault, or set NEAR_VAULT_CONTRACT in .mcp.json");
  process.exit(2);
}
if (!RPC) {
  console.error(`show-agent-key: unknown network "${NETWORK}"`);
  process.exit(2);
}

const near = (y) => (Number(y) / 1e24).toFixed(5);
const provider = new JsonRpcProvider({ url: RPC });

const keys = (await provider.viewAccessKeyList({ accountId: VAULT, blockQuery: { finality: "final" } }))
  .keys;

const gas = keys.filter((k) => k.access_key.permission?.GasKeyFunctionCall);
const full = keys.filter((k) => k.access_key.permission === "FullAccess");

console.log(`${LF}${VAULT}  (${NETWORK})${LF}`);

if (gas.length === 0) {
  console.log("  No agent key is bound, so this vault cannot pay.");
  console.log(
    `  Bind one:  npx -p @floatonnear/create-float float-agent --vault ${VAULT} --owner <you>`,
  );
} else {
  for (const g of gas) {
    const p = g.access_key.permission.GasKeyFunctionCall;
    const node = await provider
      .callFunction({
        contractId: VAULT,
        method: "get_virtual_agent_node",
        args: { public_key: g.public_key },
        blockQuery: { finality: "final" },
      })
      .catch(() => null);

    console.log(`  agent key    ${g.public_key}`);
    console.log(`  node         ${node === null ? "not bound" : `#${node}`}`);
    console.log(`  receiver_id  ${p.receiver_id}`);
    console.log(`  method_names ${JSON.stringify(p.method_names)}`);
    console.log(`  gas balance  ${near(p.balance)} NEAR  (the agent pays its own gas)`);

    /**
     * SAY WHAT THE AUDIENCE SHOULD CONCLUDE, and only when it is true of THIS
     * key. A prop that prints the reassuring sentence unconditionally is
     * marketing; printing it only when the chain agrees is evidence.
     */
    const pinnedToVault = p.receiver_id === VAULT;
    const onlyPayment =
      Array.isArray(p.method_names) &&
      p.method_names.length === 1 &&
      p.method_names[0] === "request_payment";

    console.log("");
    if (pinnedToVault && onlyPayment) {
      console.log("  => one receiver, one method. This key cannot call the token contract,");
      console.log("     cannot raise its own limit, and cannot reach an owner function.");
    } else {
      console.log(`  => NOT the restricted shape. receiver pinned to vault: ${pinnedToVault};`);
      console.log(`     request_payment only: ${onlyPayment}. Do not demo this key.`);
    }
    console.log("");
  }
}

// The owner's key is FULL-ACCESS on the vault by design — it is what lets the
// owner sign AS the vault to recover gas-key balances at teardown. Worth naming
// before someone in the audience spots it and assumes it is a mistake.
console.log(
  `  ${full.length} full-access key(s) — the owner's, which is how gas-key recovery and` +
    `${LF}  teardown are possible at all. Wallets cannot sign as the vault, so that is a CLI job.`,
);

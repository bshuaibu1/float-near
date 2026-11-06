/**
 * Fill in each agent's node id by asking the CHAIN which node its key drives.
 *
 * `add_role` creates the node inside the contract, so the id does not exist
 * when the credential is written — a client cannot read one action's return
 * value from the same transaction, and predicting it from `next_node_id`
 * races any concurrent `add_node`. So the credential is filed with no
 * `nodeId` at all and this reconciles it afterwards.
 *
 * WHY NOT JUST GUESS. The first version defaulted to 0, which filed an agent
 * the contract had put on node 1 against the ROOT node. Nothing failed:
 * selection by role still worked, `byNode.get(1)` simply missed, and
 * `byNode.get(0)` returned that agent under the root's name. A wrong id is
 * worse than an absent one precisely because it answers.
 *
 * `get_virtual_agent_node` is the authority — it reads the same
 * `pubkey_to_node` map the contract uses to decide which budget a payment
 * charges, so what this writes is what will actually be billed.
 *
 *   node scripts/sync-agent-nodes.mjs [--write]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PATH = process.env.NEAR_VAULT_AGENT_KEYS ?? resolve(ROOT, ".float", "agent-keys.json");
const RPC = process.env.RPC ?? "https://test.rpc.fastnear.com";
const WRITE = process.argv.includes("--write");

async function nodeFor(vault, publicKey) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: vault,
        method_name: "get_virtual_agent_node",
        args_base64: Buffer.from(JSON.stringify({ public_key: publicKey })).toString("base64"),
      },
    }),
  });
  const j = await res.json();
  if (j.error || !j.result?.result) return { err: JSON.stringify(j.error ?? {}).slice(0, 80) };
  return { node: JSON.parse(Buffer.from(j.result.result).toString()) };
}

if (!existsSync(PATH)) {
  console.error(`FATAL: no keyring at ${PATH}`);
  process.exit(1);
}
const ring = JSON.parse(readFileSync(PATH, "utf8"));

let changed = 0;
for (const e of ring) {
  // Only entries the adapter would load. Anything else contributes nothing to
  // selection, so correcting its node id would be tidying a corpse.
  if (!e || typeof e.agentId !== "string" || typeof e.secret !== "string") continue;
  if (!e.publicKey) {
    console.log(`  ${String(e.role ?? "(no role)").padEnd(12)} no publicKey recorded — cannot look it up`);
    continue;
  }
  const { node, err } = await nodeFor(e.agentId, e.publicKey);
  const label = String(e.role ?? "(no role)").padEnd(12);
  if (err) {
    console.log(`  ${label} ${e.agentId}  LOOKUP FAILED: ${err}`);
    continue;
  }
  if (node === null) {
    // Bound on chain is the whole premise of a credential. Say so rather than
    // leaving a key that can never spend looking like a working agent.
    console.log(`  ${label} ${e.agentId}  NOT BOUND on chain — this key cannot spend`);
    continue;
  }
  if (e.nodeId === node) {
    console.log(`  ${label} node ${node}  (already correct)`);
    continue;
  }
  console.log(`  ${label} node ${node}  <- was ${e.nodeId === undefined ? "absent" : e.nodeId}`);
  e.nodeId = node;
  changed++;
}

console.log();
if (!changed) {
  console.log("nothing to change.");
} else if (WRITE) {
  writeFileSync(PATH, JSON.stringify(ring, null, 2) + "\n");
  console.log(`updated ${changed} entr${changed === 1 ? "y" : "ies"} in ${PATH}`);
} else {
  console.log(`${changed} entr${changed === 1 ? "y" : "ies"} would change. Re-run with --write.`);
}

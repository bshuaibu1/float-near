/**
 * Refuse unless a payment is GUARANTEED to be rejected by the contract.
 *
 * This is the guard that lets a script demonstrate a refusal on MAINNET without
 * being one typo away from spending. It does not ask the caller to be careful;
 * it reads the smallest per-payment cap in the paying node's ancestor chain
 * from the chain and throws unless the requested amount exceeds it. A transfer
 * is then unreachable on that path.
 *
 * EXTRACTED so `drive-mcp.mjs` and `prove-refusal.mjs` share ONE
 * implementation. Two copies of a money guard is how they drift, and the one
 * that drifts is the one nobody re-reads.
 *
 * Why the SMALLEST and not the node's own: a payment is checked at every level,
 * so exceeding the minimum guarantees at least one level refuses. It does not
 * predict WHICH level reports — the contract walks root-first, so a tie is
 * blamed on the ancestor (PARENT_PER_TX_LIMIT). Safety needs only the minimum.
 */
import { readFileSync } from "node:fs";
import { JsonRpcProvider } from "near-api-js";

export async function assertCannotSettle({ amount, recipient, token, role }) {
  if (amount === undefined) throw new Error("cannot-settle: no amount given");

  const cfg = JSON.parse(readFileSync(".mcp.json", "utf8"));
  const env = (cfg.mcpServers ?? cfg.servers ?? {})["float-near"]?.env ?? {};
  const VAULT = env.NEAR_VAULT_CONTRACT;
  const TOKEN = token ?? env.NEAR_VAULT_TOKEN;
  const NETWORK = env.NEAR_VAULT_NETWORK ?? "mainnet";
  const RPC = {
    mainnet: "https://free.rpc.fastnear.com",
    testnet: "https://test.rpc.fastnear.com",
  }[NETWORK];
  if (!VAULT || !TOKEN || !RPC) throw new Error("cannot-settle: .mcp.json incomplete");

  const provider = new JsonRpcProvider({ url: RPC });
  const view = (contractId, method, args = {}) =>
    provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });

  const meta = await view(TOKEN, "ft_metadata", {}).catch(() => null);
  const decimals = meta?.decimals ?? Number(env.NEAR_VAULT_TOKEN_DECIMALS ?? "6");

  const toBase = (h) => {
    const [i, f = ""] = String(h).split(".");
    return BigInt(i + (f + "0".repeat(decimals)).slice(0, decimals));
  };
  const fromBase = (v) => (Number(v) / 10 ** decimals).toString();

  // Which node pays. The keyring entry's role selects the key, and the key
  // selects the node — same resolution the server does.
  const keyring = JSON.parse(readFileSync(env.NEAR_VAULT_AGENT_KEYS, "utf8").replace(/^﻿/, ""));
  const mine = keyring.filter((e) => (e.agentId ?? e.vault) === VAULT);
  const entry = role ? mine.find((e) => e.role === role) : mine[0];
  if (!entry) throw new Error(`cannot-settle: no keyring entry for ${VAULT}${role ? ` role ${role}` : ""}`);

  const nodeId = await view(VAULT, "get_virtual_agent_node", { public_key: entry.publicKey });
  if (nodeId === null) throw new Error("cannot-settle: that key is not bound to a node");

  const tree = await view(VAULT, "get_tree", {});
  const byId = new Map(tree.map((n) => [n.id, n]));
  let smallest;
  for (
    let cur = byId.get(nodeId);
    cur !== undefined;
    cur = cur.parent === null ? undefined : byId.get(cur.parent)
  ) {
    const lim = (cur.limits ?? []).find((l) => l.token === TOKEN);
    if (!lim) continue;
    const v = BigInt(lim.per_tx_cap);
    if (smallest === undefined || v < smallest) smallest = v;
  }
  if (smallest === undefined) {
    throw new Error(`cannot-settle: no limit for that token in node #${nodeId}'s chain`);
  }

  const want = toBase(amount);
  if (want <= smallest) {
    throw new Error(
      `cannot-settle: ${amount} is WITHIN the ${fromBase(smallest)} per-payment cap, so it ` +
        `would SETTLE and move real funds. Refusing. This path only sends amounts the ` +
        `contract is guaranteed to reject; make real payments deliberately, from the client.`,
    );
  }

  console.log(
    `cannot-settle: ${amount} exceeds the ${fromBase(smallest)} per-payment cap ` +
      `(node #${nodeId} chain) — a transfer is impossible on this path.`,
  );
  return { nodeId, perTxCap: fromBase(smallest) };
}

#!/usr/bin/env node
/**
 * MCP server for the hierarchical budget vault.
 *
 * Trust model, which is the whole point of the split below:
 *
 *   READ tools      no key at all, raw JSON-RPC
 *   PAY tool        signs with the agent's RESTRICTED key — request_payment
 *                   on this vault only, no deposit possible
 *   PLAN tools      emit UNSIGNED payloads for the human's wallet; this
 *                   server never signs anything that changes policy
 *
 * Configure with:
 *   NEAR_VAULT_CONTRACT        required
 *   NEAR_VAULT_RPC_URL         default https://rpc.testnet.near.org
 *   NEAR_VAULT_TOKEN           default token for pay/budget calls
 *   NEAR_VAULT_TOKEN_DECIMALS  default 6
 *   NEAR_VAULT_AGENT_ID        only needed to PAY
 *   NEAR_VAULT_AGENT_KEY       only needed to PAY. The restricted key.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fromBaseUnits, toBaseUnits } from "./amounts.js";
import {
  BASE_GAS_TGAS,
  DEFAULT_GAS_TGAS,
  planAddNode,
  planCreateAgentAccount,
  planFreezeNode,
  planPurgeSettled,
  planSetCooldown,
  planSetNodeCaps,
  planSetPaused,
  planSetRecipients,
  toCliCommand,
  type OwnerPayload,
} from "./payloads.js";
import { DEFAULT_RPC_URL, newRequestId, requireAgentKey, viewFunction } from "./rpc.js";
import { buildRoute, sendRequestPayment } from "./sign.js";

const cfg = {
  vault: process.env.NEAR_VAULT_CONTRACT ?? "",
  rpcUrl: process.env.NEAR_VAULT_RPC_URL ?? DEFAULT_RPC_URL,
  token: process.env.NEAR_VAULT_TOKEN ?? "",
  decimals: Number(process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6"),
  agentId: process.env.NEAR_VAULT_AGENT_ID,
  agentKey: process.env.NEAR_VAULT_AGENT_KEY,
  network: process.env.NEAR_VAULT_NETWORK ?? "testnet",
};

function requireVault(): string {
  if (!cfg.vault) throw new Error("NEAR_VAULT_CONTRACT is not set");
  return cfg.vault;
}
function tokenFor(t?: string): string {
  const token = t ?? cfg.token;
  if (!token) throw new Error("no token given and NEAR_VAULT_TOKEN is not set");
  return token;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** Payload + summary + warnings + a runnable command, so approving needs no trust in this server. */
function renderPlan(p: OwnerPayload) {
  return json({
    action: p.methodName,
    summary: p.summary,
    warnings: p.warnings,
    unsigned_payload: {
      receiver_id: p.receiverId,
      method_name: p.methodName,
      args: p.args,
      gas_tgas: p.gasTgas,
      deposit_yocto: p.depositYocto,
    },
    approve_with: toCliCommand(p, cfg.network),
    note:
      "This server did NOT sign this. Review the summary, then run the command " +
      "or approve the payload in your wallet.",
  });
}

const limitShape = z
  .array(
    z.object({
      token: z.string(),
      dailyCap: z.string().describe('human units, e.g. "1000"'),
      perTxCap: z.string().describe('human units, e.g. "250"'),
      decimals: z.number().int().min(0).max(38).default(6),
    }),
  )
  .min(1);

const server = new McpServer({ name: "near-vault", version: "0.1.0" });

// ----------------------------------------------------------------- reads

server.tool(
  "vault_tree",
  "Read the whole budget tree: every node, its caps, parent, bound agent account, cooldown and freeze state. No key required.",
  {},
  async () => json(await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {})),
);

server.tool(
  "vault_budget",
  "Read one node's budget for a UTC day: cap, executed, in-flight (pending) and available, in human units. Omit `day` for today. No key required.",
  {
    nodeId: z.number().int().min(0),
    token: z.string().optional(),
    day: z.number().int().optional(),
  },
  async ({ nodeId, token, day }) => {
    const b = (await viewFunction(cfg.rpcUrl, requireVault(), "get_node_budget", {
      node_id: nodeId,
      token: tokenFor(token),
      day: day ?? null,
    })) as Record<string, string> | null;
    if (!b) return text(`node ${nodeId} has no limit for that token`);
    const d = cfg.decimals;
    return json({
      node_id: nodeId,
      day: b.day,
      daily_cap: fromBaseUnits(BigInt(b.daily_cap!), d),
      executed: fromBaseUnits(BigInt(b.executed!), d),
      pending: fromBaseUnits(BigInt(b.pending!), d),
      available: fromBaseUnits(BigInt(b.available!), d),
    });
  },
);

server.tool(
  "vault_request",
  "Read one stored payment request: status, reason code, amount, the ancestor chain it charged, and the UTC day it was reserved against. No key required.",
  { requestId: z.string() },
  async ({ requestId }) =>
    json(await viewFunction(cfg.rpcUrl, requireVault(), "get_request", { request_id: requestId })),
);

server.tool(
  "vault_config",
  "Read vault config: owner, paused, strict-vs-overcommit allocation, node count, and clock mode. No key required.",
  {},
  async () => json(await viewFunction(cfg.rpcUrl, requireVault(), "get_config", {})),
);

// ------------------------------------------------------------------- pay

server.tool(
  "vault_pay",
  "Send a payment from the agent's node. Signs with the agent's RESTRICTED key, which can call only request_payment on this vault and cannot attach a deposit. The contract checks the per-tx cap, the daily cap at EVERY level of the budget tree, the cooldown and the payee allowlist before any value moves.",
  {
    amount: z.string().describe('human units, e.g. "12.50"'),
    recipient: z.string(),
    memo: z.string().max(256).default(""),
    token: z.string().optional(),
    requestId: z.string().optional().describe("omit to generate one"),
    rail: z
      .enum(["near", "base"])
      .default("near")
      .describe(
        "near = NEP-141 transfer, proves settlement. base = Chain Signatures over a Base USDC transfer, proves authorization + signature only (relaying is off-chain and unobserved). BOTH rails run the same hierarchical budget check and the same payee allowlist.",
      ),
    base: z
      .object({
        nonce: z.string(),
        maxFeePerGas: z.string(),
        maxPriorityFeePerGas: z.string(),
        gasLimit: z.string(),
      })
      .optional()
      .describe(
        "Required when rail=base. Fee and ordering fields ONLY — the contract builds the ERC-20 calldata and the transaction itself from the amount and recipient it authorized, so these cannot redirect the payment.",
      ),
  },
  async ({ amount, recipient, memo, token, requestId, rail, base }) => {
    const creds = requireAgentKey(cfg);
    const out = await sendRequestPayment({
      rpcUrl: cfg.rpcUrl,
      vault: requireVault(),
      agentId: creds.agentId,
      agentKey: creds.agentKey,
      requestId: requestId ?? newRequestId(),
      token: tokenFor(token),
      amount: toBaseUnits(amount, cfg.decimals),
      recipient,
      memo,
      // The Base rail needs more than the default: the contract rejects it
      // below 230 Tgas because MPC signing fans out across the signer network.
      gasTgas: rail === "base" ? BASE_GAS_TGAS : DEFAULT_GAS_TGAS,
      route: buildRoute(rail, base),
    });
    return json(out);
  },
);

// ------------------------------------------------------- plans (unsigned)

server.tool(
  "vault_plan_add_node",
  "Build an UNSIGNED payload to create a budget node. Pass parent=null for the root. Not signed by this server.",
  {
    parent: z.number().int().min(0).nullable(),
    label: z.string(),
    limits: limitShape,
    cooldownSec: z.number().int().min(0).default(0),
    recipients: z.array(z.string()).nullable().default(null),
  },
  async ({ parent, label, limits, cooldownSec, recipients }) =>
    renderPlan(planAddNode(requireVault(), parent, label, limits, cooldownSec, recipients)),
);

server.tool(
  "vault_plan_set_caps",
  "Build an UNSIGNED payload to change a node's daily and per-payment caps. Not signed by this server.",
  { nodeId: z.number().int().min(0), limits: limitShape },
  async ({ nodeId, limits }) => renderPlan(planSetNodeCaps(requireVault(), nodeId, limits)),
);

server.tool(
  "vault_plan_create_agent",
  "Build an UNSIGNED payload to create an agent sub-account with ONE key restricted to request_payment on this vault. Generate the keypair yourself and pass only the public half. Not signed by this server.",
  {
    nodeId: z.number().int().min(0),
    subLabel: z.string(),
    publicKey: z.string().describe("ed25519:..."),
    keyAllowanceNear: z.string().default("2").describe("gas allowance in NEAR; floor is 0.5"),
  },
  async ({ nodeId, subLabel, publicKey, keyAllowanceNear }) =>
    renderPlan(
      planCreateAgentAccount(requireVault(), nodeId, subLabel, publicKey, keyAllowanceNear),
    ),
);

server.tool(
  "vault_plan_freeze",
  "Build an UNSIGNED payload to freeze or unfreeze a node. Freezing blocks the node AND its whole subtree. Not signed by this server.",
  { nodeId: z.number().int().min(0), frozen: z.boolean() },
  async ({ nodeId, frozen }) => renderPlan(planFreezeNode(requireVault(), nodeId, frozen)),
);

server.tool(
  "vault_plan_set_recipients",
  "Build an UNSIGNED payload to set a node's payee allowlist. This REPLACES the inherited list rather than adding to it; pass null to inherit. Not signed by this server.",
  { nodeId: z.number().int().min(0), recipients: z.array(z.string()).nullable() },
  async ({ nodeId, recipients }) =>
    renderPlan(planSetRecipients(requireVault(), nodeId, recipients)),
);

server.tool(
  "vault_plan_set_cooldown",
  "Build an UNSIGNED payload to set the minimum seconds between a node's payments. Not signed by this server.",
  { nodeId: z.number().int().min(0), cooldownSec: z.number().int().min(0) },
  async ({ nodeId, cooldownSec }) =>
    renderPlan(planSetCooldown(requireVault(), nodeId, cooldownSec)),
);

server.tool(
  "vault_plan_pause",
  "Build an UNSIGNED payload to pause or resume the whole vault. Pausing halts every agent payment. Not signed by this server.",
  { paused: z.boolean() },
  async ({ paused }) => renderPlan(planSetPaused(requireVault(), paused)),
);

server.tool(
  "vault_plan_purge",
  "Build an UNSIGNED payload to delete settled payment records older than a UTC day. Spend totals are NOT refunded, but a deleted request id becomes reusable. Not signed by this server.",
  {
    beforeDay: z.number().int().min(0),
    limit: z.number().int().min(0).max(100).default(100),
  },
  async ({ beforeDay, limit }) => renderPlan(planPurgeSettled(requireVault(), beforeDay, limit)),
);

await server.connect(new StdioServerTransport());

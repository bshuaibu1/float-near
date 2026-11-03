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
 *   CREATE tool     needs no key and no vault. It reads the factory, works out
 *                   the address and the cost, and hands back a URL the user
 *                   approves in their own wallet.
 *
 * Configure with:
 *   NEAR_VAULT_CONTRACT        required by every tool EXCEPT vault_create
 *   NEAR_VAULT_RPC_URL         default https://test.rpc.fastnear.com
 *   NEAR_VAULT_TOKEN           default token for pay/budget calls
 *   NEAR_VAULT_TOKEN_DECIMALS  default 6
 *   NEAR_VAULT_AGENT_ID        only needed to PAY
 *   NEAR_VAULT_AGENT_KEY       only needed to PAY. The restricted key.
 *   NEAR_VAULT_NETWORK         mainnet | testnet, default testnet
 *   NEAR_VAULT_FACTORY         only needed to CREATE. No mainnet default
 *                              exists on purpose — guessing it wrong would
 *                              send a real deposit somewhere unverified.
 *   NEAR_VAULT_APP_URL         only needed to CREATE, default
 *                              https://app.usefloat.xyz
 *
 * A user with NO vault can therefore run this server with nothing configured,
 * call `vault_create`, and be onboarded — which is the point. Every other tool
 * reports that NEAR_VAULT_CONTRACT is unset rather than guessing one.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fromBaseUnits, toBaseUnits } from "./amounts.js";
import {
  DEFAULT_GAS_TGAS,
  planAddNode,
  planBindVirtualAgent,
  planUnbindVirtualAgent,
  planFreezeNode,
  planPurgeSettled,
  planSetCooldown,
  planSetNodeCaps,
  planSetPaused,
  planSetRecipients,
  toCliCommand,
  type OwnerPayload,
  planSetApprovalThreshold,
  planApprovePayment,
  planRejectPayment,
} from "./payloads.js";
import { accountExists, DEFAULT_RPC_URL, newRequestId, requireAgentKey, viewFunction } from "./rpc.js";
import { buildCreatePlan, FACTORY_BY_NETWORK } from "./create.js";
import { buildRoute, sendRequestPayment, type RouteArg } from "./sign.js";
import { getQuote, signBinding, toBase64 } from "./quote.js";

/** How long a quote stays valid. Long enough to sign and send, short
 *  enough that a stale price is not honoured. */
const QUOTE_TTL_MS = 20 * 60 * 1000;

const cfg = {
  vault: process.env.NEAR_VAULT_CONTRACT ?? "",
  rpcUrl: process.env.NEAR_VAULT_RPC_URL ?? DEFAULT_RPC_URL,
  token: process.env.NEAR_VAULT_TOKEN ?? "",
  decimals: Number(process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6"),
  agentId: process.env.NEAR_VAULT_AGENT_ID,
  agentKey: process.env.NEAR_VAULT_AGENT_KEY,
  network: process.env.NEAR_VAULT_NETWORK ?? "testnet",
  // Onboarding only. Both have safe defaults and neither is needed by any
  // tool that touches an existing vault.
  factory: process.env.NEAR_VAULT_FACTORY,
  appUrl: process.env.NEAR_VAULT_APP_URL ?? "https://app.usefloat.xyz",
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

// The name a client displays in its server list, so this string -- not the
// package name, not the config key -- is the product's label in the one place
// the product is visible. It was "near-vault": the repo's directory name,
// leaking outward as the user-facing identity while the config key create-float
// writes has always been `float`.
//
// The version stays a literal rather than being read from package.json at
// startup: a wrong relative path would break the server outright instead of
// merely reporting a stale version. server.smoke.test.ts asserts the two agree,
// so a bump cannot land with only one of them moved.
const server = new McpServer({ name: "float", version: "0.3.0" });

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

// ------------------------------------------------------------- onboarding

server.tool(
  "vault_create",
  "For a user who has NO vault yet. Works out where their vault will live, exactly what it costs to create, and returns a URL they approve in their own wallet. Needs no key and no existing vault — this is the only tool that works before NEAR_VAULT_CONTRACT is set. This server never signs it.",
  {
    owner: z
      .string()
      .optional()
      .describe(
        "the account that will own the vault, e.g. alice.near. OMIT IT if you do not know the user's NEAR account — the link then derives everything from whichever wallet they connect, which is the normal case when onboarding someone new.",
      ),
    network: z.enum(["mainnet", "testnet"]).optional(),
    factory: z
      .string()
      .optional()
      .describe("override the factory; defaults to the known one for the network"),
  },
  async ({ owner, network, factory }) => {
    const net = network ?? cfg.network;
    const fac = factory ?? cfg.factory ?? FACTORY_BY_NETWORK[net];
    if (!fac) {
      // DELIBERATELY NOT A GUESS. A wrong mainnet default does not fail
      // safely — it takes a real signature for a real deposit into an account
      // nobody verified.
      return text(
        `No factory is configured for ${net}. Pass one as \`factory\`, or set ` +
          `NEAR_VAULT_FACTORY. There is deliberately no built-in mainnet default: ` +
          `guessing it wrong would send a real deposit somewhere unverified.`,
      );
    }
    const rpc = cfg.rpcUrl;

    // Only ask the factory to derive an id when there IS an owner. With none,
    // the address is decided by whichever wallet signs, and inventing one here
    // would print a plausible address next to a real deposit figure.
    const config = await viewFunction<{
      required_deposit: string;
      paused: boolean;
      network: string;
    }>(rpc, fac, "get_config", {});
    const vaultId = owner
      ? await viewFunction<string | null>(rpc, fac, "vault_id_for", { owner })
      : null;

    const extra: string[] = [];
    if (config.network !== net) {
      extra.push(
        `The factory reports network "${config.network}" but you asked for ${net}; ` +
          `the vault will be initialised with "${config.network}".`,
      );
    }

    const exists = owner && vaultId ? await accountExists(rpc, vaultId) : false;

    try {
      const plan = buildCreatePlan({
        owner: owner ?? "",
        ownerKnown: !!owner,
        vaultId,
        factory: fac,
        network: net,
        requiredDepositYocto: String(config.required_deposit),
        paused: config.paused,
        appUrl: cfg.appUrl,
        exists,
      });
      return json({ ...plan, warnings: [...extra, ...plan.warnings] });
    } catch (e) {
      return text(String((e as Error).message));
    }
  },
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
      .enum(["near", "intents"])
      .default("near")
      .describe(
        "near = NEP-141 transfer on NEAR, proves settlement. intents = cross-chain: the vault transfers on NEAR to a solver's one-time deposit address and the solver delivers on the destination chain. BOTH run the same hierarchical budget check and the same payee allowlist.",
      ),
    destinationAsset: z
      .string()
      .optional()
      .describe("1Click asset id for rail=intents. Defaults to USDC on Base."),
  },
  async ({ amount, recipient, memo, token, requestId, rail, destinationAsset }) => {
    const creds = requireAgentKey(cfg);
    const id = requestId ?? newRequestId();
    const vault = requireVault();

    let route: RouteArg = "near_direct";
    let amountIn = toBaseUnits(amount, cfg.decimals);

    if (rail === "intents") {
      // The agent cannot build this route. It needs a quote AND a signature
      // from the key the vault owner registered — and that key deliberately
      // does not live where agents run, because whoever holds it can bind any
      // deposit address to any payee. So this path only works when the MCP
      // server is the operator's own.
      const signerHex = process.env.FLOAT_QUOTE_SIGNER_KEY;
      if (!signerHex) {
        throw new Error(
          "rail=intents needs FLOAT_QUOTE_SIGNER_KEY (32-byte hex). " +
            "That key binds a payee to a deposit address, so it belongs to the " +
            "vault operator, not to an agent. Without it the cross-chain rail is closed.",
        );
      }
      const sk = Uint8Array.from(Buffer.from(signerHex.replace(/^0x/, ""), "hex"));

      // EXACT_OUTPUT: `amount` is what the PAYEE receives. What leaves the
      // vault is the quote's amountIn, and that is what the budget is charged
      // — so the tree governs real outflow, not the nominal figure.
      const deadline = new Date(Date.now() + QUOTE_TTL_MS);
      const q = await getQuote({
        amountOut: toBaseUnits(amount, cfg.decimals),
        payee: recipient,
        refundTo: vault,
        destinationAsset,
        deadline,
      });
      amountIn = q.amountIn;

      const signature = signBinding(
        {
          vault,
          requestId: id,
          token: tokenFor(token),
          amount: q.amountIn,
          payee: recipient,
          depositAddress: q.depositAddress,
          deadlineNs: q.deadlineNs,
        },
        sk,
      );
      route = buildRoute("intents", {
        depositAddress: q.depositAddress,
        quoteDeadlineNs: q.deadlineNs.toString(),
        signature: toBase64(signature),
      });
    }

    const out = await sendRequestPayment({
      rpcUrl: cfg.rpcUrl,
      vault,
      agentId: creds.agentId,
      agentKey: creds.agentKey,
      requestId: id,
      token: tokenFor(token),
      amount: amountIn,
      recipient,
      memo,
      gasTgas: DEFAULT_GAS_TGAS,
      route,
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
  "vault_plan_bind_agent",
  "Build an UNSIGNED payload binding a signing key to a node, so that key may spend from it. Generate the keypair yourself and pass only the public half. Many keys may share one node. Not signed by this server.",
  {
    nodeId: z.number().int().min(0),
    publicKey: z.string().describe("ed25519:..."),
  },
  async ({ nodeId, publicKey }) =>
    renderPlan(planBindVirtualAgent(requireVault(), nodeId, publicKey)),
);

server.tool(
  "vault_plan_unbind_agent",
  "Build an UNSIGNED payload revoking a signing key's authority to spend. Does NOT return any gas left in that key's NEP-611 gas key — withdraw from the gas key separately. Not signed by this server.",
  { publicKey: z.string().describe("ed25519:...") },
  async ({ publicKey }) => renderPlan(planUnbindVirtualAgent(requireVault(), publicKey)),
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
  "vault_pending_approval",
  "Look up a payment that is HELD awaiting the owner's approval. Returns null if there is no ticket for that id — already approved, already rejected, or never held.",
  { requestId: z.string().min(1) },
  async ({ requestId }) =>
    json(
      (await viewFunction(cfg.rpcUrl, requireVault(), "get_pending_approval", {
        request_id: requestId,
      })) ?? null,
    ),
);

server.tool(
  "vault_plan_set_approval_threshold",
  'Build an UNSIGNED payload requiring the owner\'s approval for payments above an amount at this node. A threshold sits INSIDE the caps and can only make the vault more conservative. `amount` is HUMAN units, the same convention as vault_pay — "0.25" is a quarter of a USDC. Pass amount null to remove the threshold. Not signed by this server.',
  {
    nodeId: z.number().int().min(0),
    // HUMAN units, matching vault_pay and vault_plan_set_caps. This took BASE
    // units until 2026-10-31 and was the only tool here that did — on the one
    // control that configures a safety gate, where the mistake fails OPEN. See
    // planSetApprovalThreshold in payloads.ts for the measurement.
    amount: z.string().min(1).nullable().describe('human units, e.g. "0.25" — NOT base units'),
    decimals: z.number().int().min(0).max(38).default(6),
  },
  async ({ nodeId, amount, decimals }) =>
    renderPlan(planSetApprovalThreshold(requireVault(), nodeId, amount, decimals)),
);

server.tool(
  "vault_plan_approve_payment",
  "Build an UNSIGNED payload to APPROVE a held payment, which sends it. Every limit is re-checked at approval, so it can still be refused. Not signed by this server.",
  { requestId: z.string().min(1) },
  async ({ requestId }) => renderPlan(planApprovePayment(requireVault(), requestId)),
);

server.tool(
  "vault_plan_reject_payment",
  "Build an UNSIGNED payload to REJECT a held payment. Nothing moves and the ticket is discarded. Not signed by this server.",
  { requestId: z.string().min(1) },
  async ({ requestId }) => renderPlan(planRejectPayment(requireVault(), requestId)),
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

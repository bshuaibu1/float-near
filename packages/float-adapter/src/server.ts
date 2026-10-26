#!/usr/bin/env node
/**
 * Serves the existing Float dashboard's /v1 API from NEAR vault views.
 *
 * The point of this process: the Float dashboard runs UNCHANGED. Same
 * components, same logo, same styles, same screens — only
 * NEXT_PUBLIC_FLOAT_API_URL points here instead of at the Solana backend.
 *
 * node:http with no framework, because the whole job is four JSON endpoints.
 *
 *   NEAR_VAULT_CONTRACT        required
 *   NEAR_VAULT_RPC_URL         default https://test.rpc.fastnear.com
 *   NEAR_VAULT_TOKEN           required (the NEP-141 the vault pays in)
 *   NEAR_VAULT_TOKEN_DECIMALS  default 6
 *   NEAR_VAULT_AGENT_ID        only needed for POST /v1/pay
 *   NEAR_VAULT_AGENT_KEY       only needed for POST /v1/pay (the restricted key)
 *   PORT                       default 8787 (Float's dashboard default)
 */

import { createServer } from "node:http";
import { toBaseUnits, fromBaseUnits } from "@near-vault/mcp/amounts";
import { newRequestId, requireAgentKey, viewAccessKeys, viewFunction } from "@near-vault/mcp";
import { sendRequestPayment } from "@near-vault/mcp/sign";
import {
  planFreezeNode,
  planSetCooldown,
  planSetNodeCaps,
  planSetRecipients,
  toCliCommand,
} from "@near-vault/mcp/payloads";

import {
  getAgentKeys,
  getDashboard,
  getSpendHistory,
  getVaultInfo,
  paymentFromOutcome,
  type AdapterConfig,
} from "./handlers.js";
import type { VaultNode } from "./map.js";

const env = {
  vault: process.env.NEAR_VAULT_CONTRACT ?? "",
  // See DEFAULT_RPC_URL in @near-vault/mcp: the old public testnet endpoint
  // is deprecated and now returns -429 for every call.
  rpcUrl: process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com",
  token: process.env.NEAR_VAULT_TOKEN ?? "",
  decimals: Number(process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6"),
  agentId: process.env.NEAR_VAULT_AGENT_ID,
  agentKey: process.env.NEAR_VAULT_AGENT_KEY,
  port: Number(process.env.PORT ?? "8787"),
};

if (!env.vault || !env.token) {
  console.error("NEAR_VAULT_CONTRACT and NEAR_VAULT_TOKEN are required");
  process.exit(1);
}

const cfg: AdapterConfig = {
  token: env.token,
  decimals: env.decimals,
  blockedRing: [],
  maxBlocked: 50,
};

const view = <T,>(method: string, args: unknown = {}) =>
  viewFunction<T>(env.rpcUrl, env.vault, method, args);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${env.port}`);

  // The dashboard runs on another port in dev.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  try {
    if (url.pathname === "/v1/dashboard") {
      return send(200, await getDashboard(view, cfg));
    }

    if (url.pathname === "/v1/spend-history") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "25"), 50);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return send(200, await getSpendHistory(view, cfg, limit, offset));
    }

    // Where this vault lives. The UI reads the chain from here rather than
    // hardcoding it, so it cannot link a testnet vault to a mainnet explorer.
    if (url.pathname === "/v1/vault-info") {
      return send(
        200,
        await getVaultInfo(view, cfg, (contractId, method, args) =>
          viewFunction<string | null>(env.rpcUrl, contractId, method, args ?? {}),
        ),
      );
    }

    // Agent accounts WITH their access keys read from the chain. The key
    // restriction is the product's central claim, so the page that states it
    // reads the real permission instead of a constant.
    if (url.pathname === "/v1/agent-keys") {
      return send(200, await getAgentKeys(view, (id) => viewAccessKeys(env.rpcUrl, id), cfg));
    }

    /**
     * An UNSIGNED owner payload for a policy change, plus the exact CLI command.
     *
     * Deliberately not a write endpoint. Owner methods change who can spend the
     * treasury, so this server never signs them — it only ever holds an agent
     * key that can call `request_payment`. The dashboard therefore shows the
     * owner what to run rather than claiming to have saved anything, which is
     * also why the old Solana-era "Save policy" button could never have worked
     * here: it POSTed to /v1/agents/:id/policy, which does not exist.
     */
    if (url.pathname === "/v1/owner-plan" && req.method === "POST") {
      const body = await new Promise<string>((ok) => {
        let s = "";
        req.on("data", (d) => (s += d));
        req.on("end", () => ok(s));
      });
      const b = JSON.parse(body || "{}") as {
        action: "caps" | "cooldown" | "recipients" | "freeze";
        nodeId: number;
        dailyCap?: string;
        perTxCap?: string;
        cooldownSec?: number;
        recipients?: string[] | null;
        frozen?: boolean;
      };

      const net = await view<{ network: string }>("get_config", {});
      let payload;
      switch (b.action) {
        case "caps":
          // HUMAN units, with decimals — `planSetNodeCaps` scales them itself
          // via limitsToArgs. Calling toBaseUnits here too would scale twice
          // and turn a 100 USDC cap into 100 million USDC.
          payload = planSetNodeCaps(env.vault, b.nodeId, [
            {
              token: env.token,
              dailyCap: b.dailyCap ?? "0",
              perTxCap: b.perTxCap ?? "0",
              decimals: env.decimals,
            },
          ]);
          break;
        case "cooldown":
          payload = planSetCooldown(env.vault, b.nodeId, b.cooldownSec ?? 0);
          break;
        case "recipients":
          payload = planSetRecipients(env.vault, b.nodeId, b.recipients ?? null);
          break;
        case "freeze":
          payload = planFreezeNode(env.vault, b.nodeId, b.frozen ?? false);
          break;
        default:
          return send(400, { error: `unknown action: ${String(b.action)}` });
      }

      return send(200, { payload, cli: toCliCommand(payload, net.network) });
    }

    if (url.pathname === "/v1/settings") {
      const c = await view<{ owner: string }>("get_config", {});
      return send(200, { ownerWallet: c.owner, notificationEmail: null });
    }

    if (url.pathname === "/v1/pay" && req.method === "POST") {
      const creds = requireAgentKey(env);
      const body = await new Promise<string>((ok) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => ok(b));
      });
      const { amount, recipient, memo = "" } = JSON.parse(body || "{}") as {
        amount: string;
        recipient: string;
        memo?: string;
      };

      const outcome = (await sendRequestPayment({
        rpcUrl: env.rpcUrl,
        vault: env.vault,
        agentId: creds.agentId,
        agentKey: creds.agentKey,
        requestId: newRequestId(),
        token: env.token,
        amount: toBaseUnits(amount, env.decimals),
        recipient,
        memo,
        gasTgas: 100,
      })) as { status?: string; reason_code?: string; request_id?: string; node_id?: number };

      // A BLOCKED outcome is never stored on-chain, so if the dashboard is to
      // show it as a row, this process has to remember it. See recordBlocked.
      const tree = await view<VaultNode[]>("get_tree", {});
      const labels: Record<number, string> = {};
      for (const n of tree) labels[n.id] = n.label;

      const blocked = outcome.status
        ? paymentFromOutcome(
            cfg,
            {
              request_id: outcome.request_id ?? "",
              node_id: outcome.node_id ?? 0,
              status: outcome.status,
              reason_code: outcome.reason_code ?? "",
            },
            labels,
            amount,
            recipient,
          )
        : null;

      return send(200, { outcome, blocked });
    }

    if (url.pathname === "/healthz") {
      const c = await view<{ vault_id: string; clock_mode: string }>("get_config", {});
      return send(200, { ok: true, vault: c.vault_id, clock_mode: c.clock_mode });
    }

    send(404, { error: `no such endpoint: ${url.pathname}` });
  } catch (e) {
    send(500, { error: (e as Error).message });
  }
});

server.listen(env.port, () => {
  console.log(`float-adapter -> ${env.vault} on ${env.rpcUrl}`);
  console.log(`listening on http://127.0.0.1:${env.port}`);
  console.log(`point the dashboard at it: NEXT_PUBLIC_FLOAT_API_URL=http://127.0.0.1:${env.port}`);
  console.log(`token ${env.token} (${env.decimals} decimals), 1 unit = ${fromBaseUnits(10n ** BigInt(env.decimals), env.decimals)}`);
});

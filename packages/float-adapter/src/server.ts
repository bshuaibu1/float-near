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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toBaseUnits, fromBaseUnits } from "@near-vault/mcp/amounts";
import { newRequestId, viewAccessKeys, viewFunction } from "@near-vault/mcp";
import { buildRoute, sendRequestPayment, type RouteArg } from "@near-vault/mcp/sign";
import { getQuote, signBinding, toBase64 } from "@near-vault/mcp/quote";
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
import { AgentSelectionError, loadKeyring, selectAgent } from "./keyring.js";
import { BlockedFollower, createRpc, emptyStore, type BlockedStore } from "./blocked-scan.js";

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
  // Where the relayer records Base deliveries. Read fresh on each request so a
  // delivery that lands while this server is running appears without a
  // restart — the file is small and this is a dashboard, not a hot path.
  relayLedger: process.env.RELAY_LEDGER ?? ".demo/relay-ledger.json",
  // Refusals recovered from chain by scripts/scan-blocked.mjs.
  blockedLog: process.env.BLOCKED_LOG ?? ".demo/blocked-log.json",
  // Several agents, so the payment path can exercise the hierarchy the
  // dashboard draws. This is the file create-float writes.
  agentKeysPath: process.env.NEAR_VAULT_AGENT_KEYS ?? ".float/agent-keys.json",
  // Follow the chain for refusals. On by default: a refusal is never stored
  // in contract state, so without this the only ones the dashboard can show
  // are those this process happened to witness itself.
  followBlocked: process.env.BLOCKED_FOLLOW !== "0",
  followIntervalMs: Number(process.env.BLOCKED_FOLLOW_INTERVAL_MS ?? "10000"),
  // Binds a payee to a one-time deposit address for the cross-chain rail.
  // Absent by default: whoever holds it can redirect any Intents payment the
  // budget allows, so it is opt-in and belongs to the operator.
  quoteSignerKey: process.env.FLOAT_QUOTE_SIGNER_KEY,
};

const keyring = loadKeyring(env);

/**
 * JSON-RPC for the follower's block and chunk calls, with pacing and backoff.
 *
 * Deliberately not a bare fetch. Public endpoints rate-limit, and without
 * retries every transient 429 became a PERMANENT gap in the coverage map,
 * because a block that could not be read is recorded as unread. One load test
 * left 33 fragmented holes of three to twenty blocks each — every one
 * technically honest, and collectively useless, since nobody is going to
 * backfill a five-block gap. A hole should mean "genuinely unavailable", not
 * "the endpoint was briefly busy".
 */
const rpc = createRpc(env.rpcUrl, {
  onThrottle: (ms) => console.log(`[blocked-follow] rate-limited, waiting ${ms}ms`),
});

function loadBlockedStore(): BlockedStore {
  try {
    if (!existsSync(env.blockedLog)) return emptyStore(env.vault);
    const parsed = JSON.parse(readFileSync(env.blockedLog, "utf8"));
    return {
      vault: parsed.vault ?? env.vault,
      scannedFrom: parsed.scannedFrom ?? null,
      scannedTo: parsed.scannedTo ?? null,
      holes: Array.isArray(parsed.holes) ? parsed.holes : [],
      blocked: parsed.blocked ?? {},
    };
  } catch {
    // A corrupt file must not stop the server, and must not be mistaken for
    // "no refusals" — a null cursor makes the follower restart from the head
    // rather than claim coverage it does not have.
    return emptyStore(env.vault);
  }
}

function saveBlockedStore(s: BlockedStore): void {
  mkdirSync(dirname(env.blockedLog), { recursive: true });
  writeFileSync(env.blockedLog, JSON.stringify(s, null, 2) + "\n");
}

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

  // A missing or malformed ledger yields NO deliveries, never a crash and
  // never an invented one: the worst it can do is under-report delivery, which
  // is the safe direction for a claim the chain cannot back.
  // Chain-recovered refusals, re-read per request so a scan that runs while
  // the server is up appears without a restart. A missing or malformed file
  // yields none rather than crashing — the failure direction is always to
  // show fewer refusals than happened, never to invent one.
  {
    const parsed = (() => {
      try {
        if (!existsSync(env.blockedLog)) return null;
        return JSON.parse(readFileSync(env.blockedLog, "utf8"));
      } catch {
        return null;
      }
    })();
    cfg.chainBlocked = parsed?.blocked ?? {};
    cfg.blockedScan =
      parsed && typeof parsed.scannedFrom === "number" && typeof parsed.scannedTo === "number"
        ? {
            from: parsed.scannedFrom,
            to: parsed.scannedTo,
            // Without these the range is a claim about blocks nobody read.
            holes: Array.isArray(parsed.holes) ? parsed.holes : [],
          }
        : null;
  }

  cfg.deliveries = (() => {
    try {
      if (!existsSync(env.relayLedger)) return {};
      return JSON.parse(readFileSync(env.relayLedger, "utf8"));
    } catch {
      return {};
    }
  })();

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
      const body = await new Promise<string>((ok) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => ok(b));
      });
      const {
        amount,
        recipient,
        memo = "",
        agent,
        nodeId,
        rail = "near",
        destinationAsset,
      } = JSON.parse(body || "{}") as {
        amount: string;
        recipient: string;
        memo?: string;
        agent?: string;
        nodeId?: number;
        rail?: "near" | "intents";
        destinationAsset?: string;
      };

      // WHICH agent signs decides WHICH budget is charged — the contract
      // resolves the node from the signer, not from the request body. So a
      // bad selection is a 400, never a quietly-redirected payment.
      let creds;
      try {
        creds = selectAgent(keyring, { agent, nodeId });
      } catch (e) {
        if (e instanceof AgentSelectionError) return send(400, { error: e.message });
        throw e;
      }

      // ---- Cross-chain, if asked for.
      //
      // `amount` means what the PAYEE receives. For the intents rail what
      // actually leaves the vault is the quote's amountIn — fees included —
      // and that is the figure the budget tree is charged, so the hierarchy
      // governs real outflow rather than a nominal number.
      const requestId = newRequestId();
      let route: RouteArg = "near_direct";
      let amountIn = toBaseUnits(amount, env.decimals);

      if (rail === "intents") {
        if (!env.quoteSignerKey) {
          // Deliberately a 400 with the reason, not a silent fallback to the
          // NEAR rail. Quietly paying on the wrong chain would look like
          // success and leave the payee unpaid.
          return send(400, {
            error:
              "rail=intents requires FLOAT_QUOTE_SIGNER_KEY (32-byte hex). That key " +
              "binds a payee to a one-time deposit address, so it belongs to the vault " +
              "operator. Without it the cross-chain rail is closed.",
          });
        }
        try {
          const deadline = new Date(Date.now() + 20 * 60 * 1000);
          const q = await getQuote({
            amountOut: toBaseUnits(amount, env.decimals),
            payee: recipient,
            refundTo: env.vault,
            destinationAsset,
            deadline,
          });
          amountIn = q.amountIn;
          const sk = Uint8Array.from(Buffer.from(env.quoteSignerKey.replace(/^0x/, ""), "hex"));
          route = buildRoute("intents", {
            depositAddress: q.depositAddress,
            quoteDeadlineNs: q.deadlineNs.toString(),
            signature: toBase64(
              signBinding(
                {
                  vault: env.vault,
                  requestId,
                  token: env.token,
                  amount: q.amountIn,
                  payee: recipient,
                  depositAddress: q.depositAddress,
                  deadlineNs: q.deadlineNs,
                },
                sk,
              ),
            ),
          });
        } catch (e) {
          return send(502, { error: `quote failed: ${(e as Error).message}` });
        }
      }

      const outcome = (await sendRequestPayment({
        rpcUrl: env.rpcUrl,
        vault: env.vault,
        agentId: creds.agentId,
        agentKey: creds.secret,
        requestId,
        token: env.token,
        amount: amountIn,
        recipient,
        memo,
        gasTgas: 100,
        route,
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

// ---- Follow the chain for refusals.
//
// Refusals live only in NEP-297 events, so an adapter that does not watch the
// chain can only ever show the ones it personally caused. Started before
// listening so the first dashboard request already has a cursor.
if (env.followBlocked) {
  const follower = new BlockedFollower({
    rpc,
    vault: env.vault,
    load: loadBlockedStore,
    save: saveBlockedStore,
    intervalMs: env.followIntervalMs,
    onTick: ({ from, to, added, holes }) => {
      // Silent when there is nothing to say; a per-tick line every 10s would
      // bury anything that matters.
      if (added || holes) {
        console.log(
          `[blocked-follow] blocks ${from}..${to}  +${added} refusal(s)` +
            (holes ? `  ${holes} unreadable block(s)` : ""),
        );
      }
    },
    onSkip: ({ from, to }) => {
      console.warn(
        `[blocked-follow] BACKLOG TOO LARGE — blocks ${from}..${to} ` +
          `(${to - from + 1}) were NOT scanned and are recorded as a gap. ` +
          `Refusals in that span are unknown, not absent. ` +
          `Fill it with: node scripts/scan-blocked.mjs --from ${from}`,
      );
    },
  });
  follower.start();
  const shutdown = () => follower.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

server.listen(env.port, () => {
  console.log(`float-adapter -> ${env.vault} on ${env.rpcUrl}`);
  console.log(`listening on http://127.0.0.1:${env.port}`);
  console.log(`point the dashboard at it: NEXT_PUBLIC_FLOAT_API_URL=http://127.0.0.1:${env.port}`);
  console.log(`token ${env.token} (${env.decimals} decimals), 1 unit = ${fromBaseUnits(10n ** BigInt(env.decimals), env.decimals)}`);
});

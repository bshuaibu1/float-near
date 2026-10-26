/**
 * Read path and small helpers.
 *
 * Views go over raw JSON-RPC rather than through a client library, for one
 * reason that matters: they need NO key. The server is fully useful with zero
 * secrets configured — reads and payload planning work, and only `vault_pay`
 * requires an agent key. Keeping the read path dependency-free means a
 * misconfigured or absent key cannot break it.
 */

import { randomUUID } from "node:crypto";

export const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";

export function encodeArgs(args: unknown): string {
  // Explicit utf8: a memo is free text, goes on-chain, and a latin-1
  // truncation here would corrupt it silently.
  return Buffer.from(JSON.stringify(args), "utf8").toString("base64");
}

interface RawViewResponse {
  result?: number[];
  error?: unknown;
}

/**
 * Decode a `call_function` response.
 *
 * NEAR returns the value as an array of byte values. The failure mode worth
 * guarding is an error shape that decodes to nothing: `undefined` reads as "no
 * data" when it actually means "the call failed", and a caller would treat an
 * exhausted budget and a broken RPC identically.
 */
export function decodeViewResult<T = unknown>(res: RawViewResponse): T {
  if (res.error !== undefined && res.error !== null) {
    const e = res.error as { message?: string; data?: unknown };
    const detail =
      typeof res.error === "string"
        ? res.error
        : [e.message, typeof e.data === "string" ? e.data : JSON.stringify(e.data)]
            .filter(Boolean)
            .join(": ");
    throw new Error(`view call failed: ${detail}`);
  }
  if (!Array.isArray(res.result)) {
    throw new Error(
      `unexpected RPC response: neither a result nor an error (${JSON.stringify(res).slice(0, 200)})`,
    );
  }
  return JSON.parse(Buffer.from(res.result).toString("utf8")) as T;
}

export async function viewFunction<T = unknown>(
  rpcUrl: string,
  contractId: string,
  methodName: string,
  args: unknown = {},
): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: "near-vault-mcp",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: encodeArgs(args),
    },
  };
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`RPC ${rpcUrl} returned HTTP ${r.status}`);
  const json = (await r.json()) as { result?: RawViewResponse; error?: unknown };
  if (json.error) return decodeViewResult<T>({ error: json.error });
  return decodeViewResult<T>(json.result ?? ({} as RawViewResponse));
}

/** One access key as NEAR reports it. */
export interface AccessKeyInfo {
  public_key: string;
  access_key: {
    nonce: number;
    permission:
      | "FullAccess"
      | {
          FunctionCall: {
            allowance: string | null;
            receiver_id: string;
            method_names: string[];
          };
        };
  };
}

/**
 * Every access key on an account, read from the chain.
 *
 * This exists so the UI can state the agent key restriction as an OBSERVATION
 * rather than a claim. "Restricted to request_payment" rendered from a
 * hardcoded string would stay on screen even if the key were actually
 * full-access — and that is the one thing a reader of that page most needs to
 * be true.
 */
export async function viewAccessKeys(
  rpcUrl: string,
  accountId: string,
): Promise<AccessKeyInfo[]> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-vault-mcp",
      method: "query",
      params: { request_type: "view_access_key_list", finality: "final", account_id: accountId },
    }),
  });
  if (!r.ok) throw new Error(`RPC ${rpcUrl} returned HTTP ${r.status}`);
  const json = (await r.json()) as {
    result?: { keys?: AccessKeyInfo[] };
    error?: { message?: string };
  };
  if (json.error) throw new Error(`access key list failed: ${json.error.message ?? "unknown"}`);
  return json.result?.keys ?? [];
}

export interface AgentCreds {
  agentId: string;
  agentKey: string;
}

/**
 * Both halves or neither. Failing here with the variable NAMES beats throwing a
 * TypeError three frames deeper, and beats silently signing with the wrong
 * account.
 */
export function requireAgentKey(env: { agentId?: string; agentKey?: string }): AgentCreds {
  // Name EVERY missing variable, not just the first. A message that reports
  // half the problem buys a second failed attempt.
  if (!env.agentId && !env.agentKey) {
    throw new Error(
      "Paying requires NEAR_VAULT_AGENT_ID and NEAR_VAULT_AGENT_KEY, and neither is set. " +
        "Reads and payload planning work without them; only paying needs them. " +
        "The key must be the restricted one issued by create_agent_account — never a " +
        "full-access key.",
    );
  }
  if (!env.agentId) {
    throw new Error(
      "NEAR_VAULT_AGENT_ID is not set, so there is no agent account to pay from.",
    );
  }
  if (!env.agentKey) {
    throw new Error(
      "NEAR_VAULT_AGENT_KEY is not set. This must be the restricted key issued by " +
        "create_agent_account — it can call only request_payment on the vault, cannot " +
        "call other contracts, and cannot attach a deposit. Never put a full-access key here.",
    );
  }
  return { agentId: env.agentId, agentKey: env.agentKey };
}

/**
 * A request id the contract will accept.
 *
 * `is_valid_request_id` allows 1..=64 of [A-Za-z0-9._:-]. A raw UUID is fine;
 * a timestamp with a space, or anything brace-wrapped, would be rejected
 * on-chain AFTER signing — which costs gas to learn.
 */
export function newRequestId(): string {
  return randomUUID();
}

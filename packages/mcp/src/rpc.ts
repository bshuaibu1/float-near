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

/**
 * NOT `rpc.testnet.near.org`. That endpoint now answers every request with
 * HTTP error -429 and the text "THIS ENDPOINT IS DEPRECATED! STOP USING IT
 * NOW!" — observed 2026-10-26. It fails closed for reads, which would make the
 * whole product look broken for anyone who left the default in place.
 *
 * Overridable with NEAR_VAULT_RPC_URL; providers are listed at
 * https://docs.near.org/api/rpc/providers
 */
export const DEFAULT_RPC_URL = "https://test.rpc.fastnear.com";

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

/**
 * Does this account exist on chain?
 *
 * Used before offering to CREATE a vault at a derived address. Getting this
 * wrong is not cosmetic: the create batch's first action is `CreateAccount`,
 * so offering an address that is already taken sends the user to a wallet,
 * takes their signature, and fails only after they have committed.
 *
 * Distinguishes "does not exist" from "could not tell". An RPC timeout that
 * returned `false` would read as a free address, so ONLY the specific
 * UNKNOWN_ACCOUNT answer counts as absent and anything else throws.
 */
export async function accountExists(rpcUrl: string, accountId: string): Promise<boolean> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-vault-mcp",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  if (!r.ok) throw new Error(`RPC ${r.status} checking whether ${accountId} exists`);
  const j = (await r.json()) as {
    result?: unknown;
    error?: { cause?: { name?: string }; message?: string };
  };
  if (j.result) return true;
  const name = j.error?.cause?.name;
  if (name === "UNKNOWN_ACCOUNT") return false;
  throw new Error(
    `could not determine whether ${accountId} exists: ${name ?? j.error?.message ?? "unknown error"}`,
  );
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
        }
      // NEP-611. A DISTINCT variant, and this type omitted it while gas keys
      // were already in use — so anything reading `permission` was told a gas
      // key could not appear, when every virtual agent is one. Code that
      // checked `"FunctionCall" in p` then reported a key restricted to a
      // single method on a single contract as UNRESTRICTED.
      //
      // `allowance` is null here by design: for a gas key the BALANCE is the
      // cap, and it sits at the TOP LEVEL of the variant rather than under
      // `gas_key_info` where near-api-js's own typings suggest.
      | {
          GasKeyFunctionCall: {
            allowance: string | null;
            balance: string;
            receiver_id: string;
            method_names: string[];
            num_nonces?: number;
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

/** An account's balance and storage, as the chain reports them. */
export interface AccountView {
  amount: string;
  storage_usage: number;
}

/**
 * Read an account's balance and storage.
 *
 * Both as the chain reports them: `amount` is the TOTAL, and the storage
 * stake (`storage_usage * 1e19`) is locked inside it rather than held
 * separately. Subtracting is the caller's job, and getting that backwards is
 * how a vault with 0.02 spendable looks like it has 0.12.
 */
export async function viewAccount(rpcUrl: string, accountId: string): Promise<AccountView> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "near-vault-mcp",
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  if (!r.ok) throw new Error(`RPC ${rpcUrl} returned HTTP ${r.status}`);
  const json = (await r.json()) as {
    result?: AccountView;
    error?: { message?: string };
  };
  if (json.error) throw new Error(`view_account failed: ${json.error.message ?? "unknown"}`);
  if (!json.result) throw new Error(`view_account returned no result for ${accountId}`);
  return json.result;
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
export function requireAgentKey(env: {
  agentId?: string;
  agentKey?: string;
  /**
   * Why `NEAR_VAULT_AGENT_KEY_FILE` produced no key, when one was named.
   *
   * SEPARATE FROM `agentKey` BEING ABSENT, and it must stay that way. "The
   * variable is not set" and "the file you pointed it at is broken" are
   * different problems with different fixes; reporting the second as the first
   * sends the operator to set something they have already set — and the
   * quickest way out of that dead end is pasting the key inline, which undoes
   * the reason the file option exists.
   */
  agentKeyError?: string;
  /**
   * `account_id` from a `~/.near-credentials`-shaped key file, when the key
   * came from one. Absent for an inline key or a bare key file.
   */
  agentKeyAccountId?: string;
}): AgentCreds {
  // THE FILE'S OWN FAILURE OUTRANKS EVERY "not set" MESSAGE BELOW. It is the
  // only one of them that names a cause, and once a path is involved the
  // missing-variable advice is actively misleading.
  if (!env.agentKey && env.agentKeyError) {
    throw new Error(
      `Paying needs the agent key, and the key file could not be read. ` +
        `${env.agentKeyError} Fix the path or the file — or unset the _FILE variable ` +
        `to fall back to an inline NEAR_VAULT_AGENT_KEY.`,
    );
  }
  // Name EVERY missing variable, not just the first. A message that reports
  // half the problem buys a second failed attempt.
  if (!env.agentId && !env.agentKey) {
    throw new Error(
      "Paying requires NEAR_VAULT_AGENT_ID and a key, and neither is set. " +
        "The key can be NEAR_VAULT_AGENT_KEY (inline) or NEAR_VAULT_AGENT_KEY_FILE " +
        "(a path to a ~/.near-credentials-shaped JSON file, or a bare key file) — " +
        "prefer the file, since an inline key is printed by any read of the config. " +
        "Reads and payload planning work without them; only paying needs them. " +
        "The key must be a RESTRICTED one, from a VIRTUAL AGENT — never a " +
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
      "No agent key is set: use NEAR_VAULT_AGENT_KEY_FILE (a path — preferred, since " +
        "an inline key is printed by any read of the config) or NEAR_VAULT_AGENT_KEY. " +
        "This must be a VIRTUAL AGENT's key, bound " +
        "with bind_virtual_agent and installed as a NEP-611 gas key on the vault — it can call only request_payment on the vault, cannot " +
        "call other contracts, and cannot attach a deposit. Never put a full-access key here.",
    );
  }
  /**
   * THE KEY FILE AND NEAR_VAULT_AGENT_ID MUST NAME THE SAME ACCOUNT.
   *
   * Which key signs *is* which budget is charged — the contract resolves the
   * spending node from the signer, never from the request body. So a key used
   * under the wrong account id does not get rejected locally; it goes to chain
   * and fails with NOT_VIRTUAL_AGENT, which reads as a binding bug and sends
   * the reader to the contract rather than to their config.
   *
   * No mismatch is legitimate. A virtual agent's key is a NEP-611 gas key ON
   * the vault, so it signs AS the vault, and a credentials file for it names
   * the vault. A file naming some other account holds some other account's key
   * — most often the owner's full-access one, which must never be used here.
   */
  if (env.agentKeyAccountId && env.agentKeyAccountId !== env.agentId) {
    throw new Error(
      `the key file belongs to ${env.agentKeyAccountId}, but NEAR_VAULT_AGENT_ID is ` +
        `${env.agentId}. A key signs as the account it was issued for, and the vault ` +
        `resolves the spending budget from the signer — so this pairing cannot pay. ` +
        `Point NEAR_VAULT_AGENT_ID at ${env.agentKeyAccountId}, or use the key file ` +
        `for ${env.agentId}. A virtual agent's key is a gas key ON the vault, so for ` +
        `one it is the vault's own id.`,
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

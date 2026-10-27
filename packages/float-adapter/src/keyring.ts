/**
 * Which agent signs a payment.
 *
 * The adapter used to hold exactly one agent credential, in
 * NEAR_VAULT_AGENT_ID / NEAR_VAULT_AGENT_KEY, and `POST /v1/pay` always signed
 * as that agent. The dashboard meanwhile renders the whole tree. So a vault
 * with sixteen agents showed sixteen rows and could act as one of them — and
 * the sixteen-agent demo had to bypass the product entirely and drive the CLI
 * instead.
 *
 * This matters more than it looks, because the contract resolves the spending
 * node from the SIGNER (`account_to_node`), not from anything in the request
 * body. Which key signs *is* which budget is charged. A single-key adapter
 * cannot exercise a hierarchy at all; it can only ever spend one leaf.
 *
 * On holding several keys at once: each is the restricted key from
 * `create_agent_account`, which can call only `request_payment` on its own
 * vault, cannot call other contracts, and cannot attach a deposit. The vault
 * enforces every cap regardless of who holds the key, so the blast radius of
 * the whole keyring is bounded by the tree's own limits. That is the same
 * bound as for one key, applied more times.
 */

import { readFileSync, existsSync } from "node:fs";

export interface AgentCredential {
  agentId: string;
  secret: string;
  /** Present when known; lets a caller select by node instead of account id. */
  nodeId?: number;
}

export interface Keyring {
  /** agent account id -> credential */
  byAccount: Map<string, AgentCredential>;
  /** node id -> credential */
  byNode: Map<number, AgentCredential>;
  /**
   * Used when a request names no agent. Preserves the previous single-agent
   * behaviour exactly, so existing deployments and the dashboard's own calls
   * keep working untouched.
   */
  fallback?: AgentCredential;
}

export function emptyKeyring(): Keyring {
  return { byAccount: new Map(), byNode: new Map() };
}

/**
 * Build a keyring from the singular env vars plus, optionally, the JSON file
 * `create-float` writes at `.float/agent-keys.json`:
 *
 *   [{ "nodeId": 3, "agentId": "r1.float.me.testnet", "secret": "ed25519:..." }]
 *
 * The singular env pair stays authoritative for the fallback, so adding a file
 * can never silently change which agent an un-targeted payment comes from.
 */
export function loadKeyring(env: {
  agentId?: string;
  agentKey?: string;
  agentKeysPath?: string;
}): Keyring {
  const ring = emptyKeyring();

  const add = (c: AgentCredential) => {
    ring.byAccount.set(c.agentId, c);
    if (typeof c.nodeId === "number") ring.byNode.set(c.nodeId, c);
  };

  if (env.agentKeysPath && existsSync(env.agentKeysPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(env.agentKeysPath, "utf8"));
    } catch {
      // A malformed keyring must not take the server down, and must not be
      // mistaken for an empty one. Paying with an unknown agent will fail
      // loudly at selection time with a message that lists what IS loaded.
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e && typeof e.agentId === "string" && typeof e.secret === "string") {
          add({
            agentId: e.agentId,
            secret: e.secret,
            nodeId: typeof e.nodeId === "number" ? e.nodeId : undefined,
          });
        }
      }
    }
  }

  if (env.agentId && env.agentKey) {
    const c: AgentCredential = { agentId: env.agentId, secret: env.agentKey };
    add(c);
    ring.fallback = c;
  } else if (ring.byAccount.size === 1) {
    // Exactly one key in the file and no env pair: unambiguous, so use it.
    // More than one with no env pair is deliberately NOT guessed at — see
    // selectAgent.
    ring.fallback = [...ring.byAccount.values()][0];
  }

  return ring;
}

export class AgentSelectionError extends Error {}

/**
 * Pick the credential for a payment request.
 *
 * Errors name every agent that IS available. A selection failure is almost
 * always a typo or a stale node id, and an error that says only "not found"
 * costs the caller another round trip to discover what the valid options were.
 */
export function selectAgent(
  ring: Keyring,
  want: { agent?: string; nodeId?: number } = {},
): AgentCredential {
  const known = () => {
    const list = [...ring.byAccount.values()].map(
      (c) => `${c.agentId}${typeof c.nodeId === "number" ? ` (node ${c.nodeId})` : ""}`,
    );
    return list.length ? list.join(", ") : "none";
  };

  if (want.agent !== undefined) {
    const c = ring.byAccount.get(want.agent);
    if (!c) {
      throw new AgentSelectionError(
        `no key for agent '${want.agent}'. Loaded agents: ${known()}.`,
      );
    }
    return c;
  }

  if (want.nodeId !== undefined) {
    const c = ring.byNode.get(want.nodeId);
    if (!c) {
      throw new AgentSelectionError(
        `no key bound to node ${want.nodeId}. Loaded agents: ${known()}. ` +
          `Node ids come from the keyring file; a key added via ` +
          `NEAR_VAULT_AGENT_ID alone has no node id attached.`,
      );
    }
    return c;
  }

  if (ring.fallback) return ring.fallback;

  if (ring.byAccount.size > 1) {
    // Refuse rather than guess. Picking arbitrarily would charge a budget the
    // caller did not choose, and the payment would succeed — so the mistake
    // would surface later as a confusing balance, not as an error.
    throw new AgentSelectionError(
      `several agents are loaded and the request named none, so there is no ` +
        `safe default. Pass "agent" or "nodeId". Loaded agents: ${known()}.`,
    );
  }

  throw new AgentSelectionError(
    "no agent credentials are configured. Set NEAR_VAULT_AGENT_ID and " +
      "NEAR_VAULT_AGENT_KEY, or point NEAR_VAULT_AGENT_KEYS at the " +
      "agent-keys.json written by create-float.",
  );
}

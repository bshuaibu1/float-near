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
 * a virtual agent's NEP-611 gas key, which can call only `request_payment` on its own
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
  /**
   * A human name for this agent — "marketing", "news".
   *
   * THE ONLY IDENTIFIER THAT IS ACTUALLY UNIQUE PER AGENT once agents are
   * virtual. `agentId` is the account a key signs AS, and a virtual agent's
   * key is a gas key ON THE VAULT, so every agent on one vault shares it.
   * `nodeId` is unique but is a number nobody wants to quote.
   */
  role?: string;
}

export interface Keyring {
  /**
   * agent account id -> credential.
   *
   * LOSSY FOR VIRTUAL AGENTS, deliberately kept for compatibility. Every
   * agent on one vault has the same `agentId`, so this map holds only the
   * last one loaded. Use `all` for anything that counts agents and `byRole`
   * or `byNode` to select one.
   */
  byAccount: Map<string, AgentCredential>;
  /** node id -> credential */
  byNode: Map<number, AgentCredential>;
  /** role name -> credential */
  byRole: Map<string, AgentCredential>;
  /**
   * Every credential loaded, in file order.
   *
   * The ONLY honest count. Ambiguity used to be judged by `byAccount.size`,
   * which collapses virtual agents onto one key — so two agents read as
   * "exactly one, unambiguous" and an un-targeted payment silently signed
   * with whichever was written last, charging the wrong node. Measured
   * 2026-11-03: a two-agent file produced `byAccount.size === 1`.
   */
  all: AgentCredential[];
  /**
   * How many file entries were skipped because they belong to a different
   * vault. Zero unless `vault` was passed to `loadKeyring`.
   *
   * Surfaced rather than discarded: "no agents configured" and "three agents
   * configured, none of them for this vault" look identical from an empty
   * ring, and the second is a pointing error the operator can fix in
   * seconds once told.
   */
  skippedOtherVault: number;
  /**
   * Used when a request names no agent. Preserves the previous single-agent
   * behaviour exactly, so existing deployments and the dashboard's own calls
   * keep working untouched.
   */
  fallback?: AgentCredential;
}

export function emptyKeyring(): Keyring {
  return { byAccount: new Map(), byNode: new Map(), byRole: new Map(), all: [], skippedOtherVault: 0 };
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
  /**
   * The vault this adapter serves. When given, credentials belonging to a
   * DIFFERENT vault are skipped.
   *
   * The keyring file is per-machine, not per-vault: one `.float/agent-keys.json`
   * accumulates every agent ever provisioned here. Without this filter an
   * adapter serving vault A also loads vault B's agents, which goes wrong in
   * two ways.
   *
   * Loudly, if there are several: `selectAgent` refuses an un-targeted payment
   * and lists agents that are not even on this vault, so the error names
   * options that could never have worked.
   *
   * QUIETLY, if there is exactly one: `all.length === 1` makes a credential
   * for an unrelated vault the FALLBACK. Every un-targeted payment is then
   * signed by a key the contract has never heard of — it fails on chain with
   * NOT_VIRTUAL_AGENT, which reads like a binding bug rather than a
   * configuration one, and sends the reader looking in the wrong place.
   *
   * Observed 2026-11-03: an adapter on work12-testnet-fleet loaded
   * rudeisland4178's agent and named it in a refusal.
   */
  vault?: string;
}): Keyring {
  const ring = emptyKeyring();

  const add = (c: AgentCredential) => {
    ring.all.push(c);
    ring.byAccount.set(c.agentId, c);
    if (typeof c.nodeId === "number") ring.byNode.set(c.nodeId, c);
    if (c.role) ring.byRole.set(c.role, c);
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
          // A credential for ANOTHER vault is not this adapter's to use.
          // Counted rather than dropped in silence, so a keyring that looks
          // empty can be told apart from one whose entries all belong
          // elsewhere — those are different problems with different fixes.
          if (env.vault && e.agentId !== env.vault) {
            ring.skippedOtherVault += 1;
            continue;
          }
          add({
            agentId: e.agentId,
            secret: e.secret,
            nodeId: typeof e.nodeId === "number" ? e.nodeId : undefined,
            role: typeof e.role === "string" && e.role ? e.role : undefined,
          });
        }
      }
    }
  }

  if (env.agentId && env.agentKey) {
    const c: AgentCredential = { agentId: env.agentId, secret: env.agentKey };
    add(c);
    ring.fallback = c;
  } else if (ring.all.length === 1) {
    // Exactly one credential and no env pair: unambiguous, so use it.
    //
    // `all.length`, NOT `byAccount.size`. Every virtual agent on a vault
    // shares an `agentId`, so the map collapses them and two agents read as
    // one — which made this branch fire on an ambiguous keyring and pick
    // whichever was written last. Silently: the payment succeeded, against
    // the wrong node's budget.
    ring.fallback = ring.all[0];
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
  want: { agent?: string; nodeId?: number; role?: string } = {},
): AgentCredential {
  // Lists `all`, not `byAccount.values()`. The map holds one entry per
  // ACCOUNT, so on a fleet it named a single agent while several were
  // loaded — an error message that under-reports the thing it exists to
  // report.
  const known = () => {
    const list = ring.all.map((c) => {
      const bits = [c.role, typeof c.nodeId === "number" ? `node ${c.nodeId}` : null].filter(
        Boolean,
      );
      return bits.length ? `${c.agentId} (${bits.join(", ")})` : c.agentId;
    });
    return list.length ? list.join(", ") : "none";
  };

  if (want.role !== undefined) {
    const c = ring.byRole.get(want.role);
    if (!c) {
      const roles = ring.all.map((x) => x.role).filter(Boolean);
      throw new AgentSelectionError(
        `no key for role '${want.role}'. Known roles: ${roles.length ? roles.join(", ") : "none"}. ` +
          `Loaded agents: ${known()}.`,
      );
    }
    return c;
  }

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

  if (ring.all.length > 1) {
    // Refuse rather than guess. Picking arbitrarily would charge a budget the
    // caller did not choose, and the payment would succeed — so the mistake
    // would surface later as a confusing balance, not as an error.
    //
    // `all.length`, NOT `byAccount.size`. This guard was unreachable for a
    // fleet of virtual agents: they share an `agentId`, the map held one, and
    // `loadKeyring` had already installed the last-written one as `fallback`
    // on the way past. The refusal below never fired and the wrong agent paid.
    throw new AgentSelectionError(
      `several agents are loaded and the request named none, so there is no ` +
        `safe default. Pass "role", "agent" or "nodeId". Loaded agents: ${known()}.`,
    );
  }

  // "NOTHING CONFIGURED" AND "NOTHING FOR THIS VAULT" ARE DIFFERENT PROBLEMS.
  // Both leave an empty ring, and the generic message sends someone to add
  // credentials they already have — when the real fix is pointing the adapter
  // at the vault those credentials belong to.
  if (ring.skippedOtherVault > 0) {
    throw new AgentSelectionError(
      `no agent credentials for this vault. ${ring.skippedOtherVault} credential(s) ` +
        `were loaded but belong to a DIFFERENT vault, so they were skipped — a key ` +
        `bound to another vault cannot spend here. Check NEAR_VAULT_CONTRACT points ` +
        `at the vault you mean, or provision an agent for it with vault_add_role.`,
    );
  }

  throw new AgentSelectionError(
    "no agent credentials are configured. Set NEAR_VAULT_AGENT_ID and " +
      "NEAR_VAULT_AGENT_KEY, or point NEAR_VAULT_AGENT_KEYS at the " +
      "agent-keys.json written by create-float.",
  );
}

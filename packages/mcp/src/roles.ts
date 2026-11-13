/**
 * Picking which agent in a fleet signs a payment.
 *
 * WHICH KEY SIGNS *IS* WHICH BUDGET IS CHARGED — the contract resolves the
 * spending node from the signer (`pubkey_to_node`), never from the request
 * body. So a wrong choice here does not fail; it succeeds against another
 * agent's budget and shows up later as a balance nobody can explain.
 *
 * This reads the SAME file the adapter reads, and accepts the same entry
 * shape, because two readers of one keyring that disagree about what counts
 * as a credential is how an agent ends up "configured" and unreachable.
 */
import { existsSync, readFileSync } from "node:fs";

export interface RoleCredential {
  agentId: string;
  agentKey: string;
  role: string;
  nodeId?: number;
}

/**
 * Entries belonging to this vault that the loader REJECTS, and why.
 *
 * `loadable` drops anything without a string `secret`, and the reasoning is
 * sound — the adapter applies the same predicate, so listing such an entry
 * would advertise an agent that can never be selected. But DROPPING IT
 * SILENTLY is the same failure this file already has a memory about: the user
 * holds a key, the tool shows nothing, and there is no way to tell "no agent"
 * from "an agent in a shape I refuse to read".
 *
 * Shapes do vary in the wild: `prove-refusal.mjs` reads
 * `privateKey ?? secret ?? agentKey`, so a file written by another path can
 * land here unreadable. Reported, not hidden.
 */
export function listUnloadable(cfg: { agentKeysPath?: string; vault?: string }): {
  reason: string;
}[] {
  const path = cfg.agentKeysPath ?? ".float/agent-keys.json";
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return [{ reason: `${path} is not readable JSON (${(e as Error).message}). A UTF-8 BOM does this.` }];
  }
  if (!Array.isArray(parsed)) return [{ reason: `${path} is not a JSON array.` }];

  const out: { reason: string }[] = [];
  for (const e of parsed as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const id = (e.agentId ?? e.vault) as string | undefined;
    // Only this vault's entries; another vault's are not this tool's business.
    if (cfg.vault && id !== cfg.vault) continue;
    if (typeof e.agentId === "string" && typeof e.secret === "string") continue; // loadable
    const has = ["secret", "privateKey", "agentKey"].filter((k) => typeof e[k] === "string");
    out.push({
      reason:
        typeof e.agentId !== "string"
          ? `an entry for this vault has no string 'agentId', so it cannot be matched to a vault.`
          : `an entry has no 'secret' field${has.length ? ` (it uses '${has.join("', '")}' instead)` : ""}, ` +
            `which is the only field the keyring loader reads. It will never be selectable. ` +
            `Re-create the agent with vault_add_role.`,
    });
  }
  return out;
}

/** Entries that `loadKeyring` would accept, nothing else. */
function loadable(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // THE SAME PREDICATE THE ADAPTER USES. An entry failing it is skipped there
  // in total silence, so listing it here would advertise an agent that can
  // never be selected.
  return parsed.filter(
    (e) => e && typeof e.agentId === "string" && typeof e.secret === "string",
  );
}

/**
 * Keyring entries belonging to THIS vault.
 *
 * A credential's `agentId` IS the vault account it was issued for. Nothing
 * filtered on it, so every function here operated on the whole file — every
 * vault the user has ever created, on either network.
 *
 * Measured 2026-11-10 against a mainnet vault: `vault_roles` listed
 * `rudeisland4178-testnet.fac.floatv4.testnet` and
 * `work12-testnet-fleet.fac.floatv4.testnet` as that vault's agents. Both are
 * TESTNET accounts from earlier experiments, and neither has any relationship
 * to the configured mainnet vault.
 *
 * `vault_roles` listing them is a display bug. `selectRole` was worse: asked
 * for role "root" it would hand `vault_pay` the testnet fleet key to sign a
 * MAINNET payment. That fails at the chain — the key is not on the vault — but
 * the tool chose a credential from a different network and the error arrives
 * with no hint of why.
 *
 * `vault` empty means nothing is configured, so there is nothing to scope to
 * and every entry is returned. That is the `vault_create` case, where the
 * server legitimately runs with no vault at all.
 */
function forVault(
  cfg: { agentKeysPath?: string; vault?: string },
): Record<string, unknown>[] {
  const entries = loadable(cfg.agentKeysPath ?? ".float/agent-keys.json");
  if (!cfg.vault) return entries;
  return entries.filter((e) => e.agentId === cfg.vault);
}

export class RoleSelectionError extends Error {}

export function selectRole(
  cfg: { agentKeysPath?: string; vault?: string },
  role: string,
): { agentId: string; agentKey: string } {
  const path = cfg.agentKeysPath ?? ".float/agent-keys.json";
  // SCOPED. A role name is not unique across vaults — "root" exists in every
  // one — so an unscoped lookup picks whichever was written first.
  const entries = forVault(cfg);
  const known = entries
    .map((e) => (typeof e.role === "string" ? e.role : null))
    .filter(Boolean) as string[];

  const hit = entries.find((e) => e.role === role);
  if (!hit) {
    throw new RoleSelectionError(
      `no agent with role '${role}' in ${path}. ` +
        `Known roles: ${known.length ? known.join(", ") : "none"}. ` +
        (entries.length && !known.length
          ? `${entries.length} credential(s) are loaded but none carries a role — ` +
            `they predate roles, so select them by nodeId or add a "role" field.`
          : `Add one with vault_add_role.`),
    );
  }
  return { agentId: hit.agentId as string, agentKey: hit.secret as string };
}

/** Every role that could actually sign, for listing back to a caller. */
export function listRoles(cfg: { agentKeysPath?: string; vault?: string }): RoleCredential[] {
  return forVault(cfg)
    .filter((e) => typeof e.role === "string")
    .map((e) => ({
      agentId: e.agentId as string,
      agentKey: e.secret as string,
      role: e.role as string,
      nodeId: typeof e.nodeId === "number" ? e.nodeId : undefined,
    }));
}

/**
 * EVERY credential in the keyring, named or not.
 *
 * `listRoles` filters to entries carrying a `role`, which is right for
 * SELECTION — you cannot pick by a name that does not exist. It is wrong for
 * REPORTING, and `vault_roles` used it for reporting.
 *
 * `vault_create({ bindAgent: true })` calls `generateAgentKey({ vault })` with
 * no role, so `JSON.stringify` drops the field and the entry is invisible to
 * `listRoles`. Measured 2026-11-10: a vault with a funded, correctly-pinned
 * gas key and a live agent node reported `vault_roles` -> `[]`, which reads as
 * "you have no agents" rather than "you have one with no name". The user then
 * cannot tell an empty keyring from a working unnamed agent, and the obvious
 * next move — bind another — is the wrong one.
 *
 * Returns `role: null` for those rather than inventing a name, because the
 * name is genuinely absent and the fix is `vault_add_role`, not a guess.
 */
export function listAgents(cfg: { agentKeysPath?: string; vault?: string }): {
  agentId: string;
  role: string | null;
  nodeId?: number;
  /**
   * THE PUBLIC half, so a caller can ask the CHAIN about this key.
   *
   * It was omitted, and that omission is what made `vault_roles` unable to
   * tell a working agent from a dead one: with no public key there is nothing
   * to look up, so the only thing it could report was what the local file
   * claimed. No key material — the public key is public.
   */
  publicKey?: string;
}[] {
  return forVault(cfg).map((e) => ({
    agentId: e.agentId as string,
    role: typeof e.role === "string" ? e.role : null,
    nodeId: typeof e.nodeId === "number" ? e.nodeId : undefined,
    publicKey: typeof e.publicKey === "string" ? e.publicKey : undefined,
  }));
}

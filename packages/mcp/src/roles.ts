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

export class RoleSelectionError extends Error {}

export function selectRole(
  cfg: { agentKeysPath?: string },
  role: string,
): { agentId: string; agentKey: string } {
  const path = cfg.agentKeysPath ?? ".float/agent-keys.json";
  const entries = loadable(path);
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
export function listRoles(cfg: { agentKeysPath?: string }): RoleCredential[] {
  return loadable(cfg.agentKeysPath ?? ".float/agent-keys.json")
    .filter((e) => typeof e.role === "string")
    .map((e) => ({
      agentId: e.agentId as string,
      agentKey: e.secret as string,
      role: e.role as string,
      nodeId: typeof e.nodeId === "number" ? e.nodeId : undefined,
    }));
}

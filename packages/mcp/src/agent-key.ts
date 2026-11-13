/**
 * Generating and storing the agent's key for one-signature onboarding.
 *
 * This is the ONE place `vault_create` stops being keyless, and the departure
 * is deliberate but narrow: the key generated here is the AGENT's, never the
 * owner's. An agent key can call exactly `request_payment` on one vault, is
 * bounded by the budget tree, and cannot attach a deposit — so the worst a
 * leaked copy does is spend inside limits the owner already set. The owner's
 * full-access key still never comes near this server.
 *
 * THE SECRET NEVER GOES TO THE CALLER. It is written to disk and only the
 * public half is returned. That is not a style preference: this session's own
 * transcript acquired one private key from a screenshot and another from a
 * config dump, and a tool response is a transcript entry forever. The agent
 * calling `vault_create` has filesystem access to the same machine, so a path
 * is strictly more useful to it than a string anyway.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

import { KeyPair } from "near-api-js";

/**
 * The node a creation-time agent is bound to.
 *
 * ONE, NOT ZERO, SINCE 2026-11-08. `new` used to bind at ROOT_NODE because it
 * was the only node that existed — which left the FIRST agent holding the
 * whole vault budget while every agent added later through `add_role` got a
 * child of its own. The hierarchy only began constraining from agent #2.
 *
 * `new` now creates the agent its own child of root, carrying the same limits,
 * exactly as `add_role` does. Root is 0 and that child is the first node
 * inserted after it, so the agent is 1.
 *
 * PREDICTED, NOT READ, and that is unavoidable: the credential is generated
 * before the vault exists, so there is nothing to ask. It is pinned by
 * `binding_at_init_matches_binding_afterwards` in the contract, which asserts
 * the node is 1 and not 0 — if `new` ever inserts another node first, that
 * test fails rather than this constant drifting in silence.
 */
export const AGENT_NODE_ID = 1;

export interface GeneratedAgentKey {
  publicKey: string;
  /** The role this credential was filed under, when one was given. */
  role?: string;
  /** Where the secret was written. The secret itself is deliberately absent. */
  keyringPath: string;
  envPath: string;
  /** A prior keyring that was moved aside, if any. */
  backedUpTo?: string;
}

/**
 * Write the agent's credential where the adapter will actually find it.
 *
 * THE SHAPE MATTERS MORE THAN THE PATH. `loadKeyring` in
 * packages/float-adapter/src/keyring.ts accepts an entry only when it has a
 * string `agentId` and a string `secret`:
 *
 *     if (e && typeof e.agentId === "string" && typeof e.secret === "string")
 *
 * Anything else is skipped in silence — no warning, no error, the file simply
 * contributes nothing. `float-agent.mjs` writes
 * `{kind, vault, node, publicKey, privateKey}` into this same file, which that
 * condition rejects on both counts. So the convenient-looking shape is the
 * dead one, and this writes the shape that loads.
 *
 * `agentId` is the VAULT, not a separate account. A virtual agent has no
 * account of its own: its key is a NEP-611 gas key installed ON the vault, so
 * the account it signs as is the vault itself — which is also why
 * `NEAR_VAULT_AGENT_ID` is set to a vault id in `.mcp.json`.
 */
export function generateAgentKey(opts: {
  vault: string;
  dir?: string;
  /**
   * The exact keyring file to write, overriding `dir` and the hardcoded
   * `agent-keys.json` filename.
   *
   * WHY IT HAS TO EXIST. The caller configures a keyring by full PATH
   * (`NEAR_VAULT_AGENT_KEYS`), and this function used to accept only a
   * directory and append a fixed filename. So pinning the keyring to, say,
   * `~/keys/fleet.json` meant the server READ `fleet.json` and WROTE
   * `~/keys/agent-keys.json` — a brand new agent, filed where nothing would
   * ever look for it, reported as success. Silent, and exactly the "written
   * somewhere you are not reading" failure this module is supposed to prevent.
   *
   * Caught by the smoke test that pins a non-default filename, not by a unit
   * test: every unit test here passes a directory.
   */
  keyringPath?: string;
  /**
   * The node this agent spends from.
   *
   * `null` means NOT YET KNOWN, and is written as an absent field rather
   * than a guess. `add_role` creates the node inside the contract, so its id
   * does not exist until the transaction lands — and a client cannot read
   * one action's return value from the same transaction.
   *
   * A WRONG NODE ID IS WORSE THAN NONE. Defaulting to 0 filed the first
   * `add_role` agent against the ROOT node while the contract had assigned
   * it node 1: `byNode.get(1)` missed it entirely, and `byNode.get(0)`
   * returned it under the root's name. Selection by role still worked, so
   * nothing failed loudly. `loadKeyring` treats a missing `nodeId` as
   * "selectable by role only", which is exactly the truth here.
   *
   * Omitted entirely still means ROOT, which is correct for the agent bound
   * at vault creation — that one genuinely is node 0.
   */
  nodeId?: number | null;
  /**
   * A human name for this agent — "marketing", "news".
   *
   * THE ONLY UNIQUE IDENTIFIER once a vault has several agents. `agentId` is
   * the account the key signs as, which for every virtual agent on one vault
   * is the SAME vault, so a keyring indexed by it collapses them and the
   * last one written silently wins.
   */
  role?: string;
}): GeneratedAgentKey {
  // `undefined` -> root (the creation-time agent). `null` -> unknown, and the
  // field is omitted rather than guessed.
  const nodeId = opts.nodeId === null ? undefined : (opts.nodeId ?? AGENT_NODE_ID);

  // An explicit path wins and decides the directory; otherwise the old
  // dir-plus-fixed-filename behaviour, unchanged.
  const keyringPath = opts.keyringPath ?? join(opts.dir ?? ".float", "agent-keys.json");
  const dir = dirname(keyringPath);
  const envPath = join(dir, "agent.env");

  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  const secret = kp.toString();

  mkdirSync(dir, { recursive: true });

  // APPEND, NEVER REPLACE. A vault may have several agents, and more to the
  // point: overwriting would destroy the credential of an agent that is
  // already bound on chain and working. An on-chain binding cannot be undone
  // by deleting a file, so a lost secret is a permanently stranded agent.
  let existing: unknown[] = [];
  let backedUpTo: string | undefined;
  if (existsSync(keyringPath)) {
    try {
      const parsed = JSON.parse(readFileSync(keyringPath, "utf8"));
      if (Array.isArray(parsed)) existing = parsed;
      else throw new Error("not an array");
    } catch {
      // A malformed keyring must not be parsed into oblivion. Move it aside
      // rather than overwrite it — whatever is in there may be the only copy
      // of a working secret, and this is not the moment to decide it is junk.
      backedUpTo = `${keyringPath}.unreadable-${publicKey.slice(8, 16)}`;
      copyFileSync(keyringPath, backedUpTo);
      existing = [];
    }
  }

  existing.push({
    agentId: opts.vault,
    secret,
    publicKey,
    role: opts.role,
    // Only when known. `JSON.stringify` drops an undefined value, so an
    // unknown node leaves no field at all — which is what `loadKeyring`
    // reads as "selectable by role, not by node".
    ...(typeof nodeId === "number" ? { nodeId } : {}),
  });
  writeFileSync(keyringPath, JSON.stringify(existing, null, 2) + "\n");

  // The env form the MCP server itself reads. Written second and separately
  // because it holds ONE agent, while the keyring holds every agent — so the
  // keyring is the durable record and this is a convenience.
  writeFileSync(
    envPath,
    [
      `# Written by vault_create. Points at the keyring; holds NO key itself.`,
      `# The agent can only call request_payment on this vault, inside its budget.`,
      `NEAR_VAULT_AGENT_ID=${opts.vault}`,
      // A PATH, NOT THE SECRET. This file used to carry the key inline, so a
      // `cat` to check which vault was configured printed a live private key
      // into scrollback and into the driving agent's transcript. The keyring
      // beside it is the durable record and `readKeyFile` now reads that shape,
      // so naming it twice bought nothing except a second place to leak from.
      `NEAR_VAULT_AGENT_KEY_FILE=${keyringPath}`,
      ``,
    ].join("\n"),
  );

  // Best effort. Windows ignores POSIX modes, so this must not be load-bearing
  // — the real protection is that the key is restricted on chain.
  for (const p of [keyringPath, envPath]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      /* not POSIX; the on-chain restriction is the actual boundary */
    }
  }

  return { publicKey, role: opts.role, keyringPath, envPath, backedUpTo };
}

/** Where the files would go, without creating anything. */
export function agentKeyPaths(dir = ".float") {
  return { keyringPath: join(dir, "agent-keys.json"), envPath: join(dir, "agent.env"), dir: dirname(join(dir, "x")) };
}

/**
 * Take a role name off a keyring entry that is PROVEN not bound on chain,
 * without destroying its secret.
 *
 * WHY THIS IS NEEDED. `generateAgentKey` appends and never replaces, for the
 * reason above: overwriting could destroy the only copy of a credential for an
 * agent that is already bound and funded. But `selectRole` resolves a role with
 * `entries.find(...)` — FIRST match wins. So an orphaned entry (a key written
 * by a `vault_add_role` that then failed to land on chain) would permanently
 * SHADOW the replacement: every future payment under that role would select a
 * key the contract answers NOT_VIRTUAL_AGENT for, and the working key beside it
 * would never be reached.
 *
 * So the orphan's role is RENAMED rather than deleted. The secret stays on
 * disk, the entry stays in the file, and the name resolves to exactly one
 * credential again. Deleting would be tidier and is not worth the risk: the
 * caller's proof of deadness is a chain read, and a chain read can be wrong
 * about a vault that is paused, migrating, or being served by a lagging RPC.
 * A renamed entry survives that mistake; a deleted one does not.
 *
 * Identified BY PUBLIC KEY, never by role alone — the whole point is that two
 * entries can share a role at this moment, and renaming the wrong one would
 * retire the live agent.
 *
 * Returns the new role name, or null if no entry matched (already retired, or
 * a keyring that moved under us) — which is not an error.
 */
export function retireRole(opts: {
  keyringPath: string;
  vault: string;
  publicKey: string;
}): { retiredTo: string } | null {
  if (!existsSync(opts.keyringPath)) return null;
  let entries: unknown[];
  try {
    const parsed = JSON.parse(readFileSync(opts.keyringPath, "utf8"));
    if (!Array.isArray(parsed)) return null;
    entries = parsed;
  } catch {
    // Unreadable is not this function's problem to fix; `generateAgentKey`
    // already backs such a file aside before writing.
    return null;
  }

  let retiredTo: string | undefined;
  for (const e of entries as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    if (e.agentId !== opts.vault) continue;
    if (e.publicKey !== opts.publicKey) continue;
    if (typeof e.role !== "string") continue;
    // A short slice of the public key keeps two retirements of the same role
    // from colliding, and keeps the name traceable back to the exact entry.
    retiredTo = `${e.role}-retired-${opts.publicKey.slice(8, 16)}`;
    e.role = retiredTo;
    // The node id, if any, was never real for an unbound key.
    delete e.nodeId;
  }
  if (!retiredTo) return null;

  writeFileSync(opts.keyringPath, `${JSON.stringify(entries, null, 2)}${String.fromCharCode(10)}`);
  return { retiredTo };
}

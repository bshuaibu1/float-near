/**
 * WHERE THE FLEET KEYRING LIVES — and why it must not be a relative path.
 *
 * THE BUG THIS EXISTS TO KILL. The default was the bare string
 * `.float/agent-keys.json`, which Node resolves against `process.cwd()`. An MCP
 * server's CWD is wherever the CLIENT was launched, which the user does not
 * choose and cannot see. So one single server entry in `~/.claude.json` became
 * a DIFFERENT keyring per directory:
 *
 *   launched from  New project\   ->  New project\.float\agent-keys.json
 *   launched from  near-vault\    ->  near-vault\.float\agent-keys.json
 *
 * Measured 2026-11-13 on this machine: `NEAR_VAULT_AGENT_KEYS` is UNSET for the
 * `float` server, so a `travel` agent key written from one directory was
 * invisible from the other. The tool reported "no agent with role 'travel'"
 * while the key sat on disk a few folders away. Nothing in the output could
 * distinguish "never created" from "created somewhere you are not looking",
 * which is the same shape as the keyring-reader disagreement `roles.ts` already
 * has a comment about.
 *
 * THE RULE. Resolution answers one question: *which file can sign for THIS
 * vault?* Not "which directory am I in".
 *
 *   1. `NEAR_VAULT_AGENT_KEYS` set  -> that, made absolute. Explicit wins; an
 *      operator who pinned a path gets the path they pinned.
 *   2. Otherwise, of the CWD keyring and the HOME keyring, the one that already
 *      holds a credential for this vault. This is the back-compat case: anyone
 *      whose keys are in a project-local `.float/` keeps working untouched.
 *   3. Otherwise HOME — `~/.float/agent-keys.json`. New keys land somewhere
 *      stable, so the NEXT session finds them whatever directory it starts in.
 *
 * Rule 3 is the actual fix. Rules 1 and 2 are there so turning it on cannot
 * strand a key that already exists.
 *
 * WHEN BOTH HOLD KEYS it is a split keyring, and picking silently would hide
 * one agent's roles behind another's. One is chosen so the tool still works,
 * and the other is RETURNED in `alsoFound` so a caller can say so out loud.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const KEYRING_FILENAME = join(".float", "agent-keys.json");

export interface ResolvedKeyring {
  /** Absolute path. Never relative — that is the whole point of this module. */
  path: string;
  /** Plain-English reason, safe to show a user. Names no secrets. */
  why: string;
  /**
   * Other keyrings that ALSO hold a credential for this vault and are not
   * being read. Empty in the normal case. Non-empty means a split keyring,
   * which a user needs told rather than silently resolved.
   */
  alsoFound: string[];
}

/**
 * How many credentials a keyring file holds for `vault`.
 *
 * Deliberately TOLERANT about the credential field name. `roles.ts` loads only
 * `secret`, but `prove-refusal.mjs` reads `privateKey ?? secret ?? agentKey`,
 * and a file written by one path must still be FOUND by this one — otherwise
 * resolution sends the user to an empty home keyring while their real keys sit
 * in a shape this function refused to count. Finding the file and loading an
 * entry out of it are different jobs; `listUnloadable` reports the second.
 *
 * Never throws, and never returns the contents. A corrupt or unreadable file
 * counts as zero; the caller is choosing a path, not validating a keyring.
 */
export function countFor(path: string, vault?: string): number {
  if (!existsSync(path)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  return (parsed as Record<string, unknown>[]).filter((e) => {
    if (!e || typeof e !== "object") return false;
    const id = e.agentId ?? e.vault;
    if (vault && id !== vault) return false;
    return ["secret", "privateKey", "agentKey"].some((k) => typeof e[k] === "string");
  }).length;
}

export function resolveKeyringPath(opts: {
  /** The raw `NEAR_VAULT_AGENT_KEYS` value, if the operator set one. */
  explicit?: string;
  vault?: string;
  /** Injectable so a test does not depend on where it was run from. */
  cwd?: string;
  home?: string;
  count?: (path: string, vault?: string) => number;
}): ResolvedKeyring {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const count = opts.count ?? countFor;

  if (opts.explicit) {
    // Resolved even when already absolute, so the returned path is normalised
    // and a relative override still cannot vary with CWD mid-session.
    const path = isAbsolute(opts.explicit) ? opts.explicit : resolve(cwd, opts.explicit);
    return { path, why: "NEAR_VAULT_AGENT_KEYS is set", alsoFound: [] };
  }

  const cwdRing = resolve(cwd, KEYRING_FILENAME);
  const homeRing = join(home, KEYRING_FILENAME);

  // Same directory: nothing to choose between, and no split to report.
  if (cwdRing === homeRing) {
    return { path: homeRing, why: "the default keyring in your home folder", alsoFound: [] };
  }

  const inCwd = count(cwdRing, opts.vault);
  const inHome = count(homeRing, opts.vault);

  if (inCwd > 0 && inHome === 0) {
    return {
      path: cwdRing,
      why: "it already holds a key for this vault",
      alsoFound: [],
    };
  }
  if (inHome > 0 && inCwd > 0) {
    return {
      path: homeRing,
      why: "it holds a key for this vault",
      // The one NOT being read. Surfaced so "my agent vanished" is answerable.
      alsoFound: [cwdRing],
    };
  }
  return {
    path: homeRing,
    why:
      inHome > 0
        ? "it already holds a key for this vault"
        : "the default keyring in your home folder, so the next session finds it from any directory",
    alsoFound: [],
  };
}

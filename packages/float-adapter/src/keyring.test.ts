import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSelectionError, loadKeyring, selectAgent } from "./keyring.js";

const dirs: string[] = [];
function keyfile(contents: unknown): string {
  const d = mkdtempSync(join(tmpdir(), "float-keyring-"));
  dirs.push(d);
  const p = join(d, "agent-keys.json");
  writeFileSync(p, typeof contents === "string" ? contents : JSON.stringify(contents));
  return p;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const KEYS = [
  { nodeId: 3, agentId: "r1.float.me.testnet", secret: "ed25519:r1secret" },
  { nodeId: 4, agentId: "r2.float.me.testnet", secret: "ed25519:r2secret" },
];

describe("choosing which agent signs", () => {
  it("selects by node id, because the node is what the budget hangs off", () => {
    // The contract resolves the spending node from the SIGNER. Selecting the
    // wrong key does not error — it charges a different agent's budget and
    // succeeds. So this mapping is the load-bearing part.
    const ring = loadKeyring({ agentKeysPath: keyfile(KEYS) });
    expect(selectAgent(ring, { nodeId: 4 }).agentId).toBe("r2.float.me.testnet");
    expect(selectAgent(ring, { nodeId: 3 }).secret).toBe("ed25519:r1secret");
  });

  it("selects by account id", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile(KEYS) });
    expect(selectAgent(ring, { agent: "r2.float.me.testnet" }).nodeId).toBe(4);
  });

  it("REFUSES to guess when several agents are loaded and none was named", () => {
    // The important one. Picking arbitrarily would charge a budget nobody
    // chose, and the payment would SUCCEED — so the mistake would surface
    // later as an inexplicable balance rather than as an error.
    const ring = loadKeyring({ agentKeysPath: keyfile(KEYS) });
    expect(() => selectAgent(ring)).toThrow(AgentSelectionError);
    expect(() => selectAgent(ring)).toThrow(/named none/);
  });

  it("keeps the old single-agent behaviour exactly", () => {
    // Existing deployments pass only the env pair and send no agent field.
    // They must keep working, and must keep using that same agent.
    const ring = loadKeyring({ agentId: "solo.testnet", agentKey: "ed25519:solo" });
    expect(selectAgent(ring).agentId).toBe("solo.testnet");
  });

  it("lets the env pair stay the default even when a keyring file is present", () => {
    // Otherwise, dropping a file next to a running adapter would silently
    // change which agent un-targeted payments come from.
    const ring = loadKeyring({
      agentKeysPath: keyfile(KEYS),
      agentId: "solo.testnet",
      agentKey: "ed25519:solo",
    });
    expect(selectAgent(ring).agentId).toBe("solo.testnet");
    expect(selectAgent(ring, { nodeId: 3 }).agentId).toBe("r1.float.me.testnet");
  });

  it("uses a lone file entry as the default, since it is unambiguous", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile([KEYS[0]]) });
    expect(selectAgent(ring).agentId).toBe("r1.float.me.testnet");
  });

  it("names the agents it does have when the requested one is missing", () => {
    // A bare "not found" costs the caller another round trip to learn what
    // the valid options were.
    const ring = loadKeyring({ agentKeysPath: keyfile(KEYS) });
    expect(() => selectAgent(ring, { agent: "typo.testnet" })).toThrow(
      /r1\.float\.me\.testnet.*r2\.float\.me\.testnet/,
    );
    expect(() => selectAgent(ring, { nodeId: 99 })).toThrow(/node 3|node 4/);
  });

  it("survives a malformed keyring file instead of taking the server down", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile("{ this is not json") });
    expect(ring.byAccount.size).toBe(0);
    // And it must not masquerade as "configured" — paying should still fail
    // loudly rather than silently doing nothing.
    expect(() => selectAgent(ring)).toThrow(/no agent credentials/);
  });

  it("ignores entries missing a secret rather than loading a useless key", () => {
    const ring = loadKeyring({
      agentKeysPath: keyfile([{ nodeId: 1, agentId: "broken.testnet" }, KEYS[0]]),
    });
    expect(ring.byAccount.has("broken.testnet")).toBe(false);
    expect(ring.byAccount.has("r1.float.me.testnet")).toBe(true);
  });
});

// =====================================================================
// Fleets: several virtual agents on ONE vault
// =====================================================================

/** Two roles on one vault — every virtual agent shares the vault's account id. */
const FLEET = [
  { role: "marketing", agentId: "v.fac.testnet", nodeId: 1, secret: "ed25519:mkt" },
  { role: "news", agentId: "v.fac.testnet", nodeId: 2, secret: "ed25519:news" },
];

describe("a fleet of virtual agents", () => {
  /**
   * THE BUG THIS CLOSES, and it was silent.
   *
   * `byAccount` is keyed on `agentId`, which for a virtual agent is the
   * VAULT — shared by every agent on it. Two agents collapsed to one entry,
   * so `loadKeyring`'s "exactly one key, unambiguous" branch fired on an
   * ambiguous keyring and installed the LAST-WRITTEN agent as the fallback.
   * An un-targeted payment then signed as the wrong agent and charged the
   * wrong node's budget — successfully, so nothing surfaced until someone
   * read a balance.
   *
   * Measured 2026-11-03 before the fix: byAccount 1, byNode 2, fallback
   * `ed25519:news`.
   */
  it("refuses to guess when the request names no agent", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile(FLEET) });
    expect(ring.all).toHaveLength(2);
    expect(ring.fallback, "a fleet must have no silent default").toBeUndefined();
    expect(() => selectAgent(ring, {})).toThrow(/several agents are loaded/i);
  });

  it("selects by role", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile(FLEET) });
    expect(selectAgent(ring, { role: "marketing" }).secret).toBe("ed25519:mkt");
    expect(selectAgent(ring, { role: "news" }).secret).toBe("ed25519:news");
  });

  /** An unknown role must name the real ones, not just fail. */
  it("names the known roles when one is missing", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile(FLEET) });
    expect(() => selectAgent(ring, { role: "sales" })).toThrow(/marketing/);
    expect(() => selectAgent(ring, { role: "sales" })).toThrow(/news/);
  });

  /**
   * The error must report EVERY agent. It listed `byAccount.values()`, which
   * on a fleet names one — under-reporting in the message whose only job is
   * to tell the caller what the options were.
   */
  it("lists every loaded agent in the ambiguity error", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile(FLEET) });
    let msg = "";
    try { selectAgent(ring, {}); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/marketing/);
    expect(msg).toMatch(/news/);
  });

  /** A single agent still has a default — the old behaviour must not change. */
  it("still defaults when there is exactly one agent", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile([FLEET[0]]) });
    expect(selectAgent(ring, {}).secret).toBe("ed25519:mkt");
  });

  /** Role-less entries still load and are still selectable by node. */
  it("keeps working for entries written before roles existed", () => {
    const ring = loadKeyring({
      agentKeysPath: keyfile([{ agentId: "v.fac.testnet", nodeId: 7, secret: "ed25519:old" }]),
    });
    expect(selectAgent(ring, { nodeId: 7 }).secret).toBe("ed25519:old");
    expect(selectAgent(ring, {}).secret).toBe("ed25519:old");
  });

  /** The env pair stays authoritative, even alongside a fleet file. */
  it("lets the env pair remain the explicit default", () => {
    const ring = loadKeyring({
      agentKeysPath: keyfile(FLEET),
      agentId: "v.fac.testnet",
      agentKey: "ed25519:env",
    });
    expect(selectAgent(ring, {}).secret).toBe("ed25519:env");
    expect(selectAgent(ring, { role: "news" }).secret).toBe("ed25519:news");
  });
});

describe("credentials belonging to another vault", () => {
  const MINE = "mine.fac.testnet";
  const THEIRS = "theirs.fac.testnet";

  /**
   * THE KEYRING FILE IS PER-MACHINE, NOT PER-VAULT. One
   * `.float/agent-keys.json` accumulates every agent ever provisioned here,
   * so an adapter serving one vault was loading every other vault's agents
   * too.
   *
   * Observed 2026-11-03: an adapter on work12-testnet-fleet listed
   * rudeisland4178's agent in a refusal — naming an option that could never
   * have worked.
   */
  it("skips them when a vault is given", () => {
    const ring = loadKeyring({
      vault: MINE,
      agentKeysPath: keyfile([
        { role: "marketing", agentId: MINE, nodeId: 1, secret: "ed25519:mkt" },
        { role: "other", agentId: THEIRS, nodeId: 1, secret: "ed25519:other" },
      ]),
    });
    expect(ring.all).toHaveLength(1);
    expect(ring.all[0].role).toBe("marketing");
    expect(ring.skippedOtherVault).toBe(1);
  });

  /**
   * THE QUIET FAILURE, and the reason this matters more than tidiness.
   *
   * With one foreign credential and no filter, `all.length === 1` made it the
   * FALLBACK — so every un-targeted payment was signed by a key the contract
   * has never heard of. That fails on chain with NOT_VIRTUAL_AGENT, which
   * reads like a binding bug and sends the reader to the wrong place
   * entirely.
   */
  it("never makes a foreign credential the default", () => {
    const ring = loadKeyring({
      vault: MINE,
      agentKeysPath: keyfile([{ role: "other", agentId: THEIRS, nodeId: 1, secret: "ed25519:x" }]),
    });
    expect(ring.fallback, "a key for another vault became the default").toBeUndefined();
    expect(() => selectAgent(ring, {})).toThrow(/different vault/i);
  });

  /**
   * And the message must distinguish the two empty-ring cases. "Nothing
   * configured" sends someone to add credentials they already have; the real
   * fix is pointing the adapter at the right vault.
   */
  it("says so, rather than reporting an empty keyring", () => {
    const foreign = loadKeyring({
      vault: MINE,
      agentKeysPath: keyfile([{ agentId: THEIRS, secret: "ed25519:x" }]),
    });
    expect(() => selectAgent(foreign, {})).toThrow(/different vault|NEAR_VAULT_CONTRACT/i);

    const genuinelyEmpty = loadKeyring({ vault: MINE, agentKeysPath: keyfile([]) });
    expect(() => selectAgent(genuinelyEmpty, {})).toThrow(/no agent credentials are configured/i);
  });

  /** Without a vault the old behaviour is untouched — nothing is filtered. */
  it("filters nothing when no vault is given", () => {
    const ring = loadKeyring({
      agentKeysPath: keyfile([
        { role: "a", agentId: MINE, secret: "ed25519:a" },
        { role: "b", agentId: THEIRS, secret: "ed25519:b" },
      ]),
    });
    expect(ring.all).toHaveLength(2);
    expect(ring.skippedOtherVault).toBe(0);
  });
});

// =====================================================================
// NEAR_VAULT_AGENT_KEY_FILE: a path instead of a plaintext env value
// =====================================================================

/** The message `resolveKeySource` hands over when the named file is unusable. */
const KEY_FILE_ERR =
  "NEAR_VAULT_AGENT_KEY_FILE: key file /etc/float/agent.json does not exist.";

function thrown(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("a key file that could not be read", () => {
  /**
   * THE THIRD MEMBER OF A FAMILY THIS MODULE ALREADY KNOWS.
   *
   * An empty ring has had two indistinguishable causes — "nothing configured"
   * and "everything belongs to another vault" — and telling them apart is why
   * `skippedOtherVault` exists at all. A broken `NEAR_VAULT_AGENT_KEY_FILE` is
   * the third, and it is the worst one to misreport: "no agent credentials are
   * configured. Set NEAR_VAULT_AGENT_ID and NEAR_VAULT_AGENT_KEY" tells the
   * operator to paste the key inline, which is precisely the exposure the file
   * option was added to remove.
   */
  it("says so rather than reporting nothing configured", () => {
    const ring = loadKeyring({ agentId: "v.fac.testnet", agentKeyError: KEY_FILE_ERR });
    expect(ring.all).toHaveLength(0);

    const msg = thrown(() => selectAgent(ring, {}));
    expect(msg).toContain("/etc/float/agent.json");
    expect(msg, "degraded into the generic message").not.toMatch(
      /no agent credentials are configured/i,
    );
  });

  /**
   * The subtle one. With a fleet on disk the ring is NOT empty, so the
   * refusal is the ambiguity error — "pass role, agent or nodeId". True, but
   * it hides a regression: the broken file is what removed the default this
   * deployment had been relying on. Without the note, a working adapter that
   * stops signing un-targeted payments looks like a caller bug.
   */
  it("is still named when a fleet file left the ring non-empty", () => {
    const ring = loadKeyring({ agentKeysPath: keyfile(FLEET), agentKeyError: KEY_FILE_ERR });
    expect(ring.all).toHaveLength(2);
    expect(ring.fallback).toBeUndefined();
    expect(thrown(() => selectAgent(ring, {}))).toContain("/etc/float/agent.json");
  });

  it("does not interfere with a request that names its agent", () => {
    // A broken default must not break selection that never needed it.
    const ring = loadKeyring({ agentKeysPath: keyfile(FLEET), agentKeyError: KEY_FILE_ERR });
    expect(selectAgent(ring, { role: "news" }).secret).toBe("ed25519:news");
  });

  it("loads a key that came from a file exactly as an inline one", () => {
    // The whole point: once read, a file-sourced key is not a special case.
    const ring = loadKeyring({ agentId: "v.fac.testnet", agentKey: "ed25519:fromfile" });
    expect(selectAgent(ring, {}).secret).toBe("ed25519:fromfile");
    expect(ring.agentKeyError).toBeUndefined();
  });
});

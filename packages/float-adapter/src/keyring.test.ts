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

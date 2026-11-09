import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadKeyring } from "../../float-adapter/src/keyring.js";
import { readKeyFile } from "./key-file.js";
import { AGENT_NODE_ID, generateAgentKey } from "./agent-key.js";

const tmp = () => mkdtempSync(join(tmpdir(), "float-agent-key-"));

describe("generateAgentKey", () => {
  /**
   * THE RECORD MUST ACTUALLY LOAD.
   *
   * This is the test that matters, and it is why it imports the adapter's own
   * `loadKeyring` rather than asserting a JSON shape. The adapter accepts an
   * entry only when it has a string `agentId` AND a string `secret`, and
   * skips anything else IN SILENCE — no warning, no error, the file just
   * contributes nothing.
   *
   * `float-agent.mjs` writes `{kind, vault, node, publicKey, privateKey}` into
   * this same file, which that condition rejects on both counts. A test
   * asserting "the file contains the key" would pass against exactly that
   * dead shape. Round-tripping through the real loader is the only version of
   * this test that can tell the difference.
   */
  it("writes a record the adapter's own keyring loader accepts", () => {
    const dir = tmp();
    const vault = "alice-testnet.fac.floatv4.testnet";
    const out = generateAgentKey({ vault, dir });

    const ring = loadKeyring({ agentKeysPath: out.keyringPath });
    const cred = ring.byAccount.get(vault);
    expect(cred, "the adapter did not load the credential just written").toBeDefined();
    expect(cred!.nodeId).toBe(AGENT_NODE_ID);
    expect(cred!.secret.startsWith("ed25519:")).toBe(true);
  });

  /** The agent is reachable by node too, which is how a payment targets it. */
  it("is selectable by node id", () => {
    const dir = tmp();
    const out = generateAgentKey({ vault: "v.fac.testnet", dir });
    const ring = loadKeyring({ agentKeysPath: out.keyringPath });
    expect(ring.byNode.get(AGENT_NODE_ID)).toBeDefined();
  });

  /**
   * THE SECRET MUST NOT BE RETURNED. A tool response is a transcript entry
   * forever, and this session's transcript already acquired one key from a
   * screenshot and another from a config dump.
   */
  it("returns the public half only", () => {
    const dir = tmp();
    const out = generateAgentKey({ vault: "v.fac.testnet", dir });
    const secret = JSON.parse(readFileSync(out.keyringPath, "utf8"))[0].secret;

    expect(out.publicKey.startsWith("ed25519:")).toBe(true);
    expect(JSON.stringify(out)).not.toContain(secret);
    // And the two halves must genuinely differ, or the check above is vacuous.
    expect(out.publicKey).not.toBe(secret);
  });

  /**
   * APPEND, NEVER REPLACE. An on-chain binding cannot be undone by deleting a
   * file, so overwriting a keyring strands whatever agent it described — the
   * agent stays authorised forever and nothing holds its key.
   */
  it("keeps existing credentials when a second agent is generated", () => {
    const dir = tmp();
    const first = generateAgentKey({ vault: "one.fac.testnet", dir });
    const second = generateAgentKey({ vault: "two.fac.testnet", dir });
    expect(second.keyringPath).toBe(first.keyringPath);

    const ring = loadKeyring({ agentKeysPath: second.keyringPath });
    expect(ring.byAccount.get("one.fac.testnet"), "the first agent was lost").toBeDefined();
    expect(ring.byAccount.get("two.fac.testnet")).toBeDefined();
  });

  /**
   * A corrupt keyring is moved aside rather than overwritten. Whatever is in
   * there may be the only copy of a working secret, and a parse failure is not
   * evidence that it is junk.
   */
  it("preserves an unreadable keyring instead of clobbering it", () => {
    const dir = tmp();
    const path = join(dir, "agent-keys.json");
    writeFileSync(path, "{ this is not json");

    const out = generateAgentKey({ vault: "v.fac.testnet", dir });
    expect(out.backedUpTo, "a corrupt keyring was silently destroyed").toBeDefined();
    expect(readFileSync(out.backedUpTo!, "utf8")).toBe("{ this is not json");
    // And the new one is valid.
    expect(loadKeyring({ agentKeysPath: out.keyringPath }).byAccount.size).toBe(1);
  });

  /** The env form the MCP server reads must name the vault as the agent. */
  it("writes an env file that POINTS AT the keyring and holds no key itself", () => {
    /**
     * This used to assert `NEAR_VAULT_AGENT_KEY=ed25519:` — it pinned the
     * inline form, so the leak was a tested guarantee rather than an
     * oversight. A `cat` of this file to check which vault was configured
     * printed a live private key into scrollback and into the transcript of
     * whatever agent was driving.
     *
     * The keyring beside it is the durable record and `readKeyFile` reads that
     * shape, so naming the secret twice bought a second place to leak from and
     * nothing else.
     */
    const dir = tmp();
    const out = generateAgentKey({ vault: "v.fac.testnet", dir });
    expect(existsSync(out.envPath)).toBe(true);
    const env = readFileSync(out.envPath, "utf8");
    expect(env).toContain("NEAR_VAULT_AGENT_ID=v.fac.testnet");
    expect(env).toContain(`NEAR_VAULT_AGENT_KEY_FILE=${out.keyringPath}`);

    // THE POINT: no secret in this file, by any spelling.
    expect(env).not.toMatch(/NEAR_VAULT_AGENT_KEY=/);
    const secret = JSON.parse(readFileSync(out.keyringPath, "utf8"))[0].secret;
    expect(secret).toMatch(/^ed25519:/);
    expect(env).not.toContain(secret);
  });

  it("the key it points at is readable back through readKeyFile", () => {
    // Reachability is a separate claim from correctness: writing a path that
    // nothing can parse would pass every assertion above and fail at payment.
    const out = generateAgentKey({ vault: "v.fac.testnet", dir: tmp() });
    const back = readKeyFile(out.keyringPath);
    expect(back.secret).toBe(
      JSON.parse(readFileSync(out.keyringPath, "utf8"))[0].secret,
    );
    expect(back.accountId).toBe("v.fac.testnet");
  });

  /** Two calls must never produce the same key. */
  it("generates a distinct key every time", () => {
    const a = generateAgentKey({ vault: "v.fac.testnet", dir: tmp() });
    const b = generateAgentKey({ vault: "v.fac.testnet", dir: tmp() });
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

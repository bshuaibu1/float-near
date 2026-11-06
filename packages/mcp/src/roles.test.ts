import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listRoles, selectRole } from "./roles.js";

function ring(entries: unknown[]): { agentKeysPath: string } {
  const p = join(mkdtempSync(join(tmpdir(), "float-roles-")), "agent-keys.json");
  writeFileSync(p, JSON.stringify(entries, null, 2));
  return { agentKeysPath: p };
}

/** A fleet: every virtual agent on one vault shares the vault's account id. */
const FLEET = [
  { role: "marketing", agentId: "v.fac.testnet", nodeId: 1, secret: "ed25519:mkt" },
  { role: "news", agentId: "v.fac.testnet", nodeId: 2, secret: "ed25519:news" },
];

describe("selectRole", () => {
  /**
   * WHICH KEY SIGNS *IS* WHICH BUDGET IS CHARGED. The contract resolves the
   * node from the signer, never from the request body, so returning the wrong
   * credential does not fail — the payment succeeds against another agent's
   * budget. That makes this the test that matters.
   */
  it("returns the key belonging to the named role", () => {
    const cfg = ring(FLEET);
    expect(selectRole(cfg, "marketing").agentKey).toBe("ed25519:mkt");
    expect(selectRole(cfg, "news").agentKey).toBe("ed25519:news");
  });

  it("refuses an unknown role and names the real ones", () => {
    const cfg = ring(FLEET);
    expect(() => selectRole(cfg, "sales")).toThrow(/marketing/);
    expect(() => selectRole(cfg, "sales")).toThrow(/news/);
  });

  /**
   * A keyring written before roles existed loads fine but cannot be selected
   * by name. Saying "Known roles: none" alone would read as an empty keyring;
   * the caller needs to know credentials ARE there and why they are invisible.
   */
  it("distinguishes 'no roles' from 'no credentials'", () => {
    const old = ring([{ agentId: "v.fac.testnet", nodeId: 7, secret: "ed25519:old" }]);
    expect(() => selectRole(old, "marketing")).toThrow(/predate roles|none carries a role/i);
    expect(() => selectRole(ring([]), "marketing")).toThrow(/Known roles: none/);
  });

  /**
   * MUST USE THE ADAPTER'S PREDICATE. `loadKeyring` accepts an entry only
   * when `agentId` and `secret` are both strings and skips anything else in
   * SILENCE — the shape `float-agent.mjs` writes fails both. Listing such an
   * entry here would advertise an agent that can never actually be selected.
   */
  it("ignores entries the adapter would silently skip", () => {
    const mixed = ring([
      // CARRIES A ROLE but fails the adapter's predicate: `vault`/`privateKey`
      // instead of `agentId`/`secret` — the shape `float-agent.mjs` writes.
      //
      // The role matters. A first version of this test used a role-LESS entry,
      // which `listRoles` discards on the role filter alone, so removing the
      // predicate entirely still passed and the test proved nothing. This
      // entry can only be excluded by the predicate itself.
      { role: "ghost", kind: "virtual", vault: "v.fac.testnet", node: 1, privateKey: "y" },
      ...FLEET,
    ]);
    expect(listRoles(mixed).map((r) => r.role)).toEqual(["marketing", "news"]);
    expect(
      () => selectRole(mixed, "ghost"),
      "an entry the adapter cannot load must not be selectable here either",
    ).toThrow(/no agent with role/);
    expect(selectRole(mixed, "marketing").agentKey).toBe("ed25519:mkt");
  });

  /** A corrupt keyring must not throw a parse error at payment time. */
  it("treats an unreadable keyring as empty rather than crashing", () => {
    const p = join(mkdtempSync(join(tmpdir(), "float-roles-")), "agent-keys.json");
    writeFileSync(p, "{ not json");
    expect(() => selectRole({ agentKeysPath: p }, "marketing")).toThrow(/no agent with role/);
    expect(listRoles({ agentKeysPath: p })).toEqual([]);
  });
});

describe("listRoles", () => {
  it("reports role and node without exposing key material", () => {
    const out = listRoles(ring(FLEET));
    expect(out.map((r) => [r.role, r.nodeId])).toEqual([
      ["marketing", 1],
      ["news", 2],
    ]);
  });

  it("omits entries that carry no role", () => {
    const out = listRoles(ring([...FLEET, { agentId: "v.fac.testnet", secret: "ed25519:anon" }]));
    expect(out).toHaveLength(2);
  });
});

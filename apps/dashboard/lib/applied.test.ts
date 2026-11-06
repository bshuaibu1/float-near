import { describe, it, expect } from "vitest";
import {
  isApplied,
  appliedStatus,
  type Expectation,
  type PolicySnapshot,
  type VaultSnapshot,
} from "./applied";

const vault: VaultSnapshot = { paused: false, strictAllocation: false };

const nodes: PolicySnapshot[] = [
  {
    nodeId: 0,
    dailyBudget: "100",
    perTxLimit: "10",
    cooldownSeconds: 0,
    ownAllowedAddresses: ["work12.testnet"],
    frozen: false,
  },
  {
    nodeId: 1,
    dailyBudget: "25",
    perTxLimit: "5",
    cooldownSeconds: 0,
    ownAllowedAddresses: undefined, // inherits
    frozen: false,
  },
];

describe("caps", () => {
  it("is applied when BOTH caps match - they are one transaction", () => {
    expect(isApplied({ kind: "caps", nodeId: 0, daily: "100", perTx: "10" }, nodes, vault)).toBe(true);
  });

  it("is NOT applied when only the DAILY cap differs", () => {
    // A half-applied set_node_caps is impossible on-chain, so this really
    // means the read is stale - which is exactly why the caller re-checks
    // rather than declaring failure.
    expect(isApplied({ kind: "caps", nodeId: 0, daily: "150", perTx: "10" }, nodes, vault)).toBe(false);
  });

  it("is NOT applied when only the PER-PAYMENT cap differs", () => {
    // The mirror of the test above, and the one that was missing. With only
    // the first case, an implementation that checks `daily` and ignores
    // `perTx` passes the whole suite - mutation-confirmed. The caller would
    // then report a cap change as landed while the chain enforces the old
    // per-payment ceiling.
    expect(isApplied({ kind: "caps", nodeId: 0, daily: "100", perTx: "99" }, nodes, vault)).toBe(false);
  });

  it("compares amounts by VALUE, not spelling", () => {
    // The page sends "25"; the adapter may return "25.0" from fromBaseUnits.
    // A string compare would call a landed change pending forever.
    const n: PolicySnapshot[] = [{ ...nodes[1], dailyBudget: "25.0", perTxLimit: "5.00" }];
    expect(isApplied({ kind: "caps", nodeId: 1, daily: "25", perTx: "5" }, n, vault)).toBe(true);
  });

  it("does not treat 25 and 250 as equal", () => {
    expect(isApplied({ kind: "caps", nodeId: 1, daily: "250", perTx: "5" }, nodes, vault)).toBe(false);
  });
});

describe("cooldown", () => {
  it("matches the set value", () => {
    expect(isApplied({ kind: "cooldown", nodeId: 0, seconds: 0 }, nodes, vault)).toBe(true);
    expect(isApplied({ kind: "cooldown", nodeId: 0, seconds: 60 }, nodes, vault)).toBe(false);
  });

  it("treats an absent cooldown as 0, the contract's default", () => {
    const n: PolicySnapshot[] = [{ nodeId: 9, frozen: false }];
    expect(isApplied({ kind: "cooldown", nodeId: 9, seconds: 0 }, n, vault)).toBe(true);
  });
});

describe("recipients", () => {
  it("matches an exact list", () => {
    expect(
      isApplied({ kind: "recipients", nodeId: 0, list: ["work12.testnet"] }, nodes, vault),
    ).toBe(true);
  });

  it("treats 'inherit' (empty) as applied when the node owns no list", () => {
    expect(isApplied({ kind: "recipients", nodeId: 1, list: [] }, nodes, vault)).toBe(true);
  });

  it("is order-sensitive, because the contract stores a list", () => {
    const n: PolicySnapshot[] = [{ ...nodes[0], ownAllowedAddresses: ["b.testnet", "a.testnet"] }];
    expect(
      isApplied({ kind: "recipients", nodeId: 0, list: ["a.testnet", "b.testnet"] }, n, vault),
    ).toBe(false);
  });

  it("does not consider a longer CHAIN list a match for a shorter expectation", () => {
    const n: PolicySnapshot[] = [
      { ...nodes[0], ownAllowedAddresses: ["a.testnet", "b.testnet"] },
    ];
    expect(isApplied({ kind: "recipients", nodeId: 0, list: ["a.testnet"] }, n, vault)).toBe(false);
  });

  it("does not consider a SHORTER chain list a match - the false positive", () => {
    // The mirror, and the one that was missing. An `every` without a length
    // check returns true here, because every element of the short chain list
    // matches the start of the expected one - mutation-confirmed. We would
    // report "applied" while the vault can pay fewer accounts than asked.
    const n: PolicySnapshot[] = [{ ...nodes[0], ownAllowedAddresses: ["a.testnet"] }];
    expect(
      isApplied({ kind: "recipients", nodeId: 0, list: ["a.testnet", "b.testnet"] }, n, vault),
    ).toBe(false);
  });
});

describe("vault-wide switches", () => {
  it("reads paused off the vault, not a node", () => {
    expect(isApplied({ kind: "paused", value: false }, nodes, vault)).toBe(true);
    expect(isApplied({ kind: "paused", value: true }, nodes, vault)).toBe(false);
    expect(isApplied({ kind: "paused", value: true }, nodes, { ...vault, paused: true })).toBe(true);
  });

  it("reads strict allocation off the vault", () => {
    expect(isApplied({ kind: "strict", value: false }, nodes, vault)).toBe(true);
    expect(
      isApplied({ kind: "strict", value: true }, nodes, { ...vault, strictAllocation: true }),
    ).toBe(true);
  });

  it("is NOT applied when the vault read is missing", () => {
    // No vault data must never read as success - it is an unfinished load.
    expect(isApplied({ kind: "paused", value: false }, nodes, null)).toBe(false);
  });
});

describe("freeze", () => {
  it("matches the frozen flag", () => {
    expect(isApplied({ kind: "frozen", nodeId: 0, value: false }, nodes, vault)).toBe(true);
    expect(isApplied({ kind: "frozen", nodeId: 0, value: true }, nodes, vault)).toBe(false);
  });
});

describe("a missing node", () => {
  it("is never reported as applied", () => {
    // A half-loaded response must not read as success for any expectation.
    const cases: Expectation[] = [
      { kind: "caps", nodeId: 99, daily: "1", perTx: "1" },
      { kind: "cooldown", nodeId: 99, seconds: 0 },
      { kind: "recipients", nodeId: 99, list: [] },
      { kind: "frozen", nodeId: 99, value: false },
    ];
    for (const e of cases) {
      expect(isApplied(e, nodes, vault)).toBe(false);
    }
  });

  it("is never reported as applied against an EMPTY read either", () => {
    expect(isApplied({ kind: "cooldown", nodeId: 0, seconds: 0 }, [], vault)).toBe(false);
  });
});

describe("appliedStatus", () => {
  it("says not-yet rather than failed - a final-finality read can lag a write", () => {
    expect(appliedStatus({ kind: "cooldown", nodeId: 0, seconds: 60 }, nodes, vault)).toBe("not-yet");
    expect(appliedStatus({ kind: "cooldown", nodeId: 0, seconds: 0 }, nodes, vault)).toBe("applied");
  });
});

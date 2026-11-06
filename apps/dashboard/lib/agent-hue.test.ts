import { describe, it, expect } from "vitest";
import { agentHue, agentSeed, nodeIndexOf } from "./agent-hue";

/** The smallest gap between any two hues on a 360 degree wheel. */
function closestPair(hues: number[]): number {
  const s = [...hues].sort((a, b) => a - b);
  let min = 360;
  for (let i = 1; i < s.length; i++) min = Math.min(min, s[i] - s[i - 1]);
  // the wheel wraps, so the first and last are neighbours too
  return Math.min(min, 360 - (s[s.length - 1] - s[0]));
}

/** The avatar's own hash, copied so the comparison is against what ships. */
function hashedHue(seed: string): number {
  let h = 0;
  for (const c of seed) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  let s = Math.abs(h);
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 360;
}

describe("nodeIndexOf", () => {
  it("reads the index out of an adapter-built id", () => {
    expect(nodeIndexOf("node-0")).toBe(0);
    expect(nodeIndexOf("node-7")).toBe(7);
    expect(nodeIndexOf("node-63")).toBe(63);
  });

  /**
   * THE FORMAT THE FIRST VERSION MISSED. The payment mapper emits a BARE
   * number, so every activity row returned null, fell back to the hash, and
   * kept the exact bug this was written to fix. Found by reading the live
   * payload rather than by the suite, which is why it is pinned here now.
   */
  it("reads a bare numeric id, as the payment mapper emits", () => {
    expect(nodeIndexOf("1")).toBe(1);
    expect(nodeIndexOf("0")).toBe(0);
    expect(nodeIndexOf("12")).toBe(12);
  });

  it("gives the SAME index for both formats of one node", () => {
    expect(nodeIndexOf("1")).toBe(nodeIndexOf("node-1"));
    expect(agentHue("1")).toBe(agentHue("node-1"));
  });

  /**
   * An agent with its own NEAR account is named for the account. Those have
   * no index and must say so, rather than being coerced to 0 and all sharing
   * a colour.
   */
  it("returns null for an account-named agent", () => {
    expect(nodeIndexOf("alice.testnet")).toBeNull();
    expect(nodeIndexOf("work12-testnet-fleet.fac.floatv4.testnet")).toBeNull();
    expect(nodeIndexOf("node-")).toBeNull();
    expect(nodeIndexOf("node-1x")).toBeNull();
    expect(nodeIndexOf("xnode-1")).toBeNull();
  });
});

describe("agentHue", () => {
  it("is deterministic", () => {
    expect(agentHue("node-3")).toBe(agentHue("node-3"));
  });

  it("gives every node a different hue", () => {
    const hues = Array.from({ length: 8 }, (_, i) => agentHue(`node-${i}`)!);
    expect(new Set(hues).size).toBe(8);
  });

  /**
   * THE DEFECT THIS REPLACES, pinned as a comparison rather than described.
   *
   * The avatar's hash puts node-2 at 332 degrees and node-3 at 333: one
   * degree apart and indistinguishable on screen. Asserting our spacing in
   * isolation would not show that we fixed anything, so the old behaviour is
   * computed here and required to be worse.
   */
  it("spaces eight agents far better than hashing them does", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `node-${i}`);
    const ours = closestPair(ids.map((id) => agentHue(id)!));
    const hashed = closestPair(ids.map(hashedHue));

    expect(hashed, "the hash should still be the bad one").toBeLessThan(5);
    expect(ours, "golden-angle spacing should be far wider").toBeGreaterThan(30);
    expect(ours).toBeGreaterThan(hashed * 10);
  });

  it("keeps a usable gap at sixteen agents", () => {
    const hues = Array.from({ length: 16 }, (_, i) => agentHue(`node-${i}`)!);
    expect(closestPair(hues)).toBeGreaterThan(10);
  });

  /**
   * MAX_NODES is 64 and the wheel is 360 degrees, so the gap necessarily
   * narrows. Pinned so the degradation is a known number rather than a
   * surprise: at the contract's hard maximum two agents sit about 3 degrees
   * apart and the label does the distinguishing.
   */
  it("degrades predictably at the contract's maximum", () => {
    const hues = Array.from({ length: 64 }, (_, i) => agentHue(`node-${i}`)!);
    const gap = closestPair(hues);
    expect(gap).toBeGreaterThan(2);
    expect(gap).toBeLessThan(5);
  });

  it("stays on the wheel", () => {
    for (let i = 0; i < 64; i++) {
      const h = agentHue(`node-${i}`)!;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  /** No index means no opinion, so the avatar keeps hashing. */
  it("declines to guess for an account-named agent", () => {
    expect(agentHue("alice.testnet")).toBeUndefined();
    expect(agentHue(null)).toBeUndefined();
    expect(agentHue(undefined)).toBeUndefined();
    expect(agentHue("")).toBeUndefined();
  });
});

describe("agentSeed", () => {
  /**
   * MATCHING THE HUE WAS NOT ENOUGH, and this is the test that would have
   * caught my first attempt.
   *
   * The avatar hashes its seed twice: once for the palette and once for
   * `generateGrid`, which decides the pixel pattern and every animation
   * phase. Giving two different seeds a matching hue produces two avatars
   * of the same COLOUR with different patterns - closer than the original
   * bug, still visibly not the same agent.
   */
  it("collapses both id formats of one node onto one seed", () => {
    expect(agentSeed("1")).toBe("node-1");
    expect(agentSeed("node-1")).toBe("node-1");
    expect(agentSeed("1")).toBe(agentSeed("node-1"));
  });

  it("keeps an account-named agent as itself", () => {
    expect(agentSeed("alice.testnet")).toBe("alice.testnet");
  });

  it("is empty for nothing, rather than the string 'null'", () => {
    expect(agentSeed(null)).toBe("");
    expect(agentSeed(undefined)).toBe("");
  });

  /**
   * The whole point, stated as one assertion: whatever format a panel
   * happens to receive, the agent draws the same avatar.
   */
  it("gives one node one identity across both panels", () => {
    const fromTree = { seed: agentSeed("node-1"), hue: agentHue("node-1") };
    const fromActivity = { seed: agentSeed("1"), hue: agentHue("1") };
    expect(fromActivity).toEqual(fromTree);
  });
});

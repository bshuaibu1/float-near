import { describe, it, expect } from "vitest";
import {
  CUSTOM,
  applyCooldownSelection,
  cooldownLabel,
  cooldownSelectValue,
  initialCustomMode,
  isPresetCooldown,
  parseCooldownInput,
  showsCustomInput,
} from "./cooldown";

/**
 * The reported bug, pinned: "under cooldown the custom option doesn't select".
 *
 * The old control derived its value purely from the seconds and ignored a
 * "custom" selection, so picking Custom changed nothing and the dropdown
 * snapped back. These tests drive the full user gesture — select Custom, then
 * ask what the select shows — because asserting only on the returned state
 * would have passed against the broken version too: the OLD onChange also
 * "did nothing", and doing nothing looks fine until you re-render.
 */
describe("choosing Custom", () => {
  it("STAYS selected after being chosen - the reported bug", () => {
    const seconds = 0; // "No wait", a preset: the case where Custom was unreachable
    const next = applyCooldownSelection(CUSTOM, seconds);
    // The whole bug lives in this second line. Previously the value was
    // recomputed from the (unchanged) seconds and came back "0".
    expect(cooldownSelectValue(next.seconds, next.customMode)).toBe(CUSTOM);
  });

  it("keeps the current number so it can be edited, rather than zeroing it", () => {
    expect(applyCooldownSelection(CUSTOM, 300)).toEqual({ seconds: 300, customMode: true });
  });

  it("reveals the seconds input", () => {
    const next = applyCooldownSelection(CUSTOM, 0);
    expect(showsCustomInput(next.seconds, next.customMode)).toBe(true);
  });

  it("stays custom even when the typed number equals a preset", () => {
    // 60 is "1 minute" AND a reasonable thing to type. The number alone
    // cannot distinguish them, which is why customMode exists.
    expect(cooldownSelectValue(60, true)).toBe(CUSTOM);
    expect(showsCustomInput(60, true)).toBe(true);
  });
});

describe("choosing a preset", () => {
  it("selects it and leaves custom mode", () => {
    expect(applyCooldownSelection("60", 999)).toEqual({ seconds: 60, customMode: false });
  });

  it("shows the preset, not custom", () => {
    const next = applyCooldownSelection("300", 999);
    expect(cooldownSelectValue(next.seconds, next.customMode)).toBe("300");
    expect(showsCustomInput(next.seconds, next.customMode)).toBe(false);
  });

  it("can return from custom mode to a preset", () => {
    const custom = applyCooldownSelection(CUSTOM, 0);
    const back = applyCooldownSelection("30", custom.seconds);
    expect(back.customMode).toBe(false);
    expect(cooldownSelectValue(back.seconds, back.customMode)).toBe("30");
  });

  it("every preset round-trips", () => {
    for (const v of [0, 10, 30, 60, 300, 3600]) {
      const n = applyCooldownSelection(String(v), 0);
      expect(cooldownSelectValue(n.seconds, n.customMode)).toBe(String(v));
    }
  });
});

describe("seeding from the chain", () => {
  it("starts in custom mode for an off-preset value, or the select renders blank", () => {
    expect(initialCustomMode(45)).toBe(true);
    expect(cooldownSelectValue(45, initialCustomMode(45))).toBe(CUSTOM);
    expect(showsCustomInput(45, initialCustomMode(45))).toBe(true);
  });

  it("starts on the preset when the chain value is one", () => {
    expect(initialCustomMode(3600)).toBe(false);
    expect(cooldownSelectValue(3600, initialCustomMode(3600))).toBe("3600");
  });
});

describe("isPresetCooldown", () => {
  it("is true only for the listed values", () => {
    expect([0, 10, 30, 60, 300, 3600].every(isPresetCooldown)).toBe(true);
    expect([1, 45, 120, 86400].some(isPresetCooldown)).toBe(false);
  });
});

describe("cooldownLabel", () => {
  it("names presets", () => {
    expect(cooldownLabel(0)).toBe("No wait");
    expect(cooldownLabel(3600)).toBe("1 hour");
  });

  it("falls back to raw seconds for anything else", () => {
    expect(cooldownLabel(45)).toBe("45 seconds");
  });
});

describe("parseCooldownInput", () => {
  it("floors, and refuses negatives", () => {
    expect(parseCooldownInput("12.9")).toBe(12);
    expect(parseCooldownInput("-5")).toBe(0);
  });

  it("treats junk and empty as zero rather than NaN", () => {
    // NaN would reach the contract as null and the call would fail opaquely.
    expect(parseCooldownInput("")).toBe(0);
    expect(parseCooldownInput("abc")).toBe(0);
  });
});

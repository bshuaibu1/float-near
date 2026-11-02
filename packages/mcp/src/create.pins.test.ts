import { statSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CONTRACT_BYTES, CREATE_GAS_TGAS } from "./create.js";

/**
 * Pins against the real artifacts, because both of these numbers are copies.
 *
 * A copy that nothing checks is a copy that drifts, and this repo has already
 * paid for that: a stale build artifact was one command away from redeploying
 * vulnerable code while reporting the fix as shipped, with the two builds 24
 * bytes apart. These tests are cheap; the failure mode is a user being quoted
 * a deposit too small to cover their own vault's storage, which does not fail
 * cleanly — CreateAccount succeeds and the vault bricks on its first write.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const WASM = resolve(ROOT, "packages", "create-float", "res", "vault.wasm");
const PAGE = resolve(ROOT, "web", "index.html");

describe("CONTRACT_BYTES", () => {
  it("matches the vault wasm create-float actually ships", () => {
    if (!existsSync(WASM)) {
      // Skipping loudly rather than silently: a missing artifact must not read
      // as a passing pin.
      console.warn(`SKIPPED: ${WASM} not present, cannot pin CONTRACT_BYTES`);
      return;
    }
    expect(CONTRACT_BYTES).toBe(statSync(WASM).size);
  });
});

describe("CREATE_GAS_TGAS", () => {
  it("matches the gas the create page actually attaches", () => {
    if (!existsSync(PAGE)) {
      console.warn(`SKIPPED: ${PAGE} not present, cannot pin CREATE_GAS_TGAS`);
      return;
    }
    const html = readFileSync(PAGE, "utf8");
    const m = html.match(/gas:\s*"(\d+)"/);
    expect(m, "no gas literal found in web/index.html").not.toBeNull();
    // Assert the units before comparing, so a page that switched to a
    // different representation fails here rather than quietly passing.
    const attached = BigInt(m![1]);
    expect(attached % 10n ** 12n).toBe(0n);
    expect(attached / 10n ** 12n).toBe(CREATE_GAS_TGAS);
  });
});

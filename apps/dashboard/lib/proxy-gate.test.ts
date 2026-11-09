import { describe, it, expect } from "vitest";
import { proxyGate } from "./proxy-gate";

/**
 * THE BUG THIS EXISTS TO HAVE CAUGHT. The adapter's gate was changed from
 * per-METHOD to per-ROUTE so a hosted, token-less box could still offer owner
 * actions — `/v1/owner-plan` returns an UNSIGNED payload the owner approves in
 * their own wallet, so it needs no credential, while `/v1/pay` signs with the
 * agent key and always does.
 *
 * The proxy IN FRONT of it was left gating by method. So `/v1/owner-plan` was
 * refused 503 here and never reached the adapter at all: the fix was real and
 * completely bypassed. Measured against a local token-less stack on
 * 2026-11-09 — control read 200, `/v1/pay` 503 (correct), `/v1/owner-plan`
 * 503 (wrong). Two layers, one guard; only one of them had been updated.
 *
 * It lives here rather than inline in the route handler for the reason
 * `lib/ownership.ts` gives: the condition IS the guard, and a condition
 * nobody can test is a guard nobody can trust.
 */
describe("proxyGate", () => {
  const read = { method: "GET", path: "v1/dashboard" };

  it("forwards a read with no token, whether or not one is configured", () => {
    for (const hasToken of [true, false]) {
      const g = proxyGate({ ...read, hasToken });
      expect(g.kind).toBe("forward");
      if (g.kind === "forward") {
        expect(g.attachToken).toBe(false);
        expect(g.mayResolveVault).toBe(true);
      }
    }
  });

  it("forwards /v1/owner-plan with NO token — it signs nothing", () => {
    // The whole point. A hosted box has no token and must still offer this.
    const g = proxyGate({ method: "POST", path: "v1/owner-plan", hasToken: false });
    expect(g.kind).toBe("forward");
    if (g.kind === "forward") {
      expect(g.attachToken).toBe(false);
      // And it must carry the vault, or the plan names the OPERATOR's vault.
      expect(g.mayResolveVault).toBe(true);
    }
  });

  it("does not attach a token to /v1/owner-plan even when one exists", () => {
    // Otherwise a hosted box and a local box behave differently on the route
    // that matters, and the local one is what gets tested.
    const g = proxyGate({ method: "POST", path: "v1/owner-plan", hasToken: true });
    if (g.kind === "forward") expect(g.attachToken).toBe(false);
    else throw new Error("must forward");
  });

  it("REFUSES /v1/pay when no token is configured", () => {
    const g = proxyGate({ method: "POST", path: "v1/pay", hasToken: false });
    expect(g.kind).toBe("refuse");
    if (g.kind === "refuse") expect(g.status).toBe(503);
  });

  it("attaches the token to /v1/pay when one exists, and never resolves its vault", () => {
    // /v1/pay is pinned to the vault whose key the adapter holds. Rewriting it
    // would ask one vault's key to spend from another's.
    const g = proxyGate({ method: "POST", path: "v1/pay", hasToken: true });
    expect(g.kind).toBe("forward");
    if (g.kind === "forward") {
      expect(g.attachToken).toBe(true);
      expect(g.mayResolveVault).toBe(false);
    }
  });

  it("AN UNKNOWN MUTATING ROUTE IS SHUT, not open — fail-closed", () => {
    // Mirrors the adapter's allowlist. A route added next week must not be
    // born reachable without a credential just because nobody listed it.
    for (const p of ["v1/withdraw", "v1/pay-batch", "v1/owner-plan/extra", "v1/", ""]) {
      const g = proxyGate({ method: "POST", path: p, hasToken: false });
      expect(g.kind, `${p} must be refused`).toBe("refuse");
    }
  });

  it("matches the open route EXACTLY — no prefix or case escape", () => {
    for (const p of ["v1/OWNER-PLAN", "v1/owner-plan/", "v1/owner-planx"]) {
      const g = proxyGate({ method: "POST", path: p, hasToken: false });
      expect(g.kind, `${p} must not inherit the exemption`).toBe("refuse");
    }
  });

  it("treats every mutating verb alike, not just POST", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(proxyGate({ method: m, path: "v1/pay", hasToken: false }).kind).toBe("refuse");
    }
  });

  it("is case-insensitive about the METHOD, since Node may hand back any case", () => {
    const g = proxyGate({ method: "get", path: "v1/dashboard", hasToken: false });
    expect(g.kind).toBe("forward");
  });

  it("the refusal explains itself without naming the secret's value", () => {
    const g = proxyGate({ method: "POST", path: "v1/pay", hasToken: false });
    if (g.kind !== "refuse") throw new Error("must refuse");
    expect(g.error).toMatch(/FLOAT_API_TOKEN/);
    // It must NOT tell a hosted operator to go and set one: on a public box
    // that is the instruction that opens /v1/pay to the internet.
    expect(g.detail).toMatch(/public|hosted|own machine/i);
  });
});

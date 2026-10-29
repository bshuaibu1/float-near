import { describe, it, expect } from "vitest";
import { resolveHost, corsHeaders, authorize } from "./gate.js";

/**
 * The HTTP gate — the layer that had no tests, which is why it shipped open.
 *
 * Proven by PoC on 2026-10-29 against the running adapter (docs/SELF-REVIEW):
 *   - `server.listen(port)` with no host bound 0.0.0.0 AND [::], every
 *     interface, while the log line claimed 127.0.0.1
 *   - an OPTIONS preflight carrying `Origin: https://evil.example` returned
 *     204 with `access-control-allow-origin: *`, so a browser proceeds
 *   - POST /v1/pay returned 400 (body validation), NOT 401 — there was no auth
 *     gate to fail at, and /v1/pay signs with the agent key
 *
 * Every test below is one of those three facts, inverted.
 */

describe("resolveHost", () => {
  it("binds loopback by DEFAULT — exposure must be opted into, never inherited", () => {
    expect(resolveHost(undefined)).toBe("127.0.0.1");
    expect(resolveHost("")).toBe("127.0.0.1");
  });

  it("allows an explicit override, because some deployments genuinely need it", () => {
    expect(resolveHost("0.0.0.0")).toBe("0.0.0.0");
  });
});

describe("corsHeaders", () => {
  it("does NOT echo a wildcard", () => {
    const h = corsHeaders("http://localhost:3000", "http://localhost:3000");
    expect(h["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(Object.values(h)).not.toContain("*");
  });

  it("refuses an origin that is not the configured one", () => {
    // The PoC origin. A browser that gets no matching allow-origin blocks the
    // response, and for a preflighted POST never sends the request at all.
    const h = corsHeaders("http://localhost:3000", "https://evil.example");
    expect(h["access-control-allow-origin"]).toBeUndefined();
  });

  it("omits the header entirely when no origin was sent (curl, server-to-server)", () => {
    const h = corsHeaders("http://localhost:3000", undefined);
    expect(h["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("authorize", () => {
  const TOKEN = "s3cret-token-value";

  it("lets GETs through — they are read-only and the bind is loopback", () => {
    expect(authorize({ method: "GET", authHeader: undefined, token: TOKEN }).ok).toBe(true);
  });

  it("lets the preflight through, or the browser never reaches the real request", () => {
    expect(authorize({ method: "OPTIONS", authHeader: undefined, token: TOKEN }).ok).toBe(true);
  });

  it("REFUSES a POST with no Authorization header — the exact PoC request", () => {
    const v = authorize({ method: "POST", authHeader: undefined, token: TOKEN });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(401);
  });

  it("refuses a POST with the wrong token", () => {
    const v = authorize({ method: "POST", authHeader: "Bearer wrong", token: TOKEN });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(401);
  });

  it("accepts a POST with the right token", () => {
    expect(authorize({ method: "POST", authHeader: `Bearer ${TOKEN}`, token: TOKEN }).ok).toBe(true);
  });

  it("is not fooled by a prefix or a near-miss", () => {
    for (const bad of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, `Basic ${TOKEN}`]) {
      expect(authorize({ method: "POST", authHeader: bad, token: TOKEN }).ok).toBe(false);
    }
  });

  it("returns 503, NOT 401, when no token is configured at all", () => {
    // A different failure: the operator has not set one up, rather than the
    // caller being unauthorized. 401 would invite them to go looking for a
    // credential that does not exist, and an empty-string token must never
    // compare equal to an empty header.
    const v = authorize({ method: "POST", authHeader: "Bearer anything", token: undefined });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.status).toBe(503);
      expect(v.error).toMatch(/FLOAT_API_TOKEN/);
    }
  });

  it("an unset token cannot be satisfied by an empty or absent header", () => {
    // The dangerous shape: `token === provided` where both are "" or undefined.
    for (const h of [undefined, "", "Bearer ", "Bearer"]) {
      const v = authorize({ method: "POST", authHeader: h, token: undefined });
      expect(v.ok).toBe(false);
    }
    for (const h of [undefined, "", "Bearer ", "Bearer"]) {
      const v = authorize({ method: "POST", authHeader: h, token: "" });
      expect(v.ok).toBe(false);
    }
  });
});

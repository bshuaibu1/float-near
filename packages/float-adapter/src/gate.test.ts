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

// ---- gating by ROUTE, so a hosted dashboard can offer owner actions
//
// Gating by METHOD made every non-GET need the token, and the token cannot
// exist on a public box: `apps/dashboard/app/api/float/[...path]/route.ts`
// attaches it to any mutating request WITHOUT authenticating the caller, so a
// hosted dashboard with a token set is an open `/v1/pay` for the internet,
// bounded only by the vault's caps. Measured 2026-11-09: correct token -> 400
// (reached validation), wrong token -> 401, no token configured -> 503.
//
// So the token stays absent in public, and the question becomes which routes
// can work without it. `/v1/owner-plan` can: it RETURNS AN UNSIGNED PAYLOAD
// and holds no key — the owner approves it in their own wallet, which is the
// authority. `/v1/pay` cannot, ever: it signs with the agent key.
//
// ALLOWLIST, NOT DENYLIST, and this is the whole safety argument. A route is
// gated unless it is named here as signing nothing. Denylisting `/v1/pay`
// would mean the NEXT money-moving route is born public and nobody notices
// until it is exploited; fail-closed means it is born shut and someone has to
// argue it open in a diff a reviewer can see.
describe("authorize — by route, fail-closed", () => {
  const TOKEN = "s3cret-token-value";

  it("/v1/pay ALWAYS needs the token — it signs with the agent key", () => {
    const v = authorize({ method: "POST", path: "/v1/pay", authHeader: undefined, token: undefined });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(503);

    const w = authorize({ method: "POST", path: "/v1/pay", authHeader: undefined, token: TOKEN });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.status).toBe(401);
  });

  it("/v1/owner-plan is open — it builds a payload the OWNER signs, and holds no key", () => {
    expect(
      authorize({ method: "POST", path: "/v1/owner-plan", authHeader: undefined, token: undefined }).ok,
    ).toBe(true);
  });

  it("/v1/owner-plan does not START needing a token just because one exists", () => {
    // Otherwise the hosted box and a local box disagree about what works, and
    // the local one is the configuration nobody tests against.
    expect(
      authorize({ method: "POST", path: "/v1/owner-plan", authHeader: undefined, token: TOKEN }).ok,
    ).toBe(true);
  });

  it("AN UNKNOWN POST ROUTE IS SHUT, not open — the fail-closed property", () => {
    // The point of the allowlist. A route added next week is gated until
    // someone deliberately names it, so being born public is impossible.
    for (const p of ["/v1/withdraw", "/v1/pay-batch", "/v1/owner-plan/extra", "/v1/", "/"]) {
      const v = authorize({ method: "POST", path: p, authHeader: undefined, token: undefined });
      expect(v.ok, `${p} must be gated`).toBe(false);
    }
  });

  it("an ABSENT path is treated as gated, so the default is never exposure", () => {
    const v = authorize({ method: "POST", authHeader: undefined, token: undefined });
    expect(v.ok).toBe(false);
  });

  it("reads and preflight are unaffected on every route", () => {
    for (const m of ["GET", "OPTIONS", "HEAD"]) {
      for (const p of ["/v1/pay", "/v1/owner-plan", "/v1/dashboard", undefined]) {
        expect(authorize({ method: m, path: p, authHeader: undefined, token: undefined }).ok).toBe(true);
      }
    }
  });

  it("the open route is still matched EXACTLY — no prefix or case escape", () => {
    // `/v1/paysomething` must not inherit `/v1/pay`'s rules in either
    // direction, and a case variant must not slip past the allowlist.
    for (const p of ["/v1/OWNER-PLAN", "/v1/owner-plan/", "/v1/owner-planx", "//v1/owner-plan"]) {
      const v = authorize({ method: "POST", path: p, authHeader: undefined, token: undefined });
      expect(v.ok, `${p} must not be treated as the open route`).toBe(false);
    }
  });
});

// ---- client errors vs server errors
//
// The catch-all returned 500 for EVERYTHING, including input validation:
// `{"amount":"abc"}` produced `500 invalid amount "abc"`. Verified live against
// the running adapter on 2026-10-30.
//
// For an agent-facing API that is not cosmetic. 500 means "the server broke,
// retry"; 400 means "your request is wrong, fix it". An agent that reads 500 on
// a malformed amount retries the same malformed amount forever. SKILL.md spends
// a whole table teaching agents which refusals to retry, and the adapter was
// lying to them about this one.

import { BadRequest, classifyError } from "./gate.js";

describe("classifyError", () => {
  it("a BadRequest is the CLIENT's fault — 400, do not retry", () => {
    const r = classifyError(new BadRequest('invalid amount "abc"'));
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("abc");
  });

  it("anything else is the SERVER's fault — 500, retrying may help", () => {
    const r = classifyError(new Error("RPC timed out"));
    expect(r.status).toBe(500);
    expect(r.body.error).toContain("RPC");
  });

  it("a non-Error thrown value does not crash the handler", () => {
    // `throw "string"` happens, and a catch-all that assumes Error shape turns
    // a small bug into an unhandled one.
    expect(classifyError("boom").status).toBe(500);
    expect(classifyError(undefined).status).toBe(500);
  });

  it("never leaks a stack trace to the caller", () => {
    const e = new BadRequest("bad input");
    const r = classifyError(e);
    expect(JSON.stringify(r.body)).not.toContain("at ");
    expect(Object.keys(r.body)).toEqual(["error"]);
  });

  it("BadRequest is still an Error, so existing catches keep working", () => {
    expect(new BadRequest("x")).toBeInstanceOf(Error);
  });
});

/**
 * The HTTP gate: where to bind, who may POST, and which origin may ask.
 *
 * This layer had no tests, which is why it shipped open. Proven by PoC on
 * 2026-10-29 against the running adapter (see docs/SELF-REVIEW-2026-10-29.md):
 *
 *   - `server.listen(port)` with no host bound `0.0.0.0` AND `[::]` — every
 *     interface, v4 and v6 — while the startup log claimed `127.0.0.1`.
 *   - An OPTIONS preflight carrying `Origin: https://evil.example` returned
 *     `204` with `access-control-allow-origin: *`, so a browser proceeds to the
 *     real request.
 *   - `POST /v1/pay` returned `400`, not `401`: it reached body validation
 *     because there was no auth gate to fail at. That route signs with the
 *     agent key.
 *
 * Split out from server.ts so each decision is a pure function with a test,
 * rather than three lines buried in a request handler where nothing could see
 * them.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Loopback by default. Exposure is opted into, never inherited.
 *
 * `listen(port)` with no host is the dangerous default — it binds every
 * interface. Passing a host explicitly is the whole fix, and defaulting it to
 * loopback means a deployment has to SAY it wants to be reachable.
 */
export function resolveHost(host: string | undefined): string {
  return host && host.trim() ? host.trim() : "127.0.0.1";
}

/**
 * CORS headers, echoing only an exact-match origin.
 *
 * A wildcard plus an approving preflight is what made this drive-by reachable:
 * any page the operator had open could POST JSON here. Returning no
 * `allow-origin` for an unknown origin makes the browser block the response and
 * — for a preflighted `application/json` POST — never send the request at all.
 *
 * The header is omitted entirely when no `Origin` was sent, which is the
 * curl/server-to-server case and needs no CORS at all.
 */
export function corsHeaders(
  allowedOrigin: string,
  requestOrigin: string | undefined,
): Record<string, string> {
  const base: Record<string, string> = {
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
  if (requestOrigin && requestOrigin === allowedOrigin) {
    base["access-control-allow-origin"] = requestOrigin;
  }
  return base;
}

export type AuthVerdict = { ok: true } | { ok: false; status: number; error: string };

/**
 * Only mutating requests need the token.
 *
 * GETs are read-only and the bind is loopback, so they are reachable only from
 * the machine itself. OPTIONS must pass or the browser never reaches the real
 * request and the dashboard breaks for a reason nobody can see.
 *
 * A MISSING token is 503, not 401. They are different problems: 401 tells a
 * caller to go and find a credential, and here there is none to find — the
 * operator has not configured one. Conflating them sends people hunting for a
 * secret that does not exist.
 */
export function authorize({
  method,
  authHeader,
  token,
}: {
  method: string;
  authHeader: string | undefined;
  token: string | undefined;
}): AuthVerdict {
  if (method === "GET" || method === "OPTIONS" || method === "HEAD") return { ok: true };

  if (!token) {
    return {
      ok: false,
      status: 503,
      error:
        "this route signs with the agent key and is disabled until FLOAT_API_TOKEN is set. " +
        "Set it in .float/adapter.env and send it as `Authorization: Bearer <token>`.",
    };
  }

  const prefix = "Bearer ";
  if (!authHeader || !authHeader.startsWith(prefix)) {
    return { ok: false, status: 401, error: "missing bearer token" };
  }
  const provided = authHeader.slice(prefix.length);

  // Length check first — timingSafeEqual throws on a length mismatch, and the
  // length of a secret is not the part worth hiding.
  if (provided.length !== token.length) {
    return { ok: false, status: 401, error: "invalid token" };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "invalid token" };
  }
  return { ok: true };
}

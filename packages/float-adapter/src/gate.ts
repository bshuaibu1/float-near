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
 * Mutating routes that sign NOTHING, and may therefore work without a token.
 *
 * AN ALLOWLIST, AND THAT DIRECTION IS THE SAFETY ARGUMENT. Gating used to be
 * by METHOD, so every non-GET needed the token — which cannot exist on a
 * public box, because `apps/dashboard/app/api/float/[...path]/route.ts`
 * attaches it to any mutating request WITHOUT authenticating the caller. A
 * hosted dashboard with a token set is an open `/v1/pay` for the internet,
 * bounded only by the vault's caps.
 *
 * `/v1/owner-plan` qualifies: it returns an UNSIGNED payload and holds no key.
 * The owner approving it in their own wallet IS the authority, so a token adds
 * nothing an attacker could not already do by building the payload themselves.
 *
 * A DENYLIST OF `/v1/pay` WOULD BE WRONG. The next money-moving route would be
 * born public and nobody would notice until it was exploited. Named-open means
 * a new route is born shut and someone has to argue it open in a visible diff.
 */
const SIGNS_NOTHING: ReadonlySet<string> = new Set(["/v1/owner-plan"]);

/**
 * Reads are open; mutating routes need the token unless they sign nothing.
 *
 * OPTIONS must pass or the browser never reaches the real request and the
 * dashboard breaks for a reason nobody can see.
 *
 * A MISSING token is 503, not 401. They are different problems: 401 tells a
 * caller to go and find a credential, and here there is none to find — the
 * operator has not configured one. Conflating them sends people hunting for a
 * secret that does not exist.
 *
 * `path` is OPTIONAL and an absent one is GATED, never open. A caller that
 * forgets to pass it gets the safe answer; the alternative defaults to
 * exposure, which is how the `0.0.0.0` bind above happened.
 */
export function authorize({
  method,
  path,
  authHeader,
  token,
}: {
  method: string;
  path?: string | undefined;
  authHeader: string | undefined;
  token: string | undefined;
}): AuthVerdict {
  if (method === "GET" || method === "OPTIONS" || method === "HEAD") return { ok: true };

  // EXACT match only. A prefix or case variant must not inherit the exemption:
  // `/v1/owner-plan/extra` is a different route and may not exist yet, and
  // NEAR paths are not case-folded anywhere else in this server.
  if (path !== undefined && SIGNS_NOTHING.has(path)) return { ok: true };

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

/**
 * An error caused by the CALLER, not by this server.
 *
 * The catch-all returned 500 for everything, so `{"amount":"abc"}` came back as
 * `500 invalid amount "abc"` — verified live against the running adapter.
 *
 * That is not a cosmetic status-code quibble on an agent-facing API. 500 means
 * "the server broke, retrying may help"; 400 means "your request is wrong, fix
 * it". An agent reading 500 on a malformed amount retries the same malformed
 * amount forever. SKILL.md teaches agents exactly this distinction for the
 * contract's reason codes, and the HTTP layer was contradicting it.
 */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

/**
 * Map a thrown value to a response.
 *
 * Takes `unknown` rather than `Error` on purpose: `throw "string"` is legal,
 * and a catch-all that assumes `.message` exists turns a small bug into an
 * unhandled one. Only the message is returned — never a stack, which would
 * hand a caller the server's file paths.
 */
export function classifyError(e: unknown): { status: number; body: { error: string } } {
  if (e instanceof BadRequest) return { status: 400, body: { error: e.message } };
  const message = e instanceof Error ? e.message : "internal error";
  return { status: 500, body: { error: message } };
}

/**
 * Run caller-supplied parsing, re-labelling any failure as the caller's.
 *
 * Wraps the validation helpers that throw plain `Error` — `toBaseUnits` and
 * friends — so their failures reach the catch-all already classified, instead
 * of being indistinguishable from an RPC outage.
 */
export function fromCaller<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new BadRequest(e instanceof Error ? e.message : String(e));
  }
}

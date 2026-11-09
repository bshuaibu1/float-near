/**
 * What the proxy may do with one request: forward it, attach the token, or
 * refuse.
 *
 * WHY THIS IS NOT THREE IFS IN THE ROUTE HANDLER. It was, and that is how the
 * following shipped: the ADAPTER's gate was changed from per-method to
 * per-route so a hosted, token-less box could still offer owner actions, and
 * this layer — which sits in front of it — kept gating by method. So
 * `/v1/owner-plan` was refused 503 here and never reached the adapter. The fix
 * existed and was entirely bypassed.
 *
 * Measured against a local token-less stack on 2026-11-09:
 *   control read      200   (so the stack was genuinely up)
 *   POST /v1/pay      503   correct
 *   POST /v1/owner-plan 503 WRONG — this file is the repair
 *
 * Two layers, one guard, and only one of them had been updated. Pure and in
 * lib/ for the reason `ownership.ts` states: the condition IS the guard, and a
 * condition nobody can test is a guard nobody can trust.
 */

/**
 * Mutating routes that sign nothing and therefore need no credential.
 *
 * `/v1/owner-plan` builds an UNSIGNED payload. The owner approving it in their
 * own wallet is the authority, so a token adds nothing an attacker could not
 * do by constructing the same payload themselves.
 *
 * AN ALLOWLIST, mirroring `packages/float-adapter/src/gate.ts`. Denylisting
 * `/v1/pay` would mean the next money-moving route is born reachable without
 * a credential; named-open means it is born shut and someone has to argue it
 * open in a diff a reviewer can see.
 *
 * NO LEADING SLASH: these are the joined catch-all segments Next.js hands
 * over, so the value is `v1/owner-plan` rather than `/v1/owner-plan`.
 */
const SIGNS_NOTHING: ReadonlySet<string> = new Set(["v1/owner-plan"]);

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export type ProxyGate =
  | {
      kind: "forward";
      /** Attach the server's bearer token to the upstream request. */
      attachToken: boolean;
      /**
       * May `?owner=` be resolved into `?vault=`?
       *
       * False for `/v1/pay`, which is pinned to the vault whose agent key the
       * adapter holds — rewriting it would ask one vault's key to spend from
       * another's.
       */
      mayResolveVault: boolean;
    }
  | { kind: "refuse"; status: number; error: string; detail: string };

export function proxyGate(input: {
  method: string;
  /** The joined catch-all segments, e.g. `v1/owner-plan`. */
  path: string;
  /** Whether FLOAT_API_TOKEN is set on the dashboard server. */
  hasToken: boolean;
}): ProxyGate {
  // Node normalises verbs, but a caller of this function might not, and
  // getting it wrong would route a read down the mutating path.
  const method = input.method.toUpperCase();

  if (READ_METHODS.has(method)) {
    return { kind: "forward", attachToken: false, mayResolveVault: true };
  }

  // EXACT match. A prefix or case variant is a different route that may not
  // exist yet, and must not inherit the exemption.
  if (SIGNS_NOTHING.has(input.path)) {
    // The vault IS resolved here, and that is not an afterthought: the adapter
    // built owner plans against its own configured vault, so without this a
    // visitor's plan named the operator's vault.
    return { kind: "forward", attachToken: false, mayResolveVault: true };
  }

  if (!input.hasToken) {
    return {
      kind: "refuse",
      status: 503,
      error: "FLOAT_API_TOKEN is not set on the dashboard server",
      detail:
        "This route signs with the agent key, so it is disabled without one. " +
        "On a PUBLIC deployment that is deliberate and must stay that way — this " +
        "proxy attaches the token without authenticating the caller, so setting " +
        "it would let anyone on the internet spend from the vault up to its caps. " +
        "To make payments, run Float on your own machine.",
    };
  }

  return { kind: "forward", attachToken: true, mayResolveVault: false };
}

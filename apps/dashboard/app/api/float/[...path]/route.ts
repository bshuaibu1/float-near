/**
 * A server-side proxy to the float-adapter.
 *
 * WHY THIS EXISTS. Every dashboard page is `"use client"`, so until now the
 * BROWSER called the adapter directly, using `NEXT_PUBLIC_FLOAT_API_URL`.
 * Two consequences, both bad once this is hosted anywhere but a laptop:
 *
 *   The adapter has to be reachable from the internet. It holds agent
 *   private keys and exposes `POST /v1/pay`, which moves money. Making it
 *   publicly routable so a web page can call it is the opposite of what the
 *   deploy script's `HOST=127.0.0.1` default is for.
 *
 *   The bearer token has to be in the browser. `lib/float-session.ts` keeps
 *   an owner control key in `localStorage` and attaches it from client code
 *   — so any XSS on this origin reads an owner-level credential.
 *
 * With this route the browser only ever talks to its own origin. The adapter
 * stays on loopback, unreachable from outside the box, and `FLOAT_API_TOKEN`
 * lives in the server's environment where a page script cannot see it.
 *
 * It is a PROXY, not an API. It adds no behaviour of its own — same path,
 * same method, same body. Anything clever here would be a second place for
 * the contract between dashboard and adapter to drift.
 */
import { NextRequest } from "next/server";
import { proxyGate } from "@/lib/proxy-gate";

/**
 * Where the adapter actually listens. NOT `NEXT_PUBLIC_` — this name is
 * deliberately server-only, because a `NEXT_PUBLIC_` variable is inlined into
 * the browser bundle and would put the adapter's address back in the client.
 */
const ADAPTER = process.env.FLOAT_ADAPTER_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.FLOAT_API_TOKEN;

/**
 * WHICH ROUTES NEED THE TOKEN LIVES IN `lib/proxy-gate.ts`, not here.
 *
 * It used to be a method set in this file, and that is how the adapter's
 * per-ROUTE gate came to be bypassed: `/v1/owner-plan` signs nothing and was
 * opened there, while this layer still refused every non-GET and never
 * forwarded it. Two layers, one guard, one of them updated. The decision is
 * now a single tested function both the token and the vault-resolution
 * branches below read from.
 */

/**
 * Which vault an owner's reads should go to, resolved ONCE per owner.
 *
 * THE PAGES HAVE ALWAYS SENT `?owner=<wallet>` AND THE ADAPTER IGNORED IT.
 * That is why a visitor saw whatever vault the adapter was configured with:
 * the question was being asked and never answered. Answering it here means no
 * page has to change — all seven already send the owner through
 * `getOwnerQuery`.
 *
 * Resolved SERVER-SIDE and cached, because it costs a round trip to the
 * factory and the answer does not change: a vault id is derived from the
 * owner's account, so it is stable for as long as the account is.
 *
 * `null` is cached too, and deliberately. An owner with no legal vault id —
 * an implicit account — would otherwise re-ask the factory on every request
 * for an answer that cannot change.
 */
type Resolved =
  | { kind: "ok"; vault: string | null; exists: boolean }
  /** We could not ask. NOT the same as "you have no vault". */
  | { kind: "unavailable" };

const vaultCache = new Map<string, { vault: string | null; exists: boolean }>();

async function resolveVaultFor(owner: string): Promise<Resolved> {
  const hit = vaultCache.get(owner);
  if (hit) return { kind: "ok", ...hit };
  try {
    const r = await fetch(new URL(`/v1/resolve?owner=${encodeURIComponent(owner)}`, ADAPTER), {
      cache: "no-store",
    });
    /**
     * A NON-OK RESPONSE IS "UNKNOWN", NOT "NONE", and conflating them is what
     * made this dangerous. The adapter answers 503 UPSTREAM_UNAVAILABLE when
     * it cannot reach the chain; this used to flatten that to
     * `{vault: null}`, which the caller below renders as "no legal vault id
     * for that account — use a named account". A confident false claim, shown
     * to someone whose account is perfectly fine.
     */
    if (!r.ok) return { kind: "unavailable" };
    const j = (await r.json()) as { vault?: string | null; exists?: boolean };
    const out = { vault: j.vault ?? null, exists: Boolean(j.exists) };
    /**
     * CACHE ONLY WHAT CANNOT CHANGE.
     *
     * A vault that EXISTS will never stop existing, so that is safe to keep
     * forever. A vault that does NOT exist yet may exist a minute from now —
     * which is the entire point of the empty state's "create one" link.
     * Caching the absence meant that the moment after a user created their
     * vault, this process would still insist they had none, until restarted.
     *
     * It also pinned a WRONG absence. The adapter briefly reported
     * `exists:false` for a funded vault because a throttle was misclassified
     * as an answer, and this cache then made that lie permanent — the live
     * dashboard showed UPSTREAM_UNAVAILABLE and zeros to the vault's actual
     * owner. The classifier is fixed; not caching a negative means the next
     * such mistake lasts one request instead of forever.
     */
    if (out.exists) vaultCache.set(owner, out);
    return { kind: "ok", ...out };
  } catch {
    // A resolve failure must NOT be cached: the adapter being briefly down is
    // not a fact about the owner, and caching it would pin them to the wrong
    // vault until this process restarts.
    return { kind: "unavailable" };
  }
}

async function forward(req: NextRequest, path: string[]) {
  // PATH-TRANSPARENT. The pages already call `${API_BASE_URL}/v1/...`, so the
  // segments arriving here are `["v1", "dashboard"]` and the `/v1` must NOT be
  // re-added — that produced `/v1/v1/dashboard`, which the adapter answers
  // with a 404 that looks like a missing endpoint rather than a routing bug.
  const target = new URL(`/${path.join("/")}`, ADAPTER);
  // Query strings carry `owner`, `day`, pagination — losing them turns a
  // scoped read into a different read that still returns 200.
  target.search = req.nextUrl.search;

  /**
   * TURN THE `owner` THE PAGE SENT INTO THE `vault` THE ADAPTER READS.
   *
   * GETs, plus the mutating routes that SIGN NOTHING — the same allowlist the
   * adapter's own gate uses, for the same reason.
   *
   * `/v1/pay` IS NEVER REWRITTEN. It signs with the agent key the adapter
   * holds, so it is pinned to that vault by definition; redirecting it would
   * ask one vault's key to spend from another's.
   *
   * `/v1/owner-plan` IS, and the comment here used to claim it needed no
   * rewrite because "the payload already names what it acts on". It did not:
   * the handler built against the adapter's configured vault unconditionally,
   * so a visitor asking to freeze their own node got a command naming the
   * OPERATOR's vault. Fixed on both sides — the adapter now reads `?vault=`
   * on that route, and this is what supplies it.
   *
   * An explicit `?vault=` wins — that is how someone reaches a LABELLED vault,
   * which derivation alone cannot find.
   */
  const gate = proxyGate({
    method: req.method,
    path: path.join("/"),
    hasToken: Boolean(TOKEN),
  });

  // REFUSE BEFORE RESOLVING. Asking the factory to derive a vault for a
  // request that is about to be rejected is a wasted round trip, and worse it
  // would populate the cache on behalf of a caller who was never served.
  if (gate.kind === "refuse") {
    return Response.json(
      { error: gate.error, detail: gate.detail },
      { status: gate.status },
    );
  }

  if (gate.mayResolveVault && !target.searchParams.get("vault")) {
    const owner = target.searchParams.get("owner")?.trim();
    if (owner) {
      const resolved = await resolveVaultFor(owner);
      if (resolved.kind === "unavailable") {
        // Pass the uncertainty through rather than resolving it to a fact.
        return Response.json(
          {
            error: "UPSTREAM_UNAVAILABLE",
            owner,
            detail:
              "Could not reach the chain to work out which vault is yours, so " +
              "whether you have one is UNKNOWN — not no. Retry shortly.",
          },
          { status: 503 },
        );
      }
      if (resolved.vault && resolved.exists) {
        target.searchParams.set("vault", resolved.vault);
      } else if (resolved.vault) {
        // Derivable but not created. Saying so is the whole point of the
        // empty state — falling through would read the adapter's OWN vault
        // and show this visitor somebody else's money, which is the bug.
        return Response.json(
          { error: "NO_VAULT", owner, vault: resolved.vault, exists: false },
          { status: 404 },
        );
      } else {
        return Response.json(
          {
            error: "NO_VAULT_ID",
            owner,
            detail:
              "No legal vault id for that account. An implicit account (64 hex " +
              "characters) cannot have one; use a named account.",
          },
          { status: 404 },
        );
      }
    }
  }

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  // Decided above by the one guard. `TOKEN` is non-empty whenever
  // `attachToken` is true, because that is the only branch that sets it.
  if (gate.attachToken) headers.set("authorization", `Bearer ${TOKEN}`);

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      // GET/HEAD must not carry a body; Node throws rather than ignoring it.
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.text(),
      // The adapter reads chain state on every call; caching a budget would
      // show a spent cap as still available.
      cache: "no-store",
    });
  } catch (e) {
    // A refused connection here means the adapter is down, which is a
    // different problem from the adapter rejecting the request — and the
    // page can only say something useful if the two are distinguishable.
    return Response.json(
      {
        error: "the dashboard could not reach the float-adapter",
        adapter: ADAPTER,
        detail: (e as Error).message,
      },
      { status: 502 },
    );
  }

  // Pass the adapter's own status and body through untouched. Translating
  // them would hide the reason codes the vault returns, which are the whole
  // point of its refusals.
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return forward(req, (await ctx.params).path);
}

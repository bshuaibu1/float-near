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

/**
 * Where the adapter actually listens. NOT `NEXT_PUBLIC_` — this name is
 * deliberately server-only, because a `NEXT_PUBLIC_` variable is inlined into
 * the browser bundle and would put the adapter's address back in the client.
 */
const ADAPTER = process.env.FLOAT_ADAPTER_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.FLOAT_API_TOKEN;

/**
 * Methods that change state, and therefore need the token.
 *
 * The adapter answers 503 on mutating routes when no token is configured —
 * deliberately and silently. Mirroring the distinction here means a missing
 * token produces one clear message from the layer the user can actually see,
 * rather than a 503 they have to go and interpret.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function forward(req: NextRequest, path: string[]) {
  // PATH-TRANSPARENT. The pages already call `${API_BASE_URL}/v1/...`, so the
  // segments arriving here are `["v1", "dashboard"]` and the `/v1` must NOT be
  // re-added — that produced `/v1/v1/dashboard`, which the adapter answers
  // with a 404 that looks like a missing endpoint rather than a routing bug.
  const target = new URL(`/${path.join("/")}`, ADAPTER);
  // Query strings carry `owner`, `day`, pagination — losing them turns a
  // scoped read into a different read that still returns 200.
  target.search = req.nextUrl.search;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  if (MUTATING.has(req.method)) {
    if (!TOKEN) {
      return Response.json(
        {
          error: "FLOAT_API_TOKEN is not set on the dashboard server",
          detail:
            "Mutating routes are disabled until it is. Set it in the dashboard's " +
            "environment — not NEXT_PUBLIC_, which would ship it to the browser.",
        },
        { status: 503 },
      );
    }
    headers.set("authorization", `Bearer ${TOKEN}`);
  }

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

/**
 * The adapter's base path, defined ONCE.
 *
 * It was a `const` redeclared in every page that talked to the adapter —
 * nine copies of the same expression, which is how nine call sites came to
 * disagree about whether to send an owner.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";
import { getFloatOwnerSession } from "@/lib/float-session";

/**
 * EVERY call to the adapter, carrying who is asking.
 *
 * WHY THIS EXISTS, and it is not tidiness. Seventeen fetches across seven
 * pages called `${API_BASE_URL}/v1/...` with no owner at all. The proxy
 * resolves `?owner=` into that account's vault and otherwise falls back to
 * whichever vault the adapter is configured with — on the public deployment,
 * the operator's TESTNET demo vault.
 *
 * So the dashboard was multi-tenant on exactly one endpoint. Measured
 * 2026-11-11: a mainnet owner opened `/?owner=test015.near`, the Overview
 * resolved correctly because it was the single call that passed the owner, and
 * Policies rendered the TESTNET budget tree — 100 USDC master budget, a
 * `marketing` agent, a 42.25 balance — as if it were theirs. Incognito did not
 * help, because the requests never mentioned them.
 *
 * ONE DOOR, so a new page cannot reintroduce it by writing the obvious thing.
 * `scripts/check-dashboard-owner.mjs` fails the build on a bare
 * `API_BASE_URL}/v1/` outside this file.
 *
 * THE OWNER GOES IN THE QUERY EVEN FOR POSTs. `/v1/owner-plan` is a POST and
 * the proxy reads `searchParams`, not the body — a payload built against the
 * wrong vault would be handed to a user to SIGN.
 */
export function floatFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith("/")) {
    throw new Error(`floatFetch path must start with "/", got ${JSON.stringify(path)}`);
  }

  const owner = getFloatOwnerSession()?.ownerWallet;
  const url = new URL(`${API_BASE_URL}${path}`, "http://local.invalid");

  /**
   * DO NOT OVERWRITE AN EXPLICIT OWNER. A caller that already put one in the
   * path means it, and the session is the fallback — not the authority.
   */
  if (owner && !url.searchParams.get("owner")) {
    url.searchParams.set("owner", owner);
  }

  // Back to a relative URL: API_BASE_URL is a path on this origin, and the
  // dummy base above exists only so URLSearchParams can be used safely.
  const relative = `${url.pathname}${url.search}`;
  return fetch(relative, { cache: "no-store", ...init });
}

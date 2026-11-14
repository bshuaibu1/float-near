/**
 * Turn an unsigned owner payload into a link the human can just click.
 *
 * WHY THIS EXISTS. Every `vault_plan_*` tool returned a payload and a CLI
 * command, so the answer to "raise my cap" was a 300-character
 * `near contract call-function as-transaction ... sign-with-keychain send`
 * line. The create page has accepted owner-action links the whole time —
 * `?action=<base64url JSON>`, fifteen methods — and nothing built one. A user
 * asked why they got a terminal command when they expected a link, which is
 * the correct instinct: the product's whole pitch is that the human approves
 * in their own wallet, and a CLI line asks them to hold a full-access key at a
 * keyboard instead.
 *
 * NOT EVERY ACTION CAN HAVE A LINK, and that is the reason this is a function
 * rather than a template. The page keeps an allowlist (`OWNER_METHODS` in
 * `web/index.html`) and refuses anything outside it — deliberately, since a
 * link is a thing a stranger can send you. `withdraw` is NOT on that list, so
 * `vault_plan_withdraw` must keep falling back to the CLI. Emitting a URL the
 * page will reject would be worse than emitting none: the user clicks, the
 * page refuses, and the failure looks like the product being broken rather
 * than like an action that is deliberately terminal-only.
 *
 * ENCODING MUST BE UTF-8, NOT `btoa`-style latin1. `web/index.html` says why
 * in its decoder: the dashboard encodes with TextEncoder because `btoa` throws
 * on any code point above U+00FF, and the branch glyph `└─` sits in every
 * child agent's display name. A node LABEL is user-chosen and can be anything.
 * Getting this wrong does not throw here — it hands the page mojibake, and the
 * owner then approves a transaction whose description is wrong, which is worse
 * than a broken link.
 */
import type { OwnerPayload } from "./payloads.js";

/**
 * The methods `web/index.html` will render an approval screen for.
 *
 * MIRRORED, NOT IMPORTED — the page is a static `<script type="module">` and
 * this is TypeScript in a published package, so no import crosses that
 * boundary. `scripts/check-approve-url-methods.mjs` compares the two lists and
 * fails the gate when they drift, because a duplicated allowlist is an
 * allowlist that goes stale.
 */
export const PAGE_OWNER_METHODS: ReadonlySet<string> = new Set([
  "add_node",
  "add_role",
  "set_node_caps",
  "bind_agent",
  "bind_virtual_agent",
  "unbind_virtual_agent",
  "set_recipients",
  "set_cooldown",
  "freeze_node",
  "set_paused",
  "set_strict_allocation",
  "purge_settled",
  "approve_payment",
  "reject_payment",
  "set_approval_threshold",
]);

/** base64url: base64 with the URL-unsafe characters swapped and padding cut. */
function toBase64Url(json: string): string {
  // `Buffer.from(s, "utf8")` is the Node equivalent of TextEncoder — it encodes
  // astral and multi-byte code points correctly, where a latin1 path silently
  // mangles them.
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A link that opens the approval screen for this payload, or `null` when the
 * page cannot render this action and the CLI is the only route.
 *
 * `null` is a real answer, not a failure — see the header.
 */
export function approveUrl(
  p: OwnerPayload,
  opts: { appUrl: string; network: string },
): string | null {
  if (!PAGE_OWNER_METHODS.has(p.methodName)) return null;

  const action = {
    receiverId: p.receiverId,
    methodName: p.methodName,
    args: p.args,
    gasTgas: p.gasTgas,
    depositYocto: p.depositYocto,
    // Carried so the page shows the SAME sentence the agent just said. If the
    // two described the action differently, the owner would be reading one
    // description and signing another.
    summary: p.summary,
  };

  const url = new URL(opts.appUrl);
  url.searchParams.set("action", toBase64Url(JSON.stringify(action)));
  /**
   * NETWORK IS EXPLICIT. The page defaults to mainnet, so a testnet payload
   * carried by a bare link would render against the wrong chain and read the
   * wrong vault — and the owner would be looking at a believable screen for a
   * transaction that cannot be what they think it is.
   */
  url.searchParams.set("network", opts.network);
  return url.toString();
}

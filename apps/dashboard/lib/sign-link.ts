/**
 * Turning a prepared owner payload into a link the owner can sign.
 *
 * This replaced a `near contract call-function ... sign-with-keychain` string
 * that the dashboard printed for copy-paste. That string cannot be run by the
 * owner of a vault whose key lives in a browser wallet: `sign-with-keychain`
 * reads the local near-cli keychain, so following the instruction requires
 * exporting a private key to disk — the exact move this product exists to
 * avoid, and the one this repo already has a scar from.
 *
 * The link instead carries only what builds the transaction, to a page that
 * holds the wallet connection and refuses to sign unless `get_config().owner`
 * equals the connected account.
 */

export type OwnerPayload = {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas?: number;
  depositYocto?: string;
  summary?: string;
};

/** Where the owner signs. The create page serves the `?action=` flow. */
export const SIGN_BASE =
  process.env.NEXT_PUBLIC_FLOAT_SIGN_URL?.trim() || "http://127.0.0.1:8080";

/** near-sdk's `assert_one_yocto` guard: every owner method needs exactly this. */
const ONE_YOCTO = "1";
const DEFAULT_GAS_TGAS = 100;

/**
 * UTF-8 -> base64url.
 *
 * The UTF-8 step is NOT decoration. `btoa` is a Latin-1 function: it THROWS
 * on any code point above U+00FF and silently encodes U+0080..U+00FF as a
 * single byte instead of UTF-8. Measured here with
 * `btoa(JSON.stringify({summary: "<branch glyph>"}))` -> DOMException
 * "Invalid character".
 *
 * That matters because the branch glyph the adapter prefixes to every CHILD
 * agent's display name is U+2514 U+2500. Any link built from an agent label,
 * or from a prose summary that happens to contain an em dash, was one
 * character away from throwing in the user's face.
 *
 * `+` and `/` are then swapped out because they are legal base64 but not
 * legal in a URL query value, and `=` padding is routinely eaten by chat
 * clients. A link that survives being pasted beats one that is canonical.
 *
 * THE SIGNING PAGE MUST DECODE THE SAME WAY. web/index.html does the inverse
 * (base64 -> bytes -> TextDecoder); if it ever reverts to a bare `atob`, the
 * failure is not a crash but mojibake in the summary the owner approves.
 */
export function toBase64Url(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The inverse, for tests and for anything that needs to read a link back. */
export function fromBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  // Pad back to a multiple of 4. `atob` tolerates missing padding, but being
  // explicit removes a variable from the one place a link can silently rot.
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * A signing link for one prepared payload.
 *
 * The `cli` string and the warnings array the adapter also returns are left
 * behind deliberately: a link long enough to be truncated in a copy-paste
 * fails for a reason the user cannot see.
 */
export function signLink(payload: OwnerPayload, network: string): string {
  const slim = {
    receiverId: payload.receiverId,
    methodName: payload.methodName,
    args: payload.args,
    gasTgas: payload.gasTgas ?? DEFAULT_GAS_TGAS,
    depositYocto: payload.depositYocto ?? ONE_YOCTO,
    summary: payload.summary ?? `${payload.methodName} on ${payload.receiverId}`,
  };
  return `${SIGN_BASE}/?network=${encodeURIComponent(network)}&action=${toBase64Url(
    JSON.stringify(slim),
  )}`;
}

/** What a signing page reads back out of a link. Mirrors `signLink`. */
export function readSignLink(url: string): {
  network: string | null;
  action: Record<string, unknown> | null;
} {
  const u = new URL(url);
  const action = u.searchParams.get("action");
  return {
    network: u.searchParams.get("network"),
    action: action ? (JSON.parse(fromBase64Url(action)) as Record<string, unknown>) : null,
  };
}

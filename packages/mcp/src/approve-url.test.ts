import { describe, expect, it } from "vitest";
import { approveUrl, PAGE_OWNER_METHODS } from "./approve-url.js";
import type { OwnerPayload } from "./payloads.js";

const OPTS = { appUrl: "https://usefloat.xyz", network: "mainnet" };

const payload = (over: Partial<OwnerPayload> = {}): OwnerPayload => ({
  receiverId: "v.near",
  methodName: "add_node",
  args: { parent: 0, label: "news" },
  gasTgas: 100,
  depositYocto: "1",
  summary: "Create a news budget",
  warnings: [],
  ...over,
});

/**
 * Decode exactly the way `web/index.html` does, so these tests fail if the
 * encoding and the page's decoder ever stop agreeing. Reimplemented from the
 * page rather than from the encoder, which is the only way the comparison
 * means anything.
 */
function decodeLikeThePage(url: string): Record<string, unknown> {
  const raw = new URL(url).searchParams.get("action")!;
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("approveUrl", () => {
  it("round-trips the payload the page will read", () => {
    const p = payload();
    const got = decodeLikeThePage(approveUrl(p, OPTS)!);
    expect(got.receiverId).toBe("v.near");
    expect(got.methodName).toBe("add_node");
    expect(got.args).toEqual({ parent: 0, label: "news" });
    expect(got.gasTgas).toBe(100);
    expect(got.depositYocto).toBe("1");
  });

  /**
   * The page shows the summary to the owner at the moment they sign. If the
   * link carried a different description from the one the agent just said, the
   * owner reads one thing and approves another.
   */
  it("carries the same summary the agent said", () => {
    const p = payload({ summary: 'Update the "news" budget to 3/day' });
    expect(decodeLikeThePage(approveUrl(p, OPTS)!).summary).toBe(
      'Update the "news" budget to 3/day',
    );
  });

  /**
   * THE ENCODING TRAP THE PAGE DOCUMENTS. `btoa` throws above U+00FF, and the
   * branch glyph `└─` appears in agent display names; a label is user-chosen
   * and can be anything at all. A latin1 path does not throw here — it hands
   * the page mojibake, so the owner approves a transaction whose description
   * is wrong. That is worse than a broken link.
   */
  it("survives non-ASCII in the label and the summary", () => {
    const p = payload({
      args: { parent: 0, label: "新闻" },
      summary: "└─ Créate a “news” budget — 3 USDC/day · naïve ✓ 🚀",
    });
    const got = decodeLikeThePage(approveUrl(p, OPTS)!);
    expect((got.args as Record<string, unknown>).label).toBe("新闻");
    expect(got.summary).toBe("└─ Créate a “news” budget — 3 USDC/day · naïve ✓ 🚀");
  });

  it("is URL-safe: no +, / or = in the action parameter", () => {
    // 40 nodes of filler makes padding and both unsafe characters likely.
    const p = payload({ args: { blob: "a?b&c=d/e+f".repeat(40) } });
    const raw = new URL(approveUrl(p, OPTS)!).searchParams.get("action")!;
    expect(raw).not.toMatch(/[+/=]/);
    // And it still decodes.
    expect(decodeLikeThePage(approveUrl(p, OPTS)!).methodName).toBe("add_node");
  });

  /**
   * NETWORK IS EXPLICIT. The page defaults to mainnet, so a testnet payload in
   * a bare link renders against the wrong chain and reads the wrong vault —
   * a believable screen for a transaction that cannot be what it appears.
   */
  it("pins the network rather than relying on the page's default", () => {
    const url = new URL(approveUrl(payload(), { ...OPTS, network: "testnet" })!);
    expect(url.searchParams.get("network")).toBe("testnet");
  });

  it("honours a non-default app URL", () => {
    const url = approveUrl(payload(), { ...OPTS, appUrl: "https://app.usefloat.xyz" })!;
    expect(url.startsWith("https://app.usefloat.xyz/?")).toBe(true);
  });

  /**
   * THE CASE THAT MAKES THIS A FUNCTION AND NOT A TEMPLATE.
   *
   * `withdraw` is not on the page's allowlist. A link the page will refuse is
   * worse than no link: the user clicks it, gets turned away, and reads that
   * as the product being broken rather than as a terminal-only action.
   */
  it("returns null for an action the page will not render", () => {
    expect(approveUrl(payload({ methodName: "withdraw" }), OPTS)).toBeNull();
    expect(PAGE_OWNER_METHODS.has("withdraw")).toBe(false);
  });

  it("returns a link for every method the page DOES allow", () => {
    for (const m of PAGE_OWNER_METHODS) {
      expect(approveUrl(payload({ methodName: m }), OPTS), `no link for ${m}`).toBeTruthy();
    }
  });
});

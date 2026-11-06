import { describe, it, expect } from "vitest";
import { signLink, readSignLink, toBase64Url, fromBase64Url } from "./sign-link";

/**
 * The link is the whole trust handoff: everything the owner is asked to
 * approve travels inside it, and the signing page will build a transaction
 * from whatever it decodes. A silent corruption here means approving
 * something other than what the page displayed.
 *
 * The round-trip assertions matter more than the shape ones. This repo has
 * already shipped a link that "looked right" and failed to parse on arrival —
 * the user saw "the payload is not valid base64url JSON" — so every test
 * below decodes rather than pattern-matching the string.
 */
const PAYLOAD = {
  receiverId: "v.fac.testnet",
  methodName: "set_node_caps",
  args: { node_id: 1, limits: [{ token: "usdc.fakes.testnet", daily_cap: "150000000" }] },
  gasTgas: 100,
  depositYocto: "1",
  summary: "Set caps on node 1",
};

describe("round trip", () => {
  it("decodes back to exactly what went in", () => {
    const { action } = readSignLink(signLink(PAYLOAD, "testnet"));
    expect(action).toEqual(PAYLOAD);
  });

  it("carries the network", () => {
    expect(readSignLink(signLink(PAYLOAD, "mainnet")).network).toBe("mainnet");
  });

  it("survives args that need escaping", () => {
    const tricky = {
      ...PAYLOAD,
      args: { memo: 'a "quoted" / value + plus', list: ["a.near", "b.near"] },
    };
    const { action } = readSignLink(signLink(tricky, "testnet"));
    expect(action).toEqual(tricky);
  });

  it("survives a long recipients list without losing an entry", () => {
    const many = Array.from({ length: 32 }, (_, i) => `payee${i}.testnet`);
    const { action } = readSignLink(signLink({ ...PAYLOAD, args: { recipients: many } }, "testnet"));
    expect((action as { args: { recipients: string[] } }).args.recipients).toHaveLength(32);
  });
});

describe("non-ASCII text", () => {
  /**
   * `btoa` is a Latin-1 function. It THROWS on any code point above U+00FF
   * and silently mis-encodes U+0080..U+00FF as single bytes rather than
   * UTF-8. Measured: btoa(JSON.stringify({summary:"- marketing"})) with the
   * branch glyph throws DOMException "Invalid character".
   *
   * That glyph is in the display name of every CHILD agent, so any link
   * built from an agent's label was one keystroke away from crashing.
   */
  it("does not throw on the branch glyph, which is in every child agent's name", () => {
    const glyph = String.fromCharCode(0x2514, 0x2500);
    expect(() => signLink({ ...PAYLOAD, summary: `Freeze ${glyph} marketing` }, "testnet")).not.toThrow();
  });

  it("round-trips the branch glyph rather than mangling it", () => {
    const glyph = String.fromCharCode(0x2514, 0x2500);
    const summary = `Freeze ${glyph} marketing`;
    const { action } = readSignLink(signLink({ ...PAYLOAD, summary }, "testnet"));
    expect((action as { summary: string }).summary).toBe(summary);
  });

  it("round-trips an em dash, which prose summaries collect by themselves", () => {
    const summary = String.fromCharCode(0x50, 0x61, 0x75, 0x73, 0x65, 0x20, 0x2014, 0x20, 0x61, 0x6c, 0x6c);
    const { action } = readSignLink(signLink({ ...PAYLOAD, summary }, "testnet"));
    expect((action as { summary: string }).summary).toBe(summary);
  });

  it("round-trips astral-plane characters (surrogate pairs)", () => {
    const emoji = String.fromCodePoint(0x1f680);
    const { action } = readSignLink(signLink({ ...PAYLOAD, summary: `go ${emoji}` }, "testnet"));
    expect((action as { summary: string }).summary).toBe(`go ${emoji}`);
  });

  it("round-trips Latin-1 range text as UTF-8, not as raw bytes", () => {
    // U+00E9 does not throw under btoa - it encodes as ONE byte, which is
    // not UTF-8. Anything outside this JS pair reading the payload would see
    // a corrupt string, so the failure is silent rather than loud.
    const summary = `caf${String.fromCharCode(0xe9)}`;
    const { action } = readSignLink(signLink({ ...PAYLOAD, summary }, "testnet"));
    expect((action as { summary: string }).summary).toBe(summary);
  });

  it("round-trips non-ASCII inside ARGS, not just the summary", () => {
    const glyph = String.fromCharCode(0x2514, 0x2500);
    const { action } = readSignLink(signLink({ ...PAYLOAD, args: { memo: glyph } }, "testnet"));
    expect((action as { args: { memo: string } }).args.memo).toBe(glyph);
  });
});

describe("the encoding is URL-safe", () => {
  it("emits no character that a query value or a paste would mangle", () => {
    // `+` becomes a space when a query string is parsed; `/` and `=` are
    // routinely chewed by chat clients. Any of them means a link that works
    // when clicked and fails when pasted.
    for (let i = 0; i < 40; i++) {
      const b64 = toBase64Url(JSON.stringify({ pad: "x".repeat(i) }));
      expect(b64).not.toMatch(/[+/=]/);
    }
  });

  it("decodes every padding alignment - the off-by-one that breaks 1 in 3", () => {
    // Stripping `=` is only safe if the decoder tolerates it. Lengths mod 4
    // cycle through all three padding cases, so a decoder that needs padding
    // fails on roughly two thirds of payloads - intermittently, which reads
    // as "sometimes the link is corrupt".
    for (let i = 0; i < 40; i++) {
      const json = JSON.stringify({ pad: "x".repeat(i) });
      expect(fromBase64Url(toBase64Url(json))).toBe(json);
    }
  });

  it("REVERSES the substitution, not just applies it", () => {
    /**
     * Most payloads never produce a `+` or `/` at all, so a decoder that
     * forgets to swap `-`/`_` back still round-trips them perfectly - and a
     * test built from ordinary payloads passes against a broken decoder.
     * Mutation-confirmed: dropping the reverse substitution survived the
     * whole suite.
     *
     * With pure ASCII only the FOURTH sextet of each 3-byte block can reach
     * 62/63, because it is `byte2 & 0x3F`. So `>` (0x3E) and `?` (0x3F) have
     * to sit at byte offsets 2 mod 3. "ab>de?" places both.
     */
    const aligned = "ab>de?";
    const encoded = toBase64Url(aligned);
    expect(encoded).toContain("-"); // was '+'
    expect(encoded).toContain("_"); // was '/'
    expect(fromBase64Url(encoded)).toBe(aligned);
  });

  it("round-trips through signLink at every byte alignment", () => {
    // The JSON wrapper shifts where the summary lands, so pad through all
    // three alignments rather than trusting one happy case.
    for (const pad of ["", " ", "  "]) {
      const summary = `${pad}ab>de?`;
      const { action } = readSignLink(signLink({ ...PAYLOAD, summary }, "testnet"));
      expect((action as { summary: string }).summary).toBe(summary);
    }
  });

  it("the action parameter alone is enough to rebuild the payload", () => {
    const url = new URL(signLink(PAYLOAD, "testnet"));
    const raw = url.searchParams.get("action")!;
    expect(JSON.parse(fromBase64Url(raw))).toEqual(PAYLOAD);
  });
});

describe("defaults", () => {
  it("attaches one yocto when none is given, or assert_one_yocto rejects it", () => {
    const { gasTgas, depositYocto } = readSignLink(
      signLink({ receiverId: "v.testnet", methodName: "set_paused", args: { paused: true } }, "testnet"),
    ).action as unknown as { gasTgas: number; depositYocto: string };
    expect(depositYocto).toBe("1");
    expect(gasTgas).toBe(100);
  });

  it("does NOT override a deposit that was given", () => {
    const { action } = readSignLink(signLink({ ...PAYLOAD, depositYocto: "2" }, "testnet"));
    expect((action as { depositYocto: string }).depositYocto).toBe("2");
  });

  it("falls back to a readable summary rather than an empty one", () => {
    const { action } = readSignLink(
      signLink({ receiverId: "v.testnet", methodName: "freeze_node", args: {} }, "testnet"),
    );
    expect((action as { summary: string }).summary).toBe("freeze_node on v.testnet");
  });
});

describe("the network parameter", () => {
  it("is encoded, so it cannot inject a second query parameter", () => {
    // An unencoded network would let its value close the parameter and open
    // another - including a second `action=`, which some parsers resolve to
    // the LAST occurrence. That is a payload swap: the owner reads one
    // summary and signs whatever the trailing action says.
    const hostile = "testnet&action=SPOOFED";
    const url = new URL(signLink(PAYLOAD, hostile));
    expect(url.searchParams.getAll("action")).toHaveLength(1);
    expect(url.searchParams.get("network")).toBe(hostile);
    expect(readSignLink(url.toString()).action).toEqual(PAYLOAD);
  });
});

describe("what is deliberately NOT carried", () => {
  it("omits the near-cli string, which cannot be run by a browser-wallet owner", () => {
    const withCli = { ...PAYLOAD, cli: "near contract call-function ... sign-with-keychain send" };
    const { action } = readSignLink(signLink(withCli, "testnet"));
    expect(action).not.toHaveProperty("cli");
  });
});

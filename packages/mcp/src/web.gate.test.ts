import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The create page's agent gate.
 *
 * WHAT THIS CAN AND CANNOT COVER. `web/index.html` is standalone HTML served
 * to a browser with no build step, so it cannot export anything and there is
 * no DOM library installed to drive it headlessly. These tests therefore do
 * two different things, and the difference matters:
 *
 *   - The key validator is EXTRACTED from the page and executed. That is a
 *     real behavioural test of the most security-critical line, run against
 *     the same source the browser gets.
 *   - Everything else is a source assertion. Weaker — it pins shape, not
 *     behaviour — but it catches the specific regressions that would
 *     otherwise be silent, and silence is the whole problem with this
 *     feature: a gate that fails open looks exactly like a gate that passed.
 *
 * A rendered check is still owed here. Recorded rather than implied.
 */

const PAGE = resolve(import.meta.dirname, "..", "..", "..", "web", "index.html");
const html = () => readFileSync(PAGE, "utf8");

describe("the agent key validator", () => {
  /**
   * Pulled out of the page rather than retyped, so this cannot drift into
   * testing a copy that agrees with itself while the page ships something
   * else.
   */
  function pageRegex(): RegExp {
    const m = html().match(/const AGENT_OK =[\s\S]*?(\/\^ed25519:.*?\/)\.test/);
    expect(m, "no agent key validator found in web/index.html").not.toBeNull();
    // eslint-disable-next-line no-eval
    return eval(m![1]) as RegExp;
  }

  it("accepts real ed25519 keys taken from chain", () => {
    const re = pageRegex();
    // Both measured on testnet, 2026-11-03.
    expect(re.test("ed25519:9ErYvQWQeQNFRAVW4qsaNiPVf4zSQFidTPdeJMCXXDvJ")).toBe(true);
    expect(re.test("ed25519:2m1gsABVwp2wCrfQfpsUsUTLva7VJkhEhxzPQm5HBdVZ")).toBe(true);
  });

  /**
   * The panel renders this value to a user as the thing they are authorising,
   * so anything reaching it is implicitly vouched for. `ed25519:` followed by
   * arbitrary text must never render as a plausible key.
   */
  it("rejects malformed and hostile input", () => {
    const re = pageRegex();
    for (const bad of [
      "9ErYvQWQeQNFRAVW4qsaNiPVf4zSQFidTPdeJMCXXDvJ", // the prefix is required
      "ed25519:",
      "ed25519:<img src=x onerror=alert(1)>",
      "ed25519:0OIlvQWQeQNFRAVW4qsaNiPVf4zSQFidTPdeJMCXXDvJ", // 0 O I l are not base58
      "ed25519:9ErYvQWQeQ", // too short
      "secp256k1:9ErYvQWQeQNFRAVW4qsaNiPVf4zSQFidTPdeJMCXXDvJ", // wrong curve
    ]) {
      expect(re.test(bad), `${bad} must be rejected`).toBe(false);
    }
  });

  /**
   * Anchored at BOTH ends. Without `$` a valid prefix followed by anything
   * passes, which is exactly how an injected payload rides along behind a
   * real key.
   */
  it("is anchored at both ends", () => {
    const src = pageRegex().source;
    expect(src.startsWith("^"), "validator is not anchored at the start").toBe(true);
    expect(src.endsWith("$"), "validator is not anchored at the end").toBe(true);
  });
});

describe("consent, not the link, decides what is signed", () => {
  /**
   * THE DECLINE BUTTON MUST NOT BE DECORATIVE.
   *
   * The link's request (`RAW_AGENT`) and the user's consent (`bindAgent`) are
   * different facts. If the transaction sent the former, declining would bind
   * the agent anyway — the gate would collect a decision and ignore it, which
   * is worse than having no gate at all, because it manufactures the
   * appearance of consent.
   */
  it("sends bindAgent in the transaction, never the raw URL parameter", () => {
    const src = html();
    expect(src).toMatch(/agent_pk:\s*bindAgent\b/);

    // And RAW_AGENT must never be what gets signed.
    expect(src).not.toMatch(/agent_pk:\s*RAW_AGENT\b/);
  });

  /** Consent starts absent. A truthy default would bind without being asked. */
  it("starts with no consent recorded", () => {
    expect(html()).toMatch(/let bindAgent = null;/);
  });

  /**
   * The gate must be in `show()`'s hide-list. A panel missing from it is
   * never hidden, so it would persist underneath later screens — including
   * the one that says the vault was created.
   */
  it("is a panel show() knows how to hide", () => {
    const m = html().match(/for \(const s of \[([^\]]+)\]\) \$\(s\)\.classList\.add\("hide"\)/);
    expect(m, "show()'s panel list not found").not.toBeNull();
    expect(m![1]).toContain('"agent"');
  });

  /**
   * THE GATE NEEDS ITS OWN ESCAPE HATCH.
   *
   * Moving it in front of the plan took "use a different wallet" with it, so
   * a user arriving with the wrong wallet connected could SEE the wrong vault
   * id on this screen and have no way to act on it except closing the tab.
   * Observed live 2026-11-03: the gate read `work12-testnet.fac...` while the
   * intended owner was a different account.
   *
   * Both buttons must share ONE handler. A second inline `signOut` is how the
   * plan's button and this one drift into doing different things.
   */
  it("lets the user switch wallets from the gate, using the same handler", () => {
    const src = html();
    expect(src).toMatch(/id="btn-agent-switch"/);
    expect(src).toMatch(/\$\("btn-agent-switch"\)\.onclick = disconnect;/);
    expect(src).toMatch(/\$\("btn-disconnect"\)\.onclick = disconnect;/);
    // Exactly one signOut implementation.
    expect(src.match(/\.signOut\(\)/g)?.length).toBe(1);
  });

  /**
   * And it names the OWNER, not only the derived vault. An owner-less link
   * takes whatever wallet is open; recognising a mistake from a derived
   * prefix alone asks the user to do string surgery.
   */
  it("shows which account is connected", () => {
    const src = html();
    expect(src).toMatch(/id="a-owner"/);
    expect(src).toMatch(/\$\("a-owner"\)\.textContent = who;/);
  });

  /**
   * The key is shown in full. A middle-ellipsis is precisely where a swapped
   * key hides — two keys sharing a prefix and suffix are indistinguishable
   * when the middle is elided, and the whole panel exists to let a human
   * compare one string against another.
   */
  it("renders the key without truncating it", () => {
    const src = html();
    expect(src).toMatch(/\$\("a-key"\)\.textContent = RAW_AGENT;/);
    // The plan row may abbreviate; the gate must not.
    expect(src).not.toMatch(/\$\("a-key"\)\.textContent = RAW_AGENT\.slice/);
  });
});

describe("the optional vault label", () => {
  /**
   * THE LABEL IS PART OF THE ADDRESS.
   *
   * `resolve_vault` derives `<prefix>-<label>.<factory>`. If the page sent a
   * label while rendering the unlabelled id, the user would approve a deposit
   * for a different account than the one they were shown — the same class of
   * mistake the owner-mismatch guard exists to prevent, and silent, because
   * both addresses look plausible.
   */
  it("includes the label in the address it displays", () => {
    const src = html();
    expect(src).toMatch(/const suffix = LABEL \? `-\$\{LABEL\}` : "";/);
    expect(src).toMatch(/\$\{derivePrefix\(who\)\}\$\{suffix\}/);
  });

  /** And sends it, rather than the hardcoded null it replaced. */
  it("sends the label in the transaction", () => {
    expect(html()).toMatch(/label: LABEL,/);
    expect(html()).not.toMatch(/label: null,/);
  });

  /**
   * Validated to the CONTRACT's rule. The factory panics BAD_LABEL for
   * anything outside 1-16 of [a-z0-9] — after the user has signed and paid
   * for the transaction, which is the wrong moment to learn the link was
   * malformed.
   */
  it("validates the label the way the contract does", () => {
    const m = html().match(/const LABEL_OK = LABEL === null \|\| (\/\^.*?\/)\.test/);
    expect(m, "no label validator found").not.toBeNull();
    // eslint-disable-next-line no-eval
    const re = eval(m![1]) as RegExp;
    for (const ok of ["fleet", "a", "0", "abc123", "x".repeat(16)]) {
      expect(re.test(ok), `${ok} should be accepted`).toBe(true);
    }
    for (const bad of ["", "x".repeat(17), "Fleet", "my-label", "my.label", "a_b", "<script>"]) {
      expect(re.test(bad), `${bad} must be rejected`).toBe(false);
    }
  });
});

describe("owner-action mode", () => {
  const LIB = resolve(import.meta.dirname, "..", "..", "..", "contracts", "vault", "src", "lib.rs");

  /** The page's whitelist, extracted from the page itself. */
  function whitelist(): Set<string> {
    const m = html().match(/const OWNER_METHODS = new Set\(\[([\s\S]*?)\]\);/);
    expect(m, "no OWNER_METHODS whitelist found in web/index.html").not.toBeNull();
    return new Set([...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
  }

  /**
   * THE WHITELIST IS THE SECURITY BOUNDARY, so it must not drift.
   *
   * It bounds what a `?action=` link can make the page sign. A name that no
   * longer exists on the contract is dead weight that still reads as
   * authoritative; worse, a method RENAMED in Rust would leave the old name
   * whitelisted while the new one is silently unsignable.
   */
  it("lists only methods the vault contract actually has", () => {
    if (!existsSync(LIB)) {
      console.warn(`SKIPPED: ${LIB} not present`);
      return;
    }
    const src = readFileSync(LIB, "utf8");
    const real = new Set([...src.matchAll(/pub fn (\w+)\s*\(/g)].map((m) => m[1]));
    // Positive control: a regex matching nothing would make every entry valid.
    expect(real.has("add_role"), "the extractor found no known method").toBe(true);
    for (const m of whitelist()) {
      expect(real.has(m), `${m} is whitelisted but is not a pub fn on the vault`).toBe(true);
    }
  });

  /**
   * And it must NOT contain anything that moves tokens directly. The whole
   * point is that a crafted link can only do what the owner could already do
   * through the vault's policy surface.
   */
  it("whitelists no token-moving or key-granting method", () => {
    const list = whitelist();
    for (const forbidden of ["ft_transfer", "ft_transfer_call", "withdraw", "new", "migrate"]) {
      expect(list.has(forbidden), `${forbidden} must never be signable from a link`).toBe(false);
    }
  });

  /**
   * THE OWNER CHECK IS WHAT MAKES THE WHITELIST SAFE. The list bounds WHAT
   * may be called; this bounds WHERE. Without it, a link could aim a real
   * owner method at a vault the connected wallet does not own — the call
   * would fail on chain, but only after the user paid gas for it.
   */
  it("refuses when the connected wallet does not own the target vault", () => {
    const src = html();
    expect(src).toMatch(/get_config/);
    expect(src).toMatch(/cfg\.owner !== who/);
  });

  /** It signs the payload's own method, not a hardcoded one. */
  it("signs the method from the payload", () => {
    const src = html();
    expect(src).toMatch(/methodName: ACTION\.methodName,/);
    expect(src).toMatch(/receiverId: ACTION\.receiverId,/);
  });

  /**
   * Arguments are rendered in full. A summary is the link describing itself,
   * which is exactly the claim under suspicion when a link is tampered with.
   */
  /**
   * THE PAGE MUST NOT SAY IT IS CREATING A VAULT WHEN IT IS NOT.
   *
   * The <h1> and subtitle are static markup - "Create your Float vault" and
   * "Connect the wallet that will own it." - and the only code that ever
   * touched them set the title to "Done" at the end. So an owner who clicked
   * "freeze marketing" on the dashboard landed on a page offering to create a
   * vault and asking them to connect the wallet that would OWN it.
   *
   * Two ways that goes wrong, and both are bad: a careful owner closes the tab
   * because the page is describing something they did not ask for, and a
   * careless one approves believing a 3-NEAR creation deposit is coming. The
   * signature itself was always correct - freeze_node, one yocto - but the
   * sentence above it was not, and the sentence is what the owner reads.
   */
  it("re-titles the page for an owner action instead of offering to create a vault", () => {
    const src = html();
    // Positive control FIRST: if the create copy has been renamed, the
    // assertions below would pass against a page that no longer says it.
    expect(src, "the create-flow heading is gone; this test needs rewriting").toContain(
      "Create your Float vault",
    );
    const m = src.match(/RAW_ACTION[\s\S]{0,400}?\$\("title"\)\.textContent/);
    expect(
      m,
      "nothing re-titles the page when the link carries ?action= - it still reads 'Create your Float vault'",
    ).not.toBeNull();
  });

  it("tells the owner which vault they are connecting to approve against", () => {
    const src = html();
    // The subtitle must name the TARGET, not say "the wallet that will own it".
    const m = src.match(/\$\("sub"\)\.textContent[\s\S]{0,200}?receiverId/);
    expect(m, "the action-mode subtitle does not name the vault being changed").not.toBeNull();
  });

  /**
   * And it must NOT promise a deposit. The create flow quotes ~3 NEAR; an
   * owner action takes one yocto, and the connect screen is where someone
   * decides whether to proceed.
   */
  it("says no deposit is taken, on the screen where the owner decides", () => {
    expect(html()).toMatch(/Nothing is created and no deposit is taken/);
  });

  it("shows the real arguments, not only the summary", () => {
    expect(html()).toMatch(/\$\("x-args"\)\.textContent = JSON\.stringify\(ACTION\.args/);
  });
});

describe("module constant ordering (temporal dead zone)", () => {
  /**
   * A `const` IS HOISTED BUT UNREADABLE UNTIL ITS OWN LINE RUNS.
   *
   * `RPC_URL` was declared beside the function that reads it, near the bottom
   * of the script. `render()` runs during init, the owner-action path calls
   * `view()` from `render()`, and that read hit the dead zone every time:
   *
   *   Could not check this vault: Cannot access 'RPC_URL' before initialization
   *
   * The create path never saw it — it reads the same constant later, from a
   * click handler, long after the declaration has executed. So the bug was
   * invisible to every path that already worked.
   *
   * NOTHING ELSE CATCHES THIS. `node --check` is syntax-only and the file is
   * valid; a scan for undefined identifiers passes because every name does
   * resolve. Only the ORDER is wrong, and order is a runtime property. This
   * approximates it statically: a module-level constant referenced anywhere
   * at or after `render()` must be declared before it.
   */
  it("declares every module constant before render() can run", () => {
    const src = html().match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(src, "no module script found in the page").toBeTruthy();

    const renderAt = src!.indexOf("function render(");
    expect(renderAt, "render() not found — this check would pass vacuously").toBeGreaterThan(0);

    const consts = [...src!.matchAll(/^      const ([A-Z_][A-Z0-9_]*) =/gm)];
    // Positive control: a pattern matching nothing would make this vacuous.
    expect(consts.length).toBeGreaterThan(5);

    // `String.raw`, NOT a plain template literal. In a template literal `\b`
    // is the BACKSPACE character, not a word boundary — so this read as
    // /<BS>NAME<BS>/, matched nothing, emptied the list, and the entire test
    // passed VACUOUSLY. It was caught only by mutating the page and watching
    // the test stay green, which is the only thing that can distinguish a
    // guard that holds from a guard that cannot fire.
    const late = consts
      .filter((m) => new RegExp(String.raw`\b${m[1]}\b`).test(src!.slice(renderAt)))
      .filter((m) => m.index! > renderAt)
      .map((m) => m[1]);

    expect(late, `declared after render() but read by it: ${late.join(", ")}`).toEqual([]);
  });
});

/**
 * These EXECUTE code lifted out of the page rather than matching its text.
 *
 * web/index.html has no module boundary, so the usual options are a browser
 * or a regex. A regex test passes when the words are present and says nothing
 * about what the function does; extracting the body and running it gives a
 * real behavioural assertion for the price of one `new Function`.
 */
describe("what the owner is told they are sending", () => {
  function depositText(): (y: bigint | string) => string {
    const src = html();
    const m = src.match(/const depositText = \(y\) => \{[\s\S]*?\n      \};/);
    expect(m, "depositText not found in web/index.html").not.toBeNull();
    const near = "const near = (y) => (Number(y) / 1e24).toFixed(3);";
    // eslint-disable-next-line no-new-func
    return new Function(`${near}\n${m![1] ? m![0] : m![0]}\nreturn depositText;`)();
  }

  /**
   * THE REGRESSION. An owner action attaches exactly one yocto because
   * `assert_one_yocto` demands it, and `near(1n)` is "0.000" - so the screen
   * where someone decides whether to sign read "you send 0.000 NEAR".
   *
   * Same defect the dashboard had with "$0.000": a figure that is not nothing,
   * shown as nothing.
   */
  it("never shows a non-zero deposit as zero", () => {
    const f = depositText();
    expect(f(1n)).toBe("1 yocto");
    expect(f(1n)).not.toMatch(/^0\.000/);
    expect(f(1000n)).toBe("less than 0.001 NEAR");
    expect(f(1000n)).not.toMatch(/^0\.000/);
  });

  it("says nothing is sent when nothing is", () => {
    expect(depositText()(0n)).toBe("nothing");
  });

  it("still renders a real funding deposit in NEAR", () => {
    expect(depositText()(3_370_000_000_000_000_000_000_000n)).toBe("3.370 NEAR");
  });
});

describe("the completed-action panel", () => {
  /**
   * "Vault created." was hardcoded in the markup, so freezing an agent ended
   * on a green panel announcing a vault had been created - which is the kind
   * of thing that sends someone looking for a vault they now believe exists.
   */
  it("does not hardcode 'Vault created' into the done panel", () => {
    const src = html();
    const start = src.indexOf('<div id="done"');
    expect(start, "done panel not found").toBeGreaterThan(-1);
    // COMMENTS STRIPPED. The panel carries a comment explaining why the
    // string was removed, and the first version of this test matched its own
    // documentation - the same false positive as a grep for pure black
    // finding the note about not using pure black.
    const panel = src.slice(start, start + 1600).replace(/<!--[\s\S]*?-->/g, "");
    // Positive control: this really is the block with the title element, so a
    // miss below means the string is gone, not that the slice drifted.
    expect(panel, "sliced the wrong block").toContain('id="d-title"');
    expect(
      /Vault created/.test(panel),
      "the done panel still hardcodes 'Vault created' for every action",
    ).toBe(false);
  });

  /**
   * Asserts the BEHAVIOUR, not the punctuation. An earlier version pinned
   * `"Vault created."` with a full stop and broke the moment the string
   * became a heading rather than a log line - a test failing on a design
   * decision it has no opinion about.
   *
   * What matters is that the two flows set DIFFERENT outcomes: one says a
   * vault was created, the other must not.
   */
  it("gives each flow its own outcome, rather than assuming one", () => {
    const src = html();
    const titles = [...src.matchAll(/\$\("d-title"\)\.textContent\s*=\s*([^;]+);/g)].map((m) =>
      m[1].trim(),
    );
    expect(titles.length, "both flows should set the done title").toBeGreaterThanOrEqual(2);
    expect(titles.some((t) => /Vault created/.test(t)), "the create flow sets its own").toBe(true);
    expect(
      titles.filter((t) => /Vault created/.test(t)).length,
      "only ONE flow may claim a vault was created",
    ).toBe(1);
  });

  /**
   * The 294 KB note is TRUE of a vault creation and nonsense for an owner
   * action, which sends about a hundred bytes. Both flows showed the same
   * panel, so every freeze told the owner it carried the whole contract.
   */
  it("does not claim every transaction carries the contract", () => {
    const src = html();
    const start = src.indexOf('<div id="signing"');
    const panel = src.slice(start, start + 700);
    expect(panel, "sliced the wrong block").toContain('id="s-note"');
    expect(
      /\d+ KB/.test(panel),
      "the shared signing panel still hardcodes a contract size for every flow",
    ).toBe(false);

    // Each flow sets its own line, and the create one MEASURES rather than
    // quoting: a literal drifts from the artifact the moment the wasm is
    // rebuilt, and this page already displays a computed size on the plan
    // screen. Two different numbers for one file is worse than none.
    expect(src).toMatch(/\$\("s-note"\)\.textContent[\s\S]{0,300}?wasm\.length \/ 1024/);
    expect(
      /"This one carries the whole contract, about \d+ KB/.test(src),
      "the size is hardcoded again",
    ).toBe(false);
  });
});

describe("standing advice is shown only when it applies", () => {
  it("does not promise a recoverable deposit for a one-yocto action", () => {
    expect(html()).toMatch(/dep > 1n/);
  });

  it("mentions a public key only when the arguments contain one", () => {
    const src = html();
    expect(src).toMatch(/hasPublicKey/);
    expect(src).toMatch(/includes\("ed25519:"\)/);
  });
});

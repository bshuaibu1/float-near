// @vitest-environment happy-dom
/**
 * The InfoDot's behaviour, driven in a real DOM.
 *
 * WHY THIS FILE EXISTS, HAVING ARGUED AGAINST IT
 *
 * I shipped this component with no test and said so: the dashboard had no DOM
 * environment, every other test here is pure logic under lib/, and adding one
 * for a single presentational component did not seem worth the dependency. I
 * verified it in a browser instead.
 *
 * That reasoning was half right. The browser checks were real evidence, but
 * they were evidence ONCE - nothing stops the next edit from breaking any of
 * it silently, and three of these behaviours are the kind that look fine
 * until someone is mid-gesture.
 *
 * ONE new dev dependency, `happy-dom`, opted into by the docblock above
 * rather than configured globally: the other 135 tests are pure and should
 * stay in the fast node environment. React 19 exports `act` directly, so no
 * testing-library either.
 *
 * WHAT THIS STILL CANNOT COVER, recorded rather than implied: the typography
 * bug. Putting the dot in a heading made its panel inherit font-weight 600
 * and letter-spacing -0.55px from the <h2>, which I caught by measuring in a
 * browser. happy-dom has no CSS engine for Tailwind utilities, so it cannot
 * see that. The last test below pins the classes that fix it and says why
 * that is the weaker check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InfoDot } from "./info-dot";

let container: HTMLElement | null = null;
let root: Root | null = null;

function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(ui);
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const trigger = () => document.querySelector("button") as HTMLButtonElement;
const panel = () => document.querySelector('[role="note"]') as HTMLElement | null;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

const dot = (
  <InfoDot label="why agents are not added from this page">
    Agents are added with <code>vault_add_role</code>.
  </InfoDot>
);

describe("InfoDot", () => {
  it("starts closed, with the panel absent rather than hidden", () => {
    render(dot);
    expect(panel()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on click and wires aria-controls to the panel it opened", () => {
    render(dot);
    click(trigger());
    const p = panel();
    expect(p).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(p!.id);
    expect(p!.id, "the panel needs a stable id for aria-controls to point at").toBeTruthy();
  });

  /**
   * The glyph is the letter "i", which announces as "i". Without a label a
   * screen reader user is told there is a button called "i" and nothing about
   * what it does.
   */
  it("names what it opens, since the glyph alone says nothing", () => {
    render(dot);
    expect(trigger().getAttribute("aria-label")).toBe(
      "Explain why agents are not added from this page",
    );
    click(trigger());
    expect(trigger().getAttribute("aria-label")).toBe(
      "Hide: why agents are not added from this page",
    );
  });

  it("closes on Escape and gives focus back to the trigger", () => {
    render(dot);
    click(trigger());
    expect(panel()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(panel()).toBeNull();
    // Without this a keyboard user is left with focus on a removed element,
    // i.e. on <body>, and has to tab from the top of the page again.
    expect(document.activeElement).toBe(trigger());
  });

  it("ignores other keys", () => {
    render(dot);
    click(trigger());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    });
    expect(panel()).not.toBeNull();
  });

  it("closes when you point at something else", () => {
    render(dot);
    click(trigger());
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  /**
   * THE SUBTLE ONE, and the reason the listener is on `pointerdown` rather
   * than `click`.
   *
   * Selecting the text inside the panel to copy an account id is a drag that
   * STARTS inside it and often ENDS outside. That fires `click` on the
   * document, so a click-based outside-dismiss closes the panel mid-selection
   * and throws away what the user was reaching for.
   *
   * Paired with the test above on purpose: a listener that closed on every
   * pointerdown would pass that one and fail this one, and no listener at all
   * would do the reverse. Neither test means much alone.
   */
  it("does NOT close when the gesture starts inside it", () => {
    render(dot);
    click(trigger());
    const inside = panel()!.querySelector("code") ?? panel()!;
    act(() => {
      inside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(panel()).not.toBeNull();
  });

  it("toggles shut when the trigger is clicked again", () => {
    render(dot);
    click(trigger());
    expect(panel()).not.toBeNull();
    click(trigger());
    expect(panel()).toBeNull();
  });

  /**
   * A dot nobody opens must cost nothing. A page can hold several, and
   * attaching two document-level listeners per instance at mount is the kind
   * of thing that is invisible until a list renders forty of them.
   */
  it("attaches no document listeners while closed", () => {
    const add = vi.spyOn(document, "addEventListener");
    render(dot);
    const atMount = add.mock.calls.filter(([t]) => t === "keydown" || t === "pointerdown");
    expect(atMount, "listeners were attached before anything was opened").toEqual([]);

    click(trigger());
    const afterOpen = add.mock.calls.filter(([t]) => t === "keydown" || t === "pointerdown");
    expect(afterOpen.length, "opening should attach exactly the two").toBe(2);
  });

  it("removes them again on close", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    render(dot);
    click(trigger());
    click(trigger());
    const removed = remove.mock.calls.filter(([t]) => t === "keydown" || t === "pointerdown");
    expect(removed.length).toBe(2);
  });

  it("removes them when unmounted while open", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    render(dot);
    click(trigger());
    act(() => root!.unmount());
    root = null;
    const removed = remove.mock.calls.filter(([t]) => t === "keydown" || t === "pointerdown");
    expect(removed.length, "an open dot that unmounts leaks both listeners").toBe(2);
  });

  it("renders its children, not a flattened string", () => {
    render(dot);
    click(trigger());
    expect(panel()!.querySelector("code")?.textContent).toBe("vault_add_role");
  });

  /**
   * THE WEAKEST TEST HERE, and deliberately labelled as such.
   *
   * Placing a dot inside a heading makes this panel a descendant of an <h2>,
   * so weight and letter-spacing inherit. Measured in a real browser before
   * the fix: font-weight 600, letter-spacing -0.55px - body prose rendered as
   * tight bold text.
   *
   * happy-dom has no CSS engine for Tailwind utilities, so it cannot compute
   * that. This asserts the classes that fix it are present, which is a proxy:
   * it catches a deletion, not a regression in what the classes do. The real
   * evidence is the browser measurement, and it is recorded in the
   * component's own comment so the next person does not read these as
   * decoration and remove them.
   */
  it("keeps the typography reassertions that stop it inheriting a heading", () => {
    render(dot);
    click(trigger());
    const cls = panel()!.className;
    expect(cls, "font-normal removed; the panel will inherit a heading's weight").toContain(
      "font-normal",
    );
    expect(cls, "tracking-normal removed; it will inherit tight heading tracking").toContain(
      "tracking-normal",
    );
  });

  /**
   * THE TOUCH TARGET, which is invisible by construction and so is exactly
   * the kind of thing that gets tidied away.
   *
   * The dot is 15x15 - right for a glyph beside a heading, half the 44px a
   * finger needs (WCAG 2.5.5). It was the smallest control on /agents at
   * 375px. Growing the button would push the heading's line box around, so
   * the hit area is a transparent `::after` centred on the dot: it belongs
   * to the button, so a tap in it activates the button, and it is out of
   * flow, so nothing moves.
   *
   * SAME CAVEAT AS THE TEST ABOVE, stated rather than implied: happy-dom has
   * no CSS engine, so this asserts the classes are present, not that they
   * compute to 44px. It catches a deletion. The 44px itself was measured in
   * a browser and is recorded in the component.
   *
   * `max-md:` is asserted too, and that is not pedantry. Written as a plain
   * `after:size-11` the overlay would also exist on desktop, where it would
   * swallow mouse clicks meant for the heading text beside it - a 44px
   * invisible box over prose, for no benefit, since a mouse hits 15px fine.
   */
  it("extends the tap target to 44px on touch widths without moving the dot", () => {
    render(dot);
    const cls = trigger().className;

    // The visible dot is unchanged at every width.
    expect(cls, "the dot is no longer 15px; it was sized to sit beside a heading").toContain(
      "size-[15px]",
    );

    // The overlay exists, is 44px, and is centred on the dot.
    for (const part of [
      "max-md:after:size-11",
      "max-md:after:absolute",
      "max-md:after:-translate-x-1/2",
      "max-md:after:-translate-y-1/2",
      "max-md:after:content-['']",
    ]) {
      expect(cls, `${part} removed; the tap target drops back to 15px`).toContain(part);
    }

    // And the button is a positioning context, or the overlay centres on
    // whatever ancestor happens to be positioned instead.
    expect(cls, "relative removed; the overlay will centre on an ancestor").toContain("relative");

    // NOT on desktop. A bare `after:size-11` would cover the heading text.
    expect(cls, "the overlay is unguarded; it will cover desktop text too").not.toMatch(
      /(^|\s)after:size-11/,
    );
  });

  /**
   * KEEPING THE PANEL ON SCREEN, which is real logic and so is testable
   * properly rather than by asserting class names.
   *
   * The panel is a fixed 330px anchored to the DOT, so whether it fits
   * depends on where the dot sits. Both failures were measured in a browser
   * at 375px before this existed:
   *
   *   the coverage banner's dot, `align="end"`, put the panel at x = -2
   *   the budget tree's dot, `align="start"`, put it 114px off the RIGHT
   *
   * `align` cannot fix that: it is a guess made at the call site about a
   * position only known at render time, and the same dot is fine on a
   * desktop and wrong on a phone.
   *
   * happy-dom has no layout engine, so every rect is zeroes. That is
   * usually a limitation; here it is the lever — the component's only input
   * is `getBoundingClientRect`, so mocking it drives the real branch.
   */
  describe("nudges itself back on screen", () => {
    const openWithRect = (rect: { left: number; right: number }) => {
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
        ...rect,
        top: 0, bottom: 0, x: rect.left, y: 0,
        width: rect.right - rect.left, height: 0,
        toJSON: () => ({}),
      } as DOMRect);
      render(dot);
      click(trigger());
      return panel()!;
    };

    it("shifts RIGHT when the panel starts off the left edge", () => {
      // The coverage banner's case, exaggerated: 50px off the left.
      const el = openWithRect({ left: -50, right: 280 });
      // MARGIN is 8, so the nudge is 8 - (-50).
      expect(el.style.transform).toBe("translateX(58px)");
    });

    it("shifts LEFT when the panel runs off the right edge", () => {
      // The budget tree's case: window.innerWidth is happy-dom's default.
      const over = window.innerWidth + 100;
      const el = openWithRect({ left: over - 330, right: over });
      // Target right edge is innerWidth - 8, so the shift is -(100 + 8).
      expect(el.style.transform).toBe("translateX(-108px)");
    });

    /**
     * AND LEAVES IT ALONE WHEN IT ALREADY FITS. Without this the other two
     * pass for a component that shifts unconditionally, which would move
     * every panel on every desktop for no reason.
     */
    it("does not move a panel that already fits", () => {
      const el = openWithRect({ left: 20, right: 350 });
      expect(el.style.transform).toBeFalsy();
    });

    /**
     * The WIDTH cap is a different half of the same problem and is a class,
     * so it gets the weaker check — see the typography test above for why
     * that distinction is called out rather than glossed. 330px is wider
     * than a 320px phone, so there is no position that works and no nudge
     * can help; only a cap can.
     */
    it("caps its width so a 320px phone has a position that works", () => {
      render(dot);
      click(trigger());
      expect(
        panel()!.className,
        "max-w removed; on a 320px screen the panel is wider than the screen",
      ).toContain("max-w-[calc(100vw-1rem)]");
    });
  });
});

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
});

"use client";

/**
 * A small circled "i" that reveals an explanation on click.
 *
 * WHY THIS EXISTS
 *
 * /agents needed to say why it has no "Add agent" button. Written as a
 * paragraph under the heading it was three lines of prose competing with the
 * thing the page is actually for, and you only ever read it once. The rule it
 * came from: explanation that is worth having but not worth permanent space
 * goes behind an affordance, and the affordance should be the same one every
 * time so it is recognisable.
 *
 * DELIBERATELY CLICK, NOT HOVER
 *
 * A hover tooltip cannot be opened on a touch screen and vanishes the moment
 * you move toward the text you are trying to read. Click-to-open survives
 * both. The native `title` attribute has the same problems plus a ~1s delay
 * and no styling, which is why it is not used here.
 *
 * ACCESSIBILITY, since a div with an onClick would have been shorter:
 *   - a real <button>, so it is tabbable and fires on Enter/Space for free
 *   - aria-expanded tells a screen reader the state, aria-label says what it
 *     opens (the glyph alone announces as the letter "i")
 *   - Escape closes and returns focus to the trigger, so keyboard users are
 *     not stranded inside the panel
 *   - the panel is aria-live=polite, because it appears after the click and a
 *     screen reader would otherwise not know anything happened
 */

import { useEffect, useId, useRef, useState } from "react";
import { CARD, FAINT, LINE, MUTED } from "@/lib/colors";

export function InfoDot({
  label,
  children,
  align = "start",
}: {
  /** What this explains, e.g. "why there is no Add agent button". */
  label: string;
  children: React.ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  /** Horizontal nudge, in px, to keep the panel on screen. See the effect. */
  const [shiftX, setShiftX] = useState(0);

  /**
   * KEEP THE PANEL ON SCREEN.
   *
   * The panel is a fixed 330px anchored to the DOT, so whether it fits
   * depends entirely on where the dot happens to sit. Measured at 375px
   * with the dot near the right edge of the coverage banner: the panel
   * rendered at x = -2, two pixels of the explanation off the left of the
   * screen with no way to scroll to them.
   *
   * `align` cannot fix this, because it is a guess made at the call site
   * about a position that is only known at render time - and the same dot
   * is fine on a desktop and wrong on a phone. So the component measures
   * itself and nudges.
   *
   * MEASURED AT shiftX = 0, ALWAYS. The effect runs only when `open`
   * flips, and the nudge is reset on close, so the rect read here is the
   * un-nudged one. Reading a shifted rect and adding another shift is how
   * this becomes a feedback loop that walks the panel off the other side.
   */
  useEffect(() => {
    if (!open) {
      setShiftX(0);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    const MARGIN = 8;
    const r = el.getBoundingClientRect();
    if (r.left < MARGIN) setShiftX(MARGIN - r.left);
    else if (r.right > window.innerWidth - MARGIN) {
      setShiftX(window.innerWidth - MARGIN - r.right);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    // Both listeners live behind `if (!open)`, so nothing is attached while
    // closed - a dot that is never clicked costs no global handlers, and a
    // page may hold several.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btnRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    // `pointerdown`, not `click`: a click that starts inside the panel and
    // ends outside it (selecting the text to copy an account id, say) fires
    // `click` on the document and would close the panel mid-selection.
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-flex align-middle">
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={open ? `Hide: ${label}` : `Explain ${label}`}
        onClick={() => setOpen((v) => !v)}
        /**
         * 15px TO LOOK AT, 44px TO TAP.
         *
         * The dot is 15x15. That is right for the glyph - it sits beside a
         * heading and must not compete with it - and wrong for a finger,
         * which needs 44px (WCAG 2.5.5, and Apple's HIG agrees). Measured on
         * /agents at 375px: 15x15, the smallest control on the page.
         *
         * Growing the button would push the heading's line box around. So
         * the hit area is a transparent pseudo-element centred on the dot:
         * it belongs to the button, so a tap anywhere in it activates the
         * button, and it is out of flow, so nothing moves. The visual dot is
         * byte-identical at every width.
         *
         * IT CAN OVERLAP ITS NEIGHBOURS, which is the trade. Every current
         * placement puts it after a heading with non-interactive text around
         * it, so the overlap costs nothing. Dropping one next to another
         * control would need a second look.
         *
         * `max-md:` only. On a desktop the pointer is a mouse and a 15px
         * target is fine; extending it there would swallow clicks meant for
         * the text beside it for no benefit.
         */
        className="relative inline-flex size-[15px] items-center justify-center rounded-full border text-[10px] font-semibold leading-none transition-colors cursor-pointer max-md:after:absolute max-md:after:left-1/2 max-md:after:top-1/2 max-md:after:size-11 max-md:after:-translate-x-1/2 max-md:after:-translate-y-1/2 max-md:after:content-['']"
        style={{
          borderColor: open ? MUTED : LINE,
          color: open ? MUTED : FAINT,
          background: CARD,
        }}
      >
        i
      </button>

      {open && (
        <span
          ref={panelRef}
          id={panelId}
          role="note"
          aria-live="polite"
          /**
           * `font-normal tracking-normal` are NOT decoration. A dot placed in
           * a heading puts this panel inside an <h2>, so weight and
           * letter-spacing inherit: measured at 600/-0.55px before these were
           * added, which rendered the explanation as tight bold prose. Any
           * typographic property the trigger's container might set has to be
           * reasserted here, because the dot is meant to be droppable
           * anywhere.
           */
          /**
           * `max-w` AS WELL AS THE NUDGE. They solve different halves: the
           * nudge moves a panel that does not fit where it is, and this
           * caps one that cannot fit anywhere. 330px is wider than a 320px
           * phone, so on the narrowest device this product will meet there
           * is no position that works.
           */
          className={`absolute top-[22px] z-20 block w-[330px] max-w-[calc(100vw-1rem)] rounded-xl border px-4 py-3 text-left text-[12.5px] font-normal normal-case leading-5 tracking-normal shadow-sm ${
            align === "end" ? "right-0" : "left-0"
          }`}
          style={{
            background: CARD,
            borderColor: LINE,
            color: MUTED,
            // 0 until measured, so the first paint is the un-nudged
            // position the effect reads.
            transform: shiftX ? `translateX(${shiftX}px)` : undefined,
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}

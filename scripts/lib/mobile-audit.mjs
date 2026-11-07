/**
 * What a page does wrong on a phone, measured in the page itself.
 *
 * Injected into the preview and evaluated per route. It is a MEASUREMENT,
 * not a judgement: it reports pixels and counts, and every threshold it
 * compares against is named below with the reason it is that number. A
 * reviewer who disagrees with a threshold can see exactly what it changes.
 *
 * THE THRESHOLDS
 *
 *   TAP = 44. Apple's HIG and WCAG 2.5.5 both land on 44 CSS px as the
 *   smallest reliable touch target. Below it, a finger covers the control
 *   and its neighbours at once, which is the "stress through clicking"
 *   failure rather than an aesthetic one. Measured on the element's own
 *   box, so a 12px icon inside a 44px button passes, as it should.
 *
 *   TINY = 12. Smaller than this is the browser's own minimum-legible
 *   territory on a phone held at arm's length. Reported, not failed:
 *   a 10px uppercase label with wide tracking is a deliberate and
 *   readable convention, and this cannot tell the two apart.
 *
 * WHY CLIPPED IS WORSE THAN OVERFLOWING. An element past the viewport edge
 * in a container that SCROLLS is reachable - annoying, but the content is
 * there. An element past the edge where `documentElement.scrollWidth` has
 * not grown is INVISIBLE, with no scrollbar to suggest otherwise, and the
 * user cannot know it exists. Those are separated here because they need
 * different fixes.
 */
export const AUDIT_FN = `(() => {
  const TAP = 44;
  const TINY = 12;
  const vw = innerWidth;
  const pageScrolls = document.documentElement.scrollWidth > vw + 1;

  const desc = (el) => {
    const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ");
    return (el.tagName.toLowerCase() + (t ? ' "' + t.slice(0, 34) + '"' : "")).slice(0, 60);
  };

  const all = [...document.querySelectorAll("body *")];
  const vis = all.filter((el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });

  // --- past the right edge -------------------------------------------------
  const past = vis
    .filter((el) => el.getBoundingClientRect().right > vw + 1)
    // Only the OUTERMOST offender: a clipped row reports itself, not each
    // of its nine children, or one bad grid looks like nine bugs.
    .filter((el) => !vis.some((p) => p !== el && p.contains(el) && p.getBoundingClientRect().right > vw + 1))
    .map((el) => {
      const r = el.getBoundingClientRect();
      let scroller = null;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === "auto" || ov === "scroll") { scroller = p; break; }
        if (ov === "hidden") { scroller = null; break; }
      }
      return { what: desc(el), right: Math.round(r.right), overBy: Math.round(r.right - vw), reachable: !!scroller || pageScrolls };
    });

  // --- touch targets -------------------------------------------------------
  const CLICKABLE = 'a[href], button, input, select, textarea, [role="button"], [role="menuitem"], [role="tab"], [onclick], [tabindex]:not([tabindex="-1"])';
  const small = vis
    .filter((el) => el.matches(CLICKABLE))
    .map((el) => { const r = el.getBoundingClientRect(); return { el, w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter((x) => x.h < TAP || x.w < TAP)
    .map((x) => ({ what: desc(x.el), w: x.w, h: x.h }));

  // --- hover-only information ---------------------------------------------
  // A title attribute is the clearest case: on a touch screen it never
  // fires, so anything that exists ONLY there is unreachable on a phone.
  const hoverOnly = vis
    .filter((el) => (el.getAttribute("title") || "").trim())
    .map((el) => ({ what: desc(el), hidden: el.getAttribute("title").slice(0, 40) }));

  // --- very small text -----------------------------------------------------
  const tiny = vis
    .filter((el) => el.children.length === 0 && (el.textContent || "").trim())
    .map((el) => ({ el, px: parseFloat(getComputedStyle(el).fontSize) }))
    .filter((x) => x.px < TINY)
    .map((x) => ({ what: desc(x.el), px: x.px }));

  const uniq = (rows, key) => {
    const seen = new Set();
    return rows.filter((r) => { const k = key(r); if (seen.has(k)) return false; seen.add(k); return true; });
  };

  return {
    viewport: vw,
    pageScrollsHorizontally: pageScrolls,
    clipped: uniq(past.filter((p) => !p.reachable), (r) => r.what),
    scrollableOverflow: uniq(past.filter((p) => p.reachable), (r) => r.what),
    smallTapTargets: uniq(small, (r) => r.what + r.w + r.h),
    hoverOnlyInfo: uniq(hoverOnly, (r) => r.what),
    tinyText: uniq(tiny, (r) => r.what + r.px).slice(0, 10),
  };
})()`;

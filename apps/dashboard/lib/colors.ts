/**
 * The status palette, in one place.
 *
 * The dashboard already had tokens for its greys - canvas/card/ink/muted/
 * faint/line/chip, in tailwind.config.ts - but none for STATUS. So every
 * "this is bad" red and "this worked" green was typed as a hex literal in an
 * inline style: 238 occurrences across 20 files, 63 distinct values.
 *
 * These live here rather than in the Tailwind palette because the call sites
 * are `style={{ color: ... }}`, not classNames. Many are conditional
 * (`pct >= 80 ? danger : success`), which a class cannot express without
 * restructuring the JSX. A constant is a find-and-replace; a class is a
 * rewrite, and a rewrite of 238 sites is where a colour refactor silently
 * changes a button.
 *
 * WHAT WAS AMBIGUOUS
 *
 * Red and green were unanimous: #9F2F2D (x37) and #346538 (x27), with
 * #FDEBEC (x18) and #EDF3EC (x16) as their backgrounds. Those moved here
 * unchanged - a pure rename.
 *
 * Amber was not. FIVE different oranges were doing one job:
 *
 *     #9A5F1A  x8   /activity, "blocked" text and chips
 *     #92400E  x6   warning prose, and the 50-80% utilisation colour
 *     #B45309  x5   the unsaved-changes dot, and 75-100% bars
 *     #7A5B14  x1   /activity coverage banner text
 *     #B97B10  x2   /activity
 *
 * plus four backgrounds (#FEF3E2, #FEF6E7, #FFF8E6, #FEF3C7). Nobody chose
 * five ambers; they accumulated. `warn` is #92400E - the darkest, so it is
 * the one that stays legible as small text, which is the dominant use.
 *
 * This DOES change some pixels, and the change is listed in the commit
 * rather than hidden: five near-identical oranges become one.
 */

/**
 * THE NEUTRALS.
 *
 * Identical values to the Tailwind tokens of the same name in
 * tailwind.config.ts - this is a rename, not a redesign. They exist here for
 * the same reason the status colours do: most of these sit in `style={{}}`,
 * frequently inside a shorthand like `1px solid #EAEAEA` that a utility
 * class cannot express without restructuring the element.
 *
 * `#EAEAEA` alone appeared 64 times, `#111111` 45, `#787774` 24.
 */
export const CANVAS = "#FBFBFA";
export const CARD = "#FFFFFF";
export const INK = "#111111";
export const MUTED = "#787774";
export const FAINT = "#A0A09A";
export const LINE = "#EAEAEA";
export const CHIP = "#F3F3F1";

/** Something is wrong, refused, or about to be destroyed. */
export const DANGER = "#9F2F2D";
export const DANGER_BG = "#FDEBEC";

/** Something worked, is healthy, or is within its limits. */
export const SUCCESS = "#346538";
export const SUCCESS_BG = "#EDF3EC";

/** Attention, but not failure: approaching a limit, a caveat, a footgun. */
export const WARN = "#92400E";
export const WARN_BG = "#FEF6E7";

/** An inert mark that is not a status at all - a neutral dot or bar. */
export const NEUTRAL = "#A8A29E";

/**
 * SUCCESS at 80% alpha, for a filled bar that should not shout.
 *
 * Kept as a named constant rather than inlined because `#346538CC` reads as
 * a typo: an eight-digit hex is easy to mistake for a six-digit one with two
 * stray characters, and nothing about "CC" says "80 percent".
 */
export const SUCCESS_SOFT = "#346538CC";

/**
 * Utilisation colour for a bar or a percentage.
 *
 * Centralised because the thresholds were written three times with two
 * different amber values and two different breakpoints (>=50/>=80 on the
 * overview, >=75/>=100 on the agents page). Those are genuinely different
 * questions - "how much of today is gone" versus "is this bar overflowing" -
 * so both survive, named.
 */
export function spendColor(pct: number): string {
  if (pct >= 80) return DANGER;
  if (pct >= 50) return WARN;
  return SUCCESS;
}

export function capacityColor(pct: number): string {
  if (pct >= 100) return DANGER;
  if (pct >= 75) return WARN;
  return SUCCESS;
}

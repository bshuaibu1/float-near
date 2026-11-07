/**
 * Mutation check for the InfoDot.
 *
 * Its tests passed on the first run, which is when a suite is least
 * trustworthy, and this component was shipped WITHOUT tests on the argument
 * that a browser check was enough. It was enough once. These mutants are the
 * ways it can quietly stop being true.
 *
 * M3 is the one worth the whole file: switching the outside-dismiss from
 * `pointerdown` to `click` looks like a tidy-up and breaks text selection
 * inside the panel, because a drag that starts inside and ends outside fires
 * `click` on the document. Nobody would catch that reading a diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/components/ui/info-dot.tsx";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 Escape no longer returns focus, stranding a keyboard user on <body>",
    from: "      setOpen(false);\n      btnRef.current?.focus();",
    to: "      setOpen(false);",
  },
  {
    name: "M2 Escape stops closing it at all",
    from: 'if (e.key !== "Escape") return;',
    to: 'if (e.key !== "Enter") return;',
  },
  {
    name: "M3 outside-dismiss moves to click, so selecting the text closes the panel",
    from: 'document.addEventListener("pointerdown", onDown);',
    to: 'document.addEventListener("click", onDown);',
  },
  {
    name: "M4 the containment check inverts, closing on an INSIDE press",
    from: "if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);",
    to: "if (wrapRef.current?.contains(e.target as Node)) setOpen(false);",
  },
  {
    name: "M5 listeners attach on mount, whether or not anything is open",
    from: "    if (!open) return;",
    to: "    if (false) return;",
  },
  {
    name: "M6 the effect never cleans up, leaking both listeners",
    from: "    return () => {\n      document.removeEventListener(\"keydown\", onKey);\n      document.removeEventListener(\"pointerdown\", onDown);\n    };",
    to: "    return undefined;",
  },
  {
    name: "M7 aria-expanded is hardcoded, so a screen reader never hears the state",
    from: "aria-expanded={open}",
    to: "aria-expanded={false}",
  },
  {
    name: "M8 aria-controls points nowhere",
    from: "aria-controls={open ? panelId : undefined}",
    to: "aria-controls={undefined}",
  },
  {
    name: "M9 the trigger loses its label and announces as the letter i",
    from: 'aria-label={open ? `Hide: ${label}` : `Explain ${label}`}',
    to: "aria-label={undefined}",
  },
  {
    name: "M10 font-normal dropped, so the panel inherits a heading's weight",
    from: "text-[12.5px] font-normal normal-case leading-5 tracking-normal",
    to: "text-[12.5px] normal-case leading-5 tracking-normal",
  },
  /**
   * M11 and M12 guard the TOUCH TARGET, which is invisible by construction:
   * a transparent 44px pseudo-element over a 15px dot. Nothing about the
   * rendered page changes if it is deleted, so without a test it is the
   * first thing a tidy-up removes.
   */
  {
    name: "M11 the 44px tap overlay is deleted, leaving a 15px target on a phone",
    from: " max-md:after:absolute max-md:after:left-1/2 max-md:after:top-1/2 max-md:after:size-11 max-md:after:-translate-x-1/2 max-md:after:-translate-y-1/2 max-md:after:content-['']",
    to: "",
  },
  {
    /**
     * The guard, not the overlay. Unguarded it also exists on desktop,
     * where a 44px invisible box sits over the heading text beside the dot
     * and swallows clicks meant for it - for no gain, since a mouse hits
     * 15px perfectly well.
     */
    name: "M12 the overlay loses its max-md: guard and covers desktop text too",
    from: "max-md:after:size-11",
    to: "after:size-11",
  },
  /**
   * M13-M15 guard the on-screen nudge. Each is a plausible simplification
   * of code whose whole purpose is invisible when it is working.
   */
  {
    name: "M13 the panel never nudges, so it renders partly off screen",
    from: "    if (r.left < MARGIN) setShiftX(MARGIN - r.left);",
    to: "    if (false) setShiftX(MARGIN - r.left);",
  },
  {
    name: "M14 only the left edge is corrected, so a right overflow survives",
    from: "    else if (r.right > window.innerWidth - MARGIN) {\n      setShiftX(window.innerWidth - MARGIN - r.right);\n    }",
    to: "",
  },
  {
    /**
     * The one that looks like a tidy-up. Shifting unconditionally passes
     * both overflow tests and moves every panel on every desktop, which is
     * exactly what the "already fits" test exists to catch.
     */
    name: "M15 the fits-already branch is dropped, so every panel moves",
    from: "    if (r.left < MARGIN) setShiftX(MARGIN - r.left);",
    to: "    setShiftX(MARGIN - r.left);\n    if (false)",
  },
];

let survived = 0;
for (const m of MUTANTS) {
  if (!orig.includes(m.from)) {
    console.log(`  SKIP (pattern absent)  ${m.name}`);
    survived++;
    continue;
  }
  writeFileSync(p, orig.replace(m.from, m.to));
  let verdict;
  try {
    execSync("npx vitest run components/ui/info-dot.test.tsx", {
      cwd: "apps/dashboard",
      stdio: "pipe",
    });
    verdict = "SURVIVED <-- NOT COVERED";
    survived++;
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
console.log(`  reverted byte-identical: ${readFileSync(p, "utf8") === orig}`);
process.exit(survived ? 1 : 0);

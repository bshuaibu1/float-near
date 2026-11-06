/**
 * Strip the picker trigger down to the agent's name.
 *
 * It carried a second line - "master budget - 100 / day" - which was pure
 * duplication: the detail header immediately below already names the agent's
 * role, and the Daily limit row an inch further down holds the same number as
 * an editable value. A control that restates what is already on screen twice
 * makes the page look busier without telling anyone anything.
 *
 * What stays is the name, the branch glyph (depth, not description) and the
 * two STATUS marks - frozen, and the unsaved dot - because neither of those
 * is visible anywhere else once the list is closed.
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "apps/dashboard/app/policies/page.tsx";
let s = readFileSync(p, "utf8");

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// A single line of content now, so the wrapper span and the two-line padding
// both go.
must(
  `        className="flex min-w-[15rem] items-center gap-2 rounded-lg border border-line bg-card py-1.5 pl-3 pr-2.5 text-left shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition-colors hover:border-ink/25 focus:outline-none focus:ring-2 focus:ring-ink/10"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">`,
  `        className="flex h-[34px] min-w-[11rem] items-center gap-2 rounded-lg border border-line bg-card pl-3 pr-2.5 text-left shadow-[0_1px_2px_rgba(17,17,17,0.04)] transition-colors hover:border-ink/25 focus:outline-none focus:ring-2 focus:ring-ink/10"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">`,
  "trigger shell",
);

// Drop the subtitle and the now-redundant closing span.
must(
  `          </span>
          <span className="mt-0.5 block truncate text-[10.5px] text-faint">
            {selDepth === 0 ? "master budget" : "sub-budget"}
            {sel?.policy?.dailyBudget ? \` - \${sel.policy.dailyBudget} / day\` : ""}
          </span>
        </span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />`,
  `        </span>
        <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />`,
  "subtitle",
);

writeFileSync(p, s);

// selDepth is still used for the glyph; prove it rather than assume.
const uses = s.split("selDepth").length - 1;
console.log("  trigger is now just the name");
console.log(`  selDepth references remaining: ${uses} (declaration + glyph test = 2)`);

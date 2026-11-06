/**
 * Dashboard side of "depth is a number".
 *
 * Every page stops parsing invisible characters out of a label and indents
 * with real padding instead. The box-drawing glyph goes too - the user asked
 * for it gone, and with real indentation it was never carrying information
 * the layout wasn't already showing.
 *
 * NOTE ON THE HELPER: the first version of this script passed `s` into the
 * callback AND let `must()` mutate an outer `s`. The callback then returned
 * its own stale copy, silently discarding every must() edit - which left
 * /policies referencing `a.depth` with no such field on the type. The helper
 * below owns `s` in one place and the callback never returns it.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

function edit(path, apply) {
  const raw = readFileSync(path, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);

  const api = {
    /** Required edit: throws if the anchor is gone. */
    must(from, to, what) {
      if (!s.includes(from)) throw new Error(`${path}: not found: ${what}`);
      s = s.replace(from, to);
    },
    /** Optional edit: reports, does not throw. Lets a re-run be a no-op. */
    maybe(from, to, what) {
      if (!s.includes(from)) {
        console.log(`    (already done: ${what})`);
        return;
      }
      s = s.replace(from, to);
    },
    /** Replace every occurrence. */
    all(from, to) {
      s = s.split(from).join(to);
    },
  };

  apply(api);
  writeFileSync(path, crlf ? s.split(LF).join(CRLF) : s);
}

const DEPTH_FIELD = [
  "  /** Depth in the budget tree, root 0. A number, not characters. */",
  "  depth?: number;",
].join(LF);

// ---------------------------------------------------------------- policies
console.log("  policies:");
edit("apps/dashboard/app/policies/page.tsx", ({ maybe, all }) => {
  maybe('import { BRANCH_GLYPH, treeDepth, treeLabel } from "@/lib/tree-label";' + LF, "", "import");
  maybe(
    "  displayName?: string | null;" + LF + "  walletAddress: string;",
    "  displayName?: string | null;" + LF + DEPTH_FIELD + LF + "  walletAddress: string;",
    "depth field",
  );
  all("treeLabel(a.displayName, a.agentId)", "(a.displayName ?? a.agentId)");
  all("treeLabel(sel.displayName, sel.agentId)", "(sel.displayName ?? sel.agentId)");
  all("treeLabel(selected.displayName, selected.agentId)", "(selected.displayName ?? selected.agentId)");
  all("treeDepth(a.displayName)", "(a.depth ?? 0)");
  all("treeDepth(sel.displayName)", "(sel.depth ?? 0)");
  all("treeDepth(selected.displayName)", "(selected.depth ?? 0)");

  maybe(
    [
      "            {/* Depth is still legible with the list CLOSED: a child shows the",
      "                branch glyph, so you can tell a sub-budget from the master",
      "                without opening anything. */}",
      "            {selDepth > 0 && (",
      '              <span aria-hidden className="shrink-0 font-mono text-[11px] text-faint">',
      "                {BRANCH_GLYPH}",
      "              </span>",
      "            )}",
    ].join(LF) + LF,
    "",
    "trigger glyph",
  );
  maybe(
    [
      "                  {d > 0 && (",
      '                    <span aria-hidden className="shrink-0 font-mono text-[11px] text-faint">',
      "                      {BRANCH_GLYPH}",
      "                    </span>",
      "                  )}",
    ].join(LF) + LF,
    "",
    "option glyph",
  );
});

// ------------------------------------------------------------------ agents
console.log("  agents:");
edit("apps/dashboard/app/agents/page.tsx", ({ must, maybe, all }) => {
  maybe('import { treeLabel } from "@/lib/tree-label";' + LF, "", "import");
  all("treeLabel(a.displayName, a.agentId)", "(a.displayName ?? a.agentId)");
  maybe(
    '  status: "active" | "killed";' + LF + "  dailySpent?: string;",
    '  status: "active" | "killed";' + LF + DEPTH_FIELD + LF + "  dailySpent?: string;",
    "depth field",
  );

  must(
    [
      "                    {/* The hierarchy, drawn. displayName already carries the depth",
      "                        prefix in NON-BREAKING spaces: plain spaces collapse in",
      "                        HTML and the tree renders flat. */}",
    ].join(LF),
    [
      "                    {/* The hierarchy, drawn with REAL padding.",
      "                        Depth used to arrive as U+00A0 characters inside the",
      "                        label, which is why it broke whenever anyone typed a",
      "                        plain space - and why agent names carried invisible",
      "                        padding into prose elsewhere on this page. */}",
    ].join(LF),
    "tree comment",
  );
  must(
    '                    <div className="flex items-center gap-2.5 min-w-0">' +
      LF +
      "                      <div className=\"relative shrink-0\" title={`Budget node ${nodeId}`}>",
    "                    <div" +
      LF +
      '                      className="flex items-center gap-2.5 min-w-0"' +
      LF +
      "                      style={{ paddingLeft: `${(a.depth ?? 0) * 1.1}rem` }}" +
      LF +
      "                    >" +
      LF +
      "                      <div className=\"relative shrink-0\" title={`Budget node ${nodeId}`}>",
    "tree indent",
  );
  must(
    '{noAllowlist.map((a) => (a.displayName ?? a.agentId).trim()).join(", ")}',
    '{noAllowlist.map((a) => a.displayName ?? a.agentId).join(", ")}',
    "prose list",
  );
});

// ---------------------------------------------------------------- overview
console.log("  overview:");
edit("apps/dashboard/app/page.tsx", ({ must, maybe }) => {
  maybe(
    "  displayName?: string | null;",
    "  displayName?: string | null;" + LF + DEPTH_FIELD,
    "depth field",
  );
  must(
    [
      "                      {/* displayName, not agentId: the adapter puts the tree",
      '                          label here with its depth prefix ("root", "└─ research",',
      '                          "   └─ r1"). agentId is `node-<id>` for a team node,',
      '                          which rendered as "node-1" and hid the hierarchy. */}',
    ].join(LF),
    [
      "                      {/* displayName, not agentId: agentId is `node-<id>` for a",
      '                          team node, which rendered as "node-1" and hid who the',
      "                          row was. Depth arrives separately as a number and is",
      "                          drawn with padding. */}",
    ].join(LF),
    "overview comment",
  );
  must(
    '                    <div className="flex items-center gap-2.5 min-w-0">' +
      LF +
      '                      <div className="relative shrink-0">',
    "                    <div" +
      LF +
      '                      className="flex items-center gap-2.5 min-w-0"' +
      LF +
      "                      style={{ paddingLeft: `${(a.depth ?? 0) * 1.1}rem` }}" +
      LF +
      "                    >" +
      LF +
      '                      <div className="relative shrink-0">',
    "overview indent",
  );
});

// The module exists only to parse a format that no longer exists.
for (const f of ["apps/dashboard/lib/tree-label.ts", "apps/dashboard/lib/tree-label.test.ts"]) {
  if (existsSync(f)) {
    unlinkSync(f);
    console.log(`  removed ${f}`);
  }
}

console.log("  done: pages use a.depth, labels are plain, the glyph is gone");

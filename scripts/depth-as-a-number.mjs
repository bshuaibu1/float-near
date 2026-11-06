/**
 * Stop encoding tree depth inside a string.
 *
 * The adapter shipped `displayName` as `indent(path.length, label)` - three
 * U+00A0 per level, then a box-drawing glyph. That single decision caused
 * every invisible-character bug in this project:
 *
 *   - `treeLabel`/`treeDepth` broke three times in one sitting, each time
 *     because a plain space was typed where U+00A0 was meant. Silent in both
 *     directions: nothing throws, the tree just renders flat.
 *   - `btoa` THROWS on the glyph, so any signing link built from an agent's
 *     label crashed - and `btoa` on the pad silently produced Latin-1.
 *   - /agents joined agent names into a PROSE SENTENCE, embedding the glyph
 *     and the invisible pad mid-paragraph.
 *
 * Depth is a number. Sent as a number, the dashboard indents with real
 * padding, the label is a label, and none of the above can happen again.
 *
 * The old `indent()` helper and its tests go with it - this is the last
 * U+00A0 in the codebase.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const NB = String.fromCharCode(160);

function edit(path, apply) {
  const raw = readFileSync(path, "utf8");
  const crlf = raw.includes(String.fromCharCode(13) + LF);
  let s = raw.split(String.fromCharCode(13) + LF).join(LF);
  s = apply(s, (from, to, what) => {
    if (!s.includes(from)) throw new Error(`${path}: not found: ${what}`);
    s = s.replace(from, to);
    return s;
  });
  writeFileSync(path, crlf ? s.split(LF).join(String.fromCharCode(13) + LF) : s);
}

// --- map.ts ---------------------------------------------------------------
edit("packages/float-adapter/src/map.ts", (s, must) => {
  // 1. the type gains depth
  s = must(
    "  status: \"active\" | \"killed\";\n  displayName: string;",
    [
      '  status: "active" | "killed";',
      "  /** The node's own label. NO tree glyphs, no indentation. */",
      "  displayName: string;",
      "  /**",
      "   * How deep in the budget tree this node sits. Root is 0.",
      "   *",
      "   * A NUMBER, deliberately. Depth used to be encoded into displayName as",
      "   * U+00A0 padding plus a box-drawing glyph, and every invisible-character",
      "   * bug in this project traces back to that: regexes that silently matched",
      "   * nothing, `btoa` throwing on the glyph, agent names carrying invisible",
      "   * padding into prose. A consumer that wants indentation can multiply.",
      "   */",
      "  depth: number;",
    ].join(LF),
    "ApiAgent.depth",
  );

  // 2. populate it, and stop rewriting displayName
  s = must(
    "    a.displayName = indent(n.path.length, n.label);",
    "    a.depth = n.path.length;",
    "assignment",
  );

  // 3. nodeToApiAgent must set a default depth so the object is complete
  s = must("    displayName: n.label,", "    displayName: n.label,\n    depth: 0,", "default depth");

  // 4. delete indent() itself
  const a = s.indexOf("export function indent(");
  if (a < 0) throw new Error("indent() not found");
  // walk back over its doc comment
  let start = s.lastIndexOf("/**", a);
  if (start < 0) start = a;
  const end = s.indexOf("\n}\n", a) + 3;
  s = s.slice(0, start) + s.slice(end);

  return s;
});

// --- map.test.ts ----------------------------------------------------------
edit("packages/float-adapter/src/map.test.ts", (s) => {
  const OLD_START = s.indexOf(
    "  it(\"keeps the tree order root-first so the hierarchy reads top-down\", () => {",
  );
  const OLD_END = s.indexOf(
    '  it("resolves the EFFECTIVE payee allowlist, not the raw node field", () => {',
  );
  if (OLD_START < 0 || OLD_END < 0) throw new Error("map.test markers not found");

  const NEW = [
    '  it("keeps the tree order root-first so the hierarchy reads top-down", () => {',
    "    const rows = treeToApiAgents(tree, budgets, D);",
    '    expect(rows.map((r) => r.displayName)).toEqual(["root", "research", "r1", "r2"]);',
    "  });",
    "",
    "  /**",
    "   * Depth is a NUMBER now.",
    "   *",
    "   * It used to be three U+00A0 per level baked into displayName, and the",
    "   * test here asserted those characters. That format caused every",
    "   * invisible-character bug in this project - a plain space typed in place",
    "   * of the pad matched nothing and flattened the tree, silently, three",
    "   * separate times. A number cannot be mistyped invisibly.",
    "   */",
    '  it("reports depth as a number, with root at 0", () => {',
    "    const rows = treeToApiAgents(tree, budgets, D);",
    "    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);",
    "  });",
    "",
    '  it("leaves the label clean - no glyphs, no padding, nothing invisible", () => {',
    "    const rows = treeToApiAgents(tree, budgets, D);",
    "    for (const r of rows) {",
    "      expect(r.displayName).toBe(r.displayName.trim());",
    "      // Anything outside printable ASCII would be a regression to the",
    "      // old format; account labels are [a-z0-9] by contract rule.",
    "      // eslint-disable-next-line no-control-regex",
    "      expect(/^[\\x20-\\x7e]*$/.test(r.displayName)).toBe(true);",
    "    }",
    "  });",
    "",
  ].join(LF);

  return s.slice(0, OLD_START) + NEW + s.slice(OLD_END);
});

// --- handlers.test.ts -----------------------------------------------------
edit("packages/float-adapter/src/handlers.test.ts", (s) => {
  const a = s.indexOf("      // BUILT, never typed.");
  const b = s.indexOf("]);", a) + 3;
  if (a < 0 || b < 2) throw new Error("handlers.test fixture not found");
  const NEW = [
    "// Plain strings now: depth left displayName entirely, so there is no",
    "      // invisible character to build or to get wrong.",
    '      expect(d.agents.map((a) => a.displayName)).toEqual(["root", "research", "r1"]);',
    "      expect(d.agents.map((a) => a.depth)).toEqual([0, 1, 2]);",
  ].join(LF);
  return s.slice(0, a) + NEW + s.slice(b);
});

console.log("  depth is a number; indent() and the last U+00A0 are gone");
console.log(`  literal U+00A0 left in map.ts: ${(readFileSync("packages/float-adapter/src/map.ts", "utf8").split(NB).length - 1)}`);

/**
 * Where to draw tree connectors in a flat, depth-ordered list of budget nodes.
 *
 * WHY THIS EXISTS. The fleet table already indented by `depth * 1.1rem`, and
 * that is not enough to say CONTAINMENT. A row sitting 18px right of the one
 * above reads as a styling quirk; it does not say "this budget lives inside
 * that one, and its payments are checked against both". An owner looking at
 * `agent / news / headlines` saw three peers, which is exactly wrong about the
 * thing the product enforces.
 *
 * WHY POSITION IS A LEGITIMATE INPUT. Deriving "who is my parent" from
 * position is normally a trap. It is sound here because `treeToApiAgents`
 * emits TREE ORDER, root-first (packages/float-adapter/src/map.ts), and the
 * agents page only FILTERS that array to drop root — it never sorts it. A
 * child therefore always follows its parent, and the first later row at a
 * shallower depth ends the subtree. If either of those two facts changes this
 * module is wrong, which is why `treeOrderHolds` exists below and why the page
 * asserts with it rather than trusting the invariant silently.
 *
 * WHY NOT BOX-DRAWING CHARACTERS. `map.ts` documents that U+00A0 padding plus
 * a glyph is the origin of every invisible-character bug in this project —
 * regexes matching nothing, `btoa` throwing, names carrying padding into
 * prose. Connectors are therefore GEOMETRY, returned as booleans and drawn by
 * the caller with borders. Nothing here enters a string.
 *
 * DEPTHS ARE FLEET-RELATIVE. Root (depth 0) is rendered separately as the
 * master budget, so the shallowest row here is depth 1 and gets no connector:
 * its parent is not on screen as a row.
 */

export type TreeConnector = {
  /** This row hangs off a parent row above, so draw an elbow. Depth >= 2. */
  elbow: boolean;
  /**
   * It is the LAST child of that parent, so the elbow terminates: the vertical
   * stroke stops at the middle instead of continuing past the row. Getting
   * this wrong leaves a line pointing at a sibling that does not exist.
   */
  last: boolean;
  /**
   * One flag per ANCESTOR level shallower than the parent, outermost first.
   * True means that ancestor's subtree continues below this row, so a vertical
   * line must pass THROUGH this row to reach it.
   *
   * Without these a depth-3 row visually orphans the depth-2 branch it sits
   * inside: the elbow connects it to its parent, but the parent's own
   * connection to the row above is interrupted by the rows in between.
   */
  rails: boolean[];
  /**
   * This row HAS children below it, so it must draw a descender: a short
   * vertical from its own middle down to the row edge, in the column where its
   * first child's elbow will appear.
   *
   * Without it the child's elbow begins at the row boundary and visually grows
   * out of the divider rule rather than out of the parent, which is what
   * "it looks like a standalone agent" was describing even after the elbow
   * existed. The descender is what makes the line start AT the parent.
   */
  hasChildren: boolean;
};

/**
 * Does a node at `level` have a further sibling below row `i`?
 *
 * Scanning forward, a row shallower than `level` means the enclosing subtree
 * has ended — stop, there can be no more siblings. A row AT `level` is that
 * next sibling. Rows deeper than `level` are descendants and are skipped.
 */
function continuesBelow(depths: number[], i: number, level: number): boolean {
  for (let j = i + 1; j < depths.length; j++) {
    if (depths[j] < level) return false;
    if (depths[j] === level) return true;
  }
  return false;
}

/**
 * Connector geometry for each row, given the rows' depths in tree order.
 *
 * Pure and positional: pass `fleet.map(a => a.depth ?? 1)` and render the
 * result. A missing depth is treated as 1 (top level, no connector), which is
 * the safe direction — it under-claims structure rather than inventing it.
 */
export function treeConnectors(depths: number[]): TreeConnector[] {
  return depths.map((d, i) => {
    const rails: boolean[] = [];
    // Ancestor levels strictly between top-level and this row's parent.
    // A depth-2 row has none; a depth-3 row has exactly one (level 1).
    for (let level = 1; level <= d - 2; level++) {
      rails.push(continuesBelow(depths, i, level));
    }
    return {
      elbow: d >= 2,
      last: !continuesBelow(depths, i, d),
      rails,
      // Tree order again: a child is adjacent and deeper. Any deeper row that
      // is not adjacent belongs to a different branch.
      hasChildren: depths[i + 1] !== undefined && depths[i + 1] > d,
    };
  });
}

/**
 * Is this list actually in tree order?
 *
 * The one assumption the whole module rests on, made checkable. Depth may
 * increase by at most ONE per row — a jump from 1 to 3 means the depth-2
 * parent is missing or the rows were reordered, and every connector below it
 * would then be drawn against the wrong parent.
 *
 * Returns false rather than throwing: a dashboard that renders a correct table
 * without connectors is better than one that shows an error, and the caller
 * degrades to plain indentation.
 */
export function treeOrderHolds(depths: number[]): boolean {
  for (let i = 1; i < depths.length; i++) {
    if (depths[i] > depths[i - 1] + 1) return false;
  }
  return true;
}

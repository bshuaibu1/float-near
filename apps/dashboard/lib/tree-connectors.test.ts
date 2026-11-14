import { describe, it, expect } from "vitest";
import { treeConnectors, treeOrderHolds } from "./tree-connectors";

/**
 * The reported bug, pinned: "there is no way for someone to see that headlines
 * is underneath the news node — it looks like a standalone agent."
 *
 * The live vault that produced the report is root(0) -> [agent(1), news(1)]
 * and news -> headlines(2). Dropping root, the fleet rows are [1, 1, 2]. Every
 * test below is written against depths rather than node objects because that
 * is the entire input: the adapter guarantees tree order, so position plus
 * depth is sufficient and nothing else is consulted.
 */
describe("treeConnectors", () => {
  it("draws an elbow on the nested row of the vault that produced the report", () => {
    // agent, news, headlines — headlines is the only nested one.
    const [agent, news, headlines] = treeConnectors([1, 1, 2]);

    expect(agent.elbow).toBe(false);
    expect(news.elbow).toBe(false);
    expect(headlines.elbow).toBe(true);
  });

  it("gives top-level rows no connector, because their parent is root and root is not a row", () => {
    expect(treeConnectors([1, 1, 1]).every((c) => !c.elbow)).toBe(true);
  });

  it("terminates the elbow on an only child", () => {
    const [, headlines] = treeConnectors([1, 2]);
    expect(headlines).toMatchObject({ elbow: true, last: true });
  });

  it("tees the elbow on every child but the last", () => {
    // one parent, three children
    const [, first, second, third] = treeConnectors([1, 2, 2, 2]);
    expect(first.last).toBe(false);
    expect(second.last).toBe(false);
    expect(third.last).toBe(true);
  });

  it("treats a deeper row in between as a descendant, not as the end of the siblings", () => {
    // parent -> childA -> grandchild, then childB. childA is NOT last: the
    // grandchild sits between the two siblings and must not terminate the run.
    const [, childA, grandchild, childB] = treeConnectors([1, 2, 3, 2]);
    expect(childA.last).toBe(false);
    expect(grandchild.last).toBe(true);
    expect(childB.last).toBe(true);
  });

  it("ends the sibling run at the first shallower row", () => {
    // team1 -> child, then team2 -> child. The first child must terminate:
    // the second child belongs to a different parent entirely.
    const [, firstChild, , secondChild] = treeConnectors([1, 2, 1, 2]);
    expect(firstChild.last).toBe(true);
    expect(secondChild.last).toBe(true);
  });

  it("carries one rail per ancestor level above the parent", () => {
    const [top, mid, deep] = treeConnectors([1, 2, 3]);
    expect(top.rails).toEqual([]);
    expect(mid.rails).toEqual([]);
    expect(deep.rails).toHaveLength(1);
  });

  it("runs a rail through a deep row when an outer branch continues below it", () => {
    // [agent, news, headlines, other] — `other` is a second top-level agent,
    // so the level-1 line must pass THROUGH the headlines row to reach it.
    const [, , headlines] = treeConnectors([1, 2, 3, 1]);
    expect(headlines.rails).toEqual([true]);
  });

  it("leaves the rail off when nothing follows at that level", () => {
    const [, , headlines] = treeConnectors([1, 2, 3]);
    expect(headlines.rails).toEqual([false]);
  });

  it("treats a missing depth as top level rather than inventing structure", () => {
    // `depth` is optional on the API type; the page maps undefined to 1.
    expect(treeConnectors([1]).at(0)).toMatchObject({ elbow: false, rails: [] });
  });

  it("returns nothing for an empty fleet", () => {
    expect(treeConnectors([])).toEqual([]);
  });

  /**
   * The descender. The elbow alone still read as "standalone": it began at the
   * row boundary, so the line appeared to grow out of the divider rule rather
   * than out of the parent. These pin which rows must draw one.
   */
  describe("hasChildren", () => {
    it("marks the parent of the nested row in the reported vault", () => {
      // agent, news, headlines — only `news` has a child.
      const [agent, news, headlines] = treeConnectors([1, 1, 2]);
      expect(agent.hasChildren).toBe(false);
      expect(news.hasChildren).toBe(true);
      expect(headlines.hasChildren).toBe(false);
    });

    it("does not mark a row whose deeper neighbour belongs to another branch", () => {
      // team1(1), child(2), team2(1), grandchild-of-nobody... the row at index
      // 2 is depth 1 and the NEXT row is depth 2, so it genuinely has a child;
      // the row at index 1 is depth 2 followed by depth 1, so it has none.
      const c = treeConnectors([1, 2, 1, 2]);
      expect(c[1].hasChildren).toBe(false);
      expect(c[2].hasChildren).toBe(true);
    });

    it("requires the child to be ADJACENT, not merely deeper somewhere below", () => {
      // [1, 1, 2]: the FIRST depth-1 row is followed by another depth-1 row.
      // A deeper row exists further down, but it is not this row's child.
      expect(treeConnectors([1, 1, 2])[0].hasChildren).toBe(false);
    });

    it("marks the last row as childless", () => {
      expect(treeConnectors([1, 2]).at(-1)?.hasChildren).toBe(false);
    });
  });
});

/**
 * The guard on the module's one assumption. These are not decoration: if the
 * adapter ever stops emitting tree order, every connector below the break is
 * drawn against the wrong parent, and a wrong containment claim is worse than
 * the flat table this replaced.
 */
describe("treeOrderHolds", () => {
  it("accepts a well-formed tree", () => {
    expect(treeOrderHolds([1, 1, 2, 3, 2, 1])).toBe(true);
  });

  it("accepts an empty or single-row fleet", () => {
    expect(treeOrderHolds([])).toBe(true);
    expect(treeOrderHolds([1])).toBe(true);
  });

  it("rejects a depth jump, which means a parent row is missing or rows were sorted", () => {
    expect(treeOrderHolds([1, 3])).toBe(false);
    expect(treeOrderHolds([1, 2, 1, 3])).toBe(false);
  });

  it("allows depth to fall by any amount, which is just a subtree ending", () => {
    expect(treeOrderHolds([1, 2, 3, 1])).toBe(true);
  });
});

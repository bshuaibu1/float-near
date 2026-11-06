/**
 * A distinct colour per agent, by position rather than by hash.
 *
 * TWO DEFECTS, BOTH MEASURED, BOTH IN WHAT THE USER SEES.
 *
 * ONE AGENT WORE TWO COLOURS. The budget tree seeded its avatar with
 * `agentId` ("node-1") and the Overview's Recent Activity seeded the same
 * agent with its NAME ("marketing"). Those hash to hue 70 and hue 322, so
 * `marketing` was yellow-green in one panel and pink in the other, four
 * inches apart on the same page. Fixed by seeding everything from the id.
 *
 * TWO AGENTS WORE ONE COLOUR. That is this file. The avatar derives its hue
 * from `rng() * 360` seeded by a string hash, and a hash knows nothing about
 * the other agents, so nothing stops two of them landing on top of each
 * other. Measured on the ids a real vault produces:
 *
 *     node-0  86 deg     node-4  356 deg
 *     node-1  70 deg     node-5   88 deg   <- 2 deg from node-0
 *     node-2 332 deg     node-6  311 deg
 *     node-3 333 deg     node-7   55 deg
 *              ^ 1 deg from node-2
 *
 * node-2 and node-3 are indistinguishable, and nodes 2, 3 and 4 are all the
 * same pink. Three candidate fixes were tried - better hash avalanche,
 * golden angle on the hash, and the status quo - and none won on every set,
 * because all three are still blind to the other agents.
 *
 * SPACING NEEDS TO KNOW THE SET, so the hue comes from the node's INDEX in
 * the tree. Node ids are small sequential integers, which is exactly the
 * input the golden angle is for:
 *
 *      4 agents -> closest pair 52.5 deg
 *      8 agents -> closest pair 32.5 deg
 *     16 agents -> closest pair 12.4 deg
 *     64 agents -> closest pair  2.9 deg   (MAX_NODES, the contract's cap)
 *
 * Against 1 degree today at eight agents. It degrades at the contract's
 * maximum, which is honest: 64 distinct hues is more than a wheel can hold,
 * and at that point the label is doing the work anyway.
 */

/**
 * 137.50776 degrees. Successive multiples never fall close together, which
 * is why sunflowers use it and why it beats anything hash-derived here: the
 * spacing is a property of the sequence, not luck.
 */
const GOLDEN_ANGLE = 137.50776405003785;

/**
 * The node id out of an agentId.
 *
 * The adapter builds it as `n.account ?? "node-" + n.id`, so an agent with
 * its own NEAR account is named for the account and carries no id. Those
 * fall back to the avatar's own hash, which is the current behaviour and no
 * worse than before: this vault's agents are virtual and all take the
 * `node-N` form.
 */
export function nodeIndexOf(agentId: string): number | null {
  /**
   * TWO FORMATS, because the adapter has two mappers and they disagree.
   *
   *   nodeToApiAgent   `n.account ?? "node-" + n.id`   -> "node-1"
   *   requestToPayment `String(r.node_id)`             -> "1"
   *
   * The budget tree is built by the first and activity rows by the second,
   * so an agent arrives as "node-1" in one panel and "1" in the next. A
   * matcher that only knew `node-N` would return null for every activity
   * row, fall back to the hash, and leave the two-colours-for-one-agent bug
   * exactly where it was - which is what the first version of this function
   * did, caught only by reading the live payload.
   *
   * Both are accepted here rather than unified at the source: the formats
   * are load-bearing elsewhere (`/^node-(\d+)$/` drives nodeIdOf on two
   * pages) and quietly changing an id's shape is how a filter stops
   * matching.
   */
  const m = /^(?:node-)?(\d+)$/.exec(agentId);
  return m ? Number(m[1]) : null;
}

/**
 * The hue for an agent, 0-359, or `undefined` when the id carries no index
 * and the caller should let the avatar hash it.
 *
 * `undefined` rather than a default number on purpose: a fallback hue would
 * put every account-named agent on the same colour, which is the bug this
 * file exists to remove.
 */
export function agentHue(agentId: string | null | undefined): number | undefined {
  if (!agentId) return undefined;
  const i = nodeIndexOf(agentId);
  if (i === null) return undefined;
  return (i * GOLDEN_ANGLE) % 360;
}

/**
 * The canonical seed for an agent, so one node always draws ONE avatar.
 *
 * MATCHING THE HUE IS NOT ENOUGH, which is the thing I got wrong first.
 * The avatar hashes its seed twice: once for the palette and once for
 * `generateGrid`, which decides the pixel pattern and every animation
 * phase. Passing a matching hue to two different seeds gives two avatars of
 * the same COLOUR with different patterns - closer than before, still not
 * the same agent.
 *
 * So the seed itself is normalised. "node-1" and "1" are the same node
 * wearing the adapter's two id formats, and both collapse to "node-1" here,
 * which makes the hash, the grid and the hue identical in every panel.
 *
 * An account-named agent passes through unchanged: it has no index, so
 * there is nothing to normalise and its own name is already stable.
 */
export function agentSeed(agentId: string | null | undefined): string {
  if (!agentId) return "";
  const i = nodeIndexOf(agentId);
  return i === null ? agentId : `node-${i}`;
}

#!/usr/bin/env node
/**
 * Folds a backfill store into the store the adapter follows.
 *
 * Needed because the two cannot safely share one file: both do
 * load -> modify -> save, so running a long backfill against the live store
 * is a lost-update race (scan-blocked.mjs refuses to do it). The backfill
 * writes its own file; this merges the result back.
 *
 * The merge is deliberately additive and order-independent:
 *   refusals  union by request id — the same refusal from both sides is one
 *   coverage  widened to the union of both ranges
 *   gaps      a span is a gap only if NEITHER side read it
 *
 * That last rule is the one worth stating. The whole point of the backfill is
 * to turn gaps into coverage, so a naive union of the hole lists would undo
 * the work — the live store lists the backfilled span as a hole precisely
 * because it skipped what the backfill then went and read.
 *
 * Usage:
 *   node scripts/merge-blocked.mjs .demo/backfill.json [.demo/blocked-log.json]
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

const SRC = process.argv[2];
const DST = process.argv[3] ?? process.env.BLOCKED_LOG ?? ".demo/blocked-log.json";
if (!SRC) {
  console.error("usage: merge-blocked.mjs <backfill.json> [target.json]");
  process.exit(2);
}
for (const f of [SRC, DST]) {
  if (!existsSync(f)) {
    console.error(`not found: ${f}`);
    process.exit(1);
  }
}

const read = (f) => JSON.parse(readFileSync(f, "utf8"));
const src = read(SRC);
const dst = read(DST);

if (src.vault && dst.vault && src.vault !== dst.vault) {
  // Merging two different vaults' refusals would attribute one vault's
  // refusals to another. Never guess at this.
  console.error(`vault mismatch: ${SRC} is ${src.vault}, ${DST} is ${dst.vault}`);
  process.exit(1);
}

/** Subtract the inclusive span [from,to] from a list of gap ranges. */
function subtract(holes, from, to) {
  const out = [];
  for (const h of holes) {
    if (h.to < from || h.from > to) {
      out.push(h); // untouched
      continue;
    }
    if (h.from < from) out.push({ from: h.from, to: Math.min(h.to, from - 1) });
    if (h.to > to) out.push({ from: Math.max(h.from, to + 1), to: h.to });
    // fully covered -> dropped, which is the point
  }
  return out;
}

const before = {
  refusals: Object.keys(dst.blocked ?? {}).length,
  gapBlocks: (dst.holes ?? []).reduce((n, h) => n + (h.to - h.from + 1), 0),
};

// 1. Refusals: union by request id.
let added = 0;
dst.blocked ??= {};
for (const [id, rec] of Object.entries(src.blocked ?? {})) {
  if (!dst.blocked[id]) {
    dst.blocked[id] = rec;
    added++;
  }
}

// 2. Gaps: whatever the backfill actually read is no longer a gap.
let holes = dst.holes ?? [];
if (typeof src.scannedFrom === "number" && typeof src.scannedTo === "number") {
  holes = subtract(holes, src.scannedFrom, src.scannedTo);
  // ...except the spans the backfill ITSELF could not read.
  holes = holes.concat(src.holes ?? []);
}
holes.sort((a, b) => a.from - b.from);
const coalesced = [];
for (const h of holes) {
  const last = coalesced[coalesced.length - 1];
  if (last && h.from <= last.to + 1) last.to = Math.max(last.to, h.to);
  else coalesced.push({ ...h });
}
dst.holes = coalesced;

// 3. Coverage: the union of both ranges.
const mins = [dst.scannedFrom, src.scannedFrom].filter((n) => typeof n === "number");
const maxs = [dst.scannedTo, src.scannedTo].filter((n) => typeof n === "number");
if (mins.length) dst.scannedFrom = Math.min(...mins);
if (maxs.length) dst.scannedTo = Math.max(...maxs);

// Atomic replace, so a follower reading concurrently never sees a half-file.
const tmp = `${DST}.tmp`;
writeFileSync(tmp, JSON.stringify(dst, null, 2) + "\n");
renameSync(tmp, DST);

const after = {
  refusals: Object.keys(dst.blocked).length,
  gapBlocks: dst.holes.reduce((n, h) => n + (h.to - h.from + 1), 0),
};
console.log(`Merged ${SRC} -> ${DST}`);
console.log(`  refusals   ${before.refusals} -> ${after.refusals}  (+${added})`);
console.log(`  gap blocks ${before.gapBlocks} -> ${after.gapBlocks}`);
console.log(`  coverage   ${dst.scannedFrom}..${dst.scannedTo}`);
if (dst.holes.length) {
  const span = (h) => (h.from === h.to ? `${h.from}` : `${h.from}..${h.to}`);
  console.log(`  remaining gaps: ${dst.holes.slice(0, 8).map(span).join(", ")}`);
}

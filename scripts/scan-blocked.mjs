#!/usr/bin/env node
/**
 * Deliberate BACKFILL of refused payments from the chain.
 *
 * The adapter follows the head automatically (see BlockedFollower), so this
 * script is for the other case: reaching back over blocks that were produced
 * before the adapter existed, or during an outage.
 *
 * It imports the adapter's scanner rather than reimplementing it. There used
 * to be two copies of the event-parsing logic, which is one copy too many: a
 * change to the NEP-297 event shape would have broken one of them silently,
 * and the one that breaks quietly is always the one that matters, because its
 * output is an empty list that reads exactly like "no refusals happened".
 *
 * Requires the adapter to be built:  npm run build -w @near-vault/float-adapter
 *
 * Usage:
 *   node scripts/scan-blocked.mjs [--max-blocks 400] [--from <height>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const DIST = resolve("packages/float-adapter/dist/blocked-scan.js");
if (!existsSync(DIST)) {
  console.error(`Built scanner not found at ${DIST}`);
  console.error("Build it first:  npm run build -w @near-vault/float-adapter");
  process.exit(1);
}
const { scanRange, mergeScan, emptyStore, createRpc } = await import(pathToFileURL(DIST).href);

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v3.floatvault-12329.testnet";
const STORE = process.env.BLOCKED_LOG ?? ".demo/blocked-log.json";

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MAX_BLOCKS = argOf("--max-blocks", 400);

// Pacing and backoff live in the shared scanner, so the follower and this
// script throttle identically. A second copy here would drift.
const rpc = createRpc(RPC, {
  paceMs: Number(process.env.SCAN_PACE_MS ?? "40"),
  onThrottle: (ms) => console.log(`  rate-limited — waiting ${ms}ms`),
});

function load() {
  if (!existsSync(STORE)) return emptyStore(VAULT);
  try {
    const p = JSON.parse(readFileSync(STORE, "utf8"));
    return {
      vault: p.vault ?? VAULT,
      scannedFrom: p.scannedFrom ?? null,
      scannedTo: p.scannedTo ?? null,
      holes: Array.isArray(p.holes) ? p.holes : [],
      blocked: p.blocked ?? {},
    };
  } catch {
    return emptyStore(VAULT);
  }
}

// ---- Do not fight the adapter for the same file.
//
// The adapter follows the head and rewrites this store every few seconds.
// Both sides do load -> modify -> save, so running them against one file is a
// lost-update race: whichever saves last silently discards the other's work,
// and the thing discarded is refusal records. The docstring above tells people
// to run this WHILE the adapter is up, so this is the expected case, not an
// exotic one.
//
// Detected by mtime rather than a lockfile: no stale-lock problem, and a
// recently-written store is exactly the signal that something else owns it.
if (existsSync(STORE)) {
  const ageMs = Date.now() - statSync(STORE).mtimeMs;
  if (ageMs < 30_000 && !argv.includes("--force")) {
    console.error(`${STORE} was written ${Math.round(ageMs / 1000)}s ago — something is following it.`);
    console.error("Running both against one file loses refusal records to a last-writer-wins race.");
    console.error("Either stop the adapter, or scan into a separate file and merge:");
    console.error(`  BLOCKED_LOG=.demo/backfill.json node scripts/scan-blocked.mjs --from <height>`);
    console.error("Pass --force to override.");
    process.exit(1);
  }
}

const store = load();
const head = (await rpc("block", { finality: "final" })).header.height;
const from = argOf("--from", store.scannedTo ? store.scannedTo + 1 : head - MAX_BLOCKS + 1);
const to = Math.min(head, from + MAX_BLOCKS - 1);

if (from > to) {
  console.log(`Nothing to scan: cursor ${store.scannedTo} is already at head ${head}.`);
  process.exit(0);
}
console.log(`Scanning blocks ${from}..${to} (head ${head}) for refusals by ${VAULT}`);

// ---- Scan in batches, saving after each.
//
// A large backfill runs for well over an hour. Writing only at the end means
// any failure in that window — a dropped connection, a rate limit, a stray
// Ctrl-C — discards every block already read, and the retry starts from
// nothing. Checkpointing also makes the cursor meaningful: a resumed run
// picks up where this one stopped instead of redoing the work.
const BATCH = 500;
let next = store;
let added = 0;
const totals = { blocksSeen: 0, chunksFetched: 0, chunksSkipped: 0 };

mkdirSync(dirname(STORE), { recursive: true });
for (let lo = from; lo <= to; lo += BATCH) {
  const hi = Math.min(to, lo + BATCH - 1);
  const res = await scanRange(rpc, VAULT, lo, hi);
  const merged = mergeScan(next, lo, hi, res);
  next = merged.store;
  added += merged.added;
  totals.blocksSeen += res.blocksSeen;
  totals.chunksFetched += res.chunksFetched;
  totals.chunksSkipped += res.chunksSkipped;
  next.vault = VAULT;

  // Atomic replace: a reader must never catch a half-written file.
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  renameSync(tmp, STORE);

  const done = hi - from + 1;
  const pct = Math.round((done / (to - from + 1)) * 100);
  console.log(`  ...${hi} (${pct}%, ${added} refusal(s) so far)`);
}

console.log(
  `  blocks ${totals.blocksSeen}  chunks fetched ${totals.chunksFetched}, skipped empty ${totals.chunksSkipped}`,
);
console.log(`  NEW refusals recorded: ${added}  (total known ${Object.keys(next.blocked).length})`);
if (next.holes.length) {
  // Said loudly. A range containing unread blocks is not covered, and
  // reporting it as covered turns "we did not look" into "nothing happened".
  // Holes are RANGES, so they need formatting — joining them raw prints
  // "[object Object]", which is how a gap report becomes unreadable noise.
  const span = (h) => (h.from === h.to ? `${h.from}` : `${h.from}..${h.to}`);
  const blocks = next.holes.reduce((n, h) => n + (h.to - h.from + 1), 0);
  console.log(`  ${blocks} block(s) UNREAD across ${next.holes.length} gap(s):`);
  for (const h of next.holes.slice(0, 8)) console.log(`      ${span(h)}`);
  if (next.holes.length > 8) console.log(`      ... and ${next.holes.length - 8} more`);
}
console.log(`  coverage now blocks ${next.scannedFrom}..${next.scannedTo} -> ${STORE}`);

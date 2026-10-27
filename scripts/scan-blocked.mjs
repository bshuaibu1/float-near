#!/usr/bin/env node
/**
 * Recovers BLOCKED payment attempts from the chain.
 *
 * Why this has to exist. A refused payment is deliberately NOT stored in
 * contract state — storing one would let an agent grow the vault's storage
 * bill by spamming rejects, which docs/KNOWN-TRADEOFFS.md §2 identifies as the
 * real griefing vector. So the contract emits a NEP-297 event and keeps
 * nothing. The adapter used to remember only the refusals it personally
 * witnessed, in memory, which meant the single most important thing this
 * product does — refusing a payment because a SHARED pool is empty — vanished
 * on restart and was invisible for any payment made by another client.
 *
 * The events are still on chain, inside receipt outcomes. This reads them
 * back. No indexer is involved: NearBlocks returns nothing for this testnet
 * account, so everything here comes from plain RPC and is reproducible by
 * anyone with the same endpoint.
 *
 * Cost control. A naive walk would query every chunk of every block. In
 * practice 1 chunk in 10 carries any transaction at all, and a chunk's
 * `tx_root` is the all-ones hash when it is empty, so empty chunks are skipped
 * without a second call. Each run is also bounded by --max-blocks so this can
 * never turn into an unbounded scan.
 *
 * Honesty about coverage. The output records the exact block range scanned.
 * A reader must be able to tell "no refusals happened" from "we have not
 * looked there yet" — those are the same empty list otherwise.
 *
 * Usage:
 *   node scripts/scan-blocked.mjs [--max-blocks 400] [--from <height>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const RPC = process.env.NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com";
const VAULT = process.env.NEAR_VAULT_CONTRACT ?? "v3.floatvault-12329.testnet";
const STORE = process.env.BLOCKED_LOG ?? ".demo/blocked-log.json";

/** A chunk with no transactions has this as its tx_root. */
const EMPTY_TX_ROOT = "11111111111111111111111111111111";

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const MAX_BLOCKS = argOf("--max-blocks", 400);

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
  return j.result;
}

function load() {
  if (!existsSync(STORE)) return { vault: VAULT, scannedFrom: null, scannedTo: null, blocked: {} };
  try {
    return JSON.parse(readFileSync(STORE, "utf8"));
  } catch {
    return { vault: VAULT, scannedFrom: null, scannedTo: null, blocked: {} };
  }
}
function save(s) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(s, null, 2) + "\n");
}

const store = load();
const head = (await rpc("block", { finality: "final" })).header.height;

// Resume from the cursor; otherwise walk back MAX_BLOCKS from the head.
const from = argOf("--from", store.scannedTo ? store.scannedTo + 1 : head - MAX_BLOCKS + 1);
const to = Math.min(head, from + MAX_BLOCKS - 1);

if (from > to) {
  console.log(`Nothing to scan: cursor ${store.scannedTo} is already at head ${head}.`);
  process.exit(0);
}
console.log(`Scanning blocks ${from}..${to} (head ${head}) for refusals by ${VAULT}`);

let blocksSeen = 0;
let chunksFetched = 0;
let chunksSkipped = 0;
let txChecked = 0;
let found = 0;

for (let h = from; h <= to; h++) {
  let blk;
  try {
    blk = await rpc("block", { block_id: h });
  } catch (e) {
    // A garbage-collected or missing block is normal on a public endpoint and
    // must not abort the scan — but it IS a hole in coverage, so say so.
    console.log(`  block ${h}: unavailable (${String(e).slice(0, 60)})`);
    continue;
  }
  blocksSeen++;

  for (const ch of blk.chunks) {
    if (ch.tx_root === EMPTY_TX_ROOT) {
      chunksSkipped++;
      continue;
    }
    chunksFetched++;
    const chunk = await rpc("chunk", { chunk_id: ch.chunk_hash });
    for (const tx of chunk.transactions ?? []) {
      if (tx.receiver_id !== VAULT) continue;
      txChecked++;
      const st = await rpc("EXPERIMENTAL_tx_status", [tx.hash, tx.signer_id]);
      const logs = (st.receipts_outcome ?? []).flatMap((o) => o.outcome.logs ?? []);
      for (const line of logs) {
        if (!line.startsWith("EVENT_JSON:") || !line.includes("request_blocked")) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice("EVENT_JSON:".length));
        } catch {
          continue;
        }
        for (const d of ev.data ?? []) {
          if (store.blocked[d.request_id]) continue;
          store.blocked[d.request_id] = {
            requestId: d.request_id,
            nodeId: d.node_id,
            reasonCode: d.reason_code,
            agent: tx.signer_id,
            txHash: tx.hash,
            blockHeight: h,
            blockTimestampNs: blk.header.timestamp,
          };
          found++;
        }
      }
    }
  }
}

store.vault = VAULT;
store.scannedFrom = store.scannedFrom === null ? from : Math.min(store.scannedFrom, from);
store.scannedTo = Math.max(store.scannedTo ?? 0, to);
save(store);

console.log(
  `  blocks ${blocksSeen}  chunks fetched ${chunksFetched}, skipped empty ${chunksSkipped}  ` +
    `vault txs ${txChecked}`,
);
console.log(`  NEW refusals recorded: ${found}  (total known ${Object.keys(store.blocked).length})`);
console.log(`  coverage now blocks ${store.scannedFrom}..${store.scannedTo} -> ${STORE}`);

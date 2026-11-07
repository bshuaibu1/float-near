/**
 * Recovering refused payments from the chain, continuously.
 *
 * A refusal is deliberately NOT stored in contract state — storing one would
 * let an agent inflate the vault's storage bill by spamming rejects, which
 * docs/KNOWN-TRADEOFFS.md §2 names as the real griefing vector. The contract
 * emits a NEP-297 event and keeps nothing. That makes the single most
 * important thing this product does invisible to anything that was not
 * watching at the moment it happened.
 *
 * The events do survive, inside receipt outcomes, so they can be read back.
 * No indexer is involved: NearBlocks returns nothing at all for this testnet
 * account, so everything here is plain RPC and reproducible by anyone.
 *
 * Two things this module is careful about:
 *
 *   COST. A naive walk queries every chunk of every block. In practice one
 *   chunk in ten carries any transaction, and an empty chunk's `tx_root` is
 *   the all-ones hash, so empties are skipped without a second call. Work per
 *   tick is also capped, so a long outage cannot turn the catch-up into a
 *   thundering scan.
 *
 *   HONESTY ABOUT COVERAGE. A public RPC garbage-collects old blocks and
 *   occasionally fails a request. Those blocks are HOLES, and a range that
 *   contains holes is not covered. Reporting `from..to` while having silently
 *   skipped blocks inside it would turn "we did not look there" into "nothing
 *   happened" — the exact confusion this feature exists to remove.
 */

/** A chunk with no transactions carries this as its tx_root. */
export const EMPTY_TX_ROOT = "11111111111111111111111111111111";

export type RpcFn = (method: string, params: unknown) => Promise<any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An RPC caller that paces itself and backs off when throttled.
 *
 * Added after watching the follower shred its own coverage map. Public
 * endpoints rate-limit; without backoff every transient `429` turned into a
 * PERMANENT gap, because a block that could not be read is recorded as
 * unread. One load test left 33 fragmented gaps of three to twenty blocks
 * each — each one technically honest and collectively useless, since nobody
 * is ever going to backfill a five-block hole.
 *
 * Holes should mean "this span is genuinely unavailable", not "the endpoint
 * was briefly busy". Retrying is what keeps that distinction meaningful.
 */
export function createRpc(
  url: string,
  opts: { paceMs?: number; maxRetries?: number; onThrottle?: (waitMs: number) => void } = {},
): RpcFn {
  const paceMs = opts.paceMs ?? 25;
  const maxRetries = opts.maxRetries ?? 5;

  return async function rpc(method, params, attempt = 0): Promise<any> {
    if (paceMs) await sleep(paceMs);
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      // A dropped connection mid-scan is routine, not exceptional.
      if (attempt >= maxRetries) throw e;
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
      return rpc(method, params, attempt + 1);
    }
    if (r.status === 429 || r.status >= 500) {
      if (attempt >= maxRetries) throw new Error(`RPC HTTP ${r.status} after ${attempt} retries`);
      const wait = Math.min(30_000, 500 * 2 ** attempt);
      opts.onThrottle?.(wait);
      await sleep(wait);
      return rpc(method, params, attempt + 1);
    }
    /**
     * READ THE BODY BEFORE JUDGING THE STATUS.
     *
     * NEAR answers a handler error with HTTP 422 AND a complete JSON-RPC
     * error body. The previous order — `if (!r.ok) throw` first — threw a
     * bare `RPC HTTP 422` and never looked, so every caller saw a failure
     * with no idea what kind.
     *
     * That silently defeated the first version of `isAbsentHeight`: its
     * unit tests passed, because they threw errors with the right shape by
     * hand, and against the real chain it never matched once. Correct and
     * unreachable. Measured: block 276175670 on fastnear's archival
     * endpoint returns 422 with `cause.name = "UNKNOWN_BLOCK"`.
     *
     * `text()` then parse, not `json()`: a proxy or gateway error is HTML,
     * and `json()` would throw over the status this is trying to report.
     */
    const raw = await r.text();
    let j: any = null;
    try {
      j = JSON.parse(raw);
    } catch {
      // Not JSON. The status is all there is to say.
    }

    if (j?.error) {
      // THE ERROR TRAVELS AS DATA, not only as a message. A caller that
      // needs to tell one failure from another should not be parsing a
      // string that was built for a human and truncated to 140 characters.
      // `scanRange` needs exactly that distinction — see `isAbsentHeight`.
      const err = new Error(`${method}: ${JSON.stringify(j.error).slice(0, 140)}`) as RpcError;
      err.rpcError = j.error;
      throw err;
    }
    if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
    return j?.result;
  } as RpcFn;
}

/** An RPC failure that carries the JSON-RPC error object it came from. */
export interface RpcError extends Error {
  rpcError?: { name?: string; cause?: { name?: string }; data?: unknown };
}

/**
 * Did this failure mean "no block was ever produced at that height"?
 *
 * NEAR gives every slot a height, and when a producer misses its slot that
 * height never gets a block. Measured on testnet: 8 of the 1,604 heights in
 * one real scan, about 0.5%. Those heights are not gaps in coverage — there
 * is nothing at them to read, by anyone, ever.
 *
 * The scanner used to record them as unread, so every scan of every vault
 * reported holes that could never be filled and the dashboard said "refusal
 * history is incomplete" permanently, for a reason that was not real.
 *
 * `UNKNOWN_BLOCK` ALONE IS NOT ENOUGH, and this is the trap. A non-archival
 * node returns the same `UNKNOWN_BLOCK` for a block that genuinely exists
 * but has been garbage-collected — measured against the default testnet RPC,
 * which returned it for every height in that same scan, including ones the
 * scanner had read successfully. Treating that as "nothing there" would
 * claim coverage of a range never read, which is the exact failure this
 * subsystem exists to prevent.
 *
 * The two are distinguishable by what the node could resolve:
 *
 *   never produced   data: "DB Not Found Error: BLOCK HEIGHT: 276175670"
 *   node lacks it    data: "DB Not Found Error: BLOCK: DN5cUfsq…"
 *
 * A HEIGHT that resolves to nothing means no block exists. A HASH means the
 * node resolved the height to a block and only lacks the body.
 *
 * FAILS SAFE. This matches a nearcore error string, which is not a stable
 * API. If that wording changes, the match fails and the height is recorded
 * as a hole — degrading to the old behaviour, which overstates gaps. The
 * opposite error, overstating coverage, is the one that matters, and no
 * change to this string can produce it.
 */
export function isAbsentHeight(e: unknown): boolean {
  const err = e as RpcError;
  const rpc = err?.rpcError;
  if (!rpc) return false;
  if (rpc.cause?.name !== "UNKNOWN_BLOCK") return false;
  return typeof rpc.data === "string" && /BLOCK HEIGHT:/i.test(rpc.data);
}

export interface BlockedRecord {
  requestId: string;
  nodeId: number;
  reasonCode: string;
  agent: string;
  txHash: string;
  blockHeight: number;
  blockTimestampNs: string;
}

export interface ScanResult {
  records: BlockedRecord[];
  blocksSeen: number;
  chunksFetched: number;
  chunksSkipped: number;
  /** Heights that could not be read. Coverage inside a hole is unknown. */
  holes: number[];
  /**
   * Heights where NEAR never produced a block, so there was nothing to read.
   *
   * NOT holes. Counted separately so a scan can still SAY how many it met —
   * silently dropping them would make "1,604 blocks, 1,596 seen" look like
   * an arithmetic error with no explanation on screen.
   */
  absentHeights: number[];
}

/**
 * Pull `request_blocked` events out of one transaction's receipt logs.
 * Exported for testing: this parsing is the part that silently breaks if the
 * event format ever changes.
 */
export function extractBlocked(
  logs: string[],
  ctx: { agent: string; txHash: string; blockHeight: number; blockTimestampNs: string },
): BlockedRecord[] {
  const out: BlockedRecord[] = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:") || !line.includes("request_blocked")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line.slice("EVENT_JSON:".length));
    } catch {
      // A malformed log line is not a reason to abandon the rest of the
      // transaction, nor to pretend the others do not exist.
      continue;
    }
    if (ev?.event !== "request_blocked") continue;
    for (const d of ev.data ?? []) {
      if (typeof d?.request_id !== "string") continue;
      out.push({
        requestId: d.request_id,
        nodeId: Number(d.node_id),
        reasonCode: String(d.reason_code ?? "UNKNOWN"),
        ...ctx,
      });
    }
  }
  return out;
}

/** Scan an inclusive block range for refusals by `vault`. */
export async function scanRange(
  rpc: RpcFn,
  vault: string,
  from: number,
  to: number,
): Promise<ScanResult> {
  const res: ScanResult = {
    records: [],
    blocksSeen: 0,
    chunksFetched: 0,
    chunksSkipped: 0,
    holes: [],
    absentHeights: [],
  };

  for (let h = from; h <= to; h++) {
    let blk: any;
    try {
      blk = await rpc("block", { block_id: h });
    } catch (e) {
      // A height NEAR never produced is not a gap in coverage: there is
      // nothing at it to read. Anything else is a genuine failure and stays
      // a hole. See `isAbsentHeight` for why UNKNOWN_BLOCK alone is not
      // enough to tell those apart.
      if (isAbsentHeight(e)) res.absentHeights.push(h);
      else res.holes.push(h);
      continue;
    }
    res.blocksSeen++;

    for (const ch of blk.chunks ?? []) {
      if (ch.tx_root === EMPTY_TX_ROOT) {
        res.chunksSkipped++;
        continue;
      }
      let chunk: any;
      try {
        chunk = await rpc("chunk", { chunk_id: ch.chunk_hash });
        res.chunksFetched++;
      } catch {
        // A chunk we could not read means this block is not fully covered.
        res.holes.push(h);
        continue;
      }
      for (const tx of chunk.transactions ?? []) {
        if (tx.receiver_id !== vault) continue;
        let st: any;
        try {
          st = await rpc("EXPERIMENTAL_tx_status", [tx.hash, tx.signer_id]);
        } catch {
          res.holes.push(h);
          continue;
        }
        const logs: string[] = (st.receipts_outcome ?? []).flatMap(
          (o: any) => o.outcome?.logs ?? [],
        );
        res.records.push(
          ...extractBlocked(logs, {
            agent: tx.signer_id,
            txHash: tx.hash,
            blockHeight: h,
            blockTimestampNs: String(blk.header?.timestamp ?? "0"),
          }),
        );
      }
    }
  }
  return res;
}

/** An inclusive span of blocks that was NOT read. */
export interface Hole {
  from: number;
  to: number;
}

export interface BlockedStore {
  vault: string;
  scannedFrom: number | null;
  scannedTo: number | null;
  /**
   * Spans known to be unread, as RANGES rather than individual heights.
   * An adapter restarted after a day is tens of thousands of blocks behind;
   * listing each one would bloat the file to no purpose. Kept so that
   * coverage is never overstated — `scannedFrom..scannedTo` minus these is
   * what has actually been examined.
   */
  holes: Hole[];
  blocked: Record<string, BlockedRecord>;
}

/** Merge overlapping/adjacent spans so the list stays short and readable. */
export function coalesce(spans: Hole[]): Hole[] {
  if (spans.length < 2) return [...spans];
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const out: Hole[] = [{ ...sorted[0]! }];
  for (const s of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ ...s });
  }
  return out;
}

export function emptyStore(vault: string): BlockedStore {
  return { vault, scannedFrom: null, scannedTo: null, holes: [], blocked: {} };
}

/**
 * Decide whether a persisted log belongs to the vault being served.
 *
 * CAUGHT ON A LIVE DASHBOARD. The adapter was pointed at a vault with exactly
 * ONE node, and the activity page showed six refusals attributed to nodes 5
 * through 20, five days old, by agents named `s*.v3.floatvault-12329.testnet`
 * — real refusals from a DIFFERENT vault, left in `.demo/blocked-log.json` by
 * an earlier swarm test. The loader read `parsed.vault ?? env.vault` and never
 * compared the two, so any vault's log loaded into any other vault's
 * dashboard.
 *
 * Not merely cosmetic. The store also carries `scannedFrom`/`scannedTo`, so
 * adopting a foreign log makes the follower believe it has COVERAGE of block
 * ranges it never scanned for this vault — collapsing "we looked and found
 * nothing" back into "we never looked here", which is the one distinction this
 * module exists to preserve.
 *
 * Refusing a payment is this product's headline behaviour, so showing another
 * vault's refusals as yours is worse than showing none.
 *
 * A log with NO vault recorded predates the field. That one is adopted — it is
 * almost certainly ours, written before the field existed — but adopted under
 * THIS vault's name, so the next load can check it.
 */
export function adoptBlockedStore(parsed: BlockedStore, vault: string): BlockedStore {
  if (parsed.vault && parsed.vault !== vault) return emptyStore(vault);
  return {
    vault,
    scannedFrom: parsed.scannedFrom ?? null,
    scannedTo: parsed.scannedTo ?? null,
    holes: Array.isArray(parsed.holes) ? parsed.holes : [],
    blocked: parsed.blocked ?? {},
  };
}

/** Fold a scan result into a store. Pure, so the merge rules are testable. */
export function mergeScan(
  store: BlockedStore,
  from: number,
  to: number,
  res: ScanResult,
): { store: BlockedStore; added: number } {
  let added = 0;
  for (const r of res.records) {
    if (store.blocked[r.requestId]) continue; // same refusal seen twice
    store.blocked[r.requestId] = r;
    added++;
  }
  // THE GAP BETWEEN DISJOINT SCANS IS A HOLE, and nothing but this merge can
  // see it. A single `scanRange` reports the blocks IT could not read; it has
  // no idea another range was scanned 54,000 blocks away.
  //
  // Without this, min/max over the two ranges claims the whole envelope as
  // covered. Observed live: 1,500 blocks scanned, then 160 blocks scanned
  // 54,300 later, and the store reported `scannedFrom 275882255, scannedTo
  // 275938214, holes: []` — 55,960 blocks claimed, 1,660 actually read. The
  // dashboard caveat written to prevent precisely this confusion would then
  // have rendered the fabrication as fact.
  const newHoles: Hole[] = [];
  if (store.scannedFrom !== null && store.scannedTo !== null) {
    // Scanning forward, away from the existing range.
    if (from > store.scannedTo + 1) newHoles.push({ from: store.scannedTo + 1, to: from - 1 });
    // Scanning backward, leaving the gap above the new range.
    if (to < store.scannedFrom - 1) newHoles.push({ from: to + 1, to: store.scannedFrom - 1 });
  }

  store.scannedFrom = store.scannedFrom === null ? from : Math.min(store.scannedFrom, from);
  store.scannedTo = Math.max(store.scannedTo ?? 0, to);

  // CLEAR FIRST, THEN ADD. Order matters and getting it wrong is silent.
  //
  // Scanning a span that was previously a hole must REMOVE it, or a backfill
  // that genuinely read those blocks leaves coverage understated forever.
  // But this subtraction has to run BEFORE this scan's own holes are added —
  // a scanner hole is by definition INSIDE the range just scanned, so doing it
  // the other way round deletes the holes this very call just reported. The
  // pre-existing "carries holes forward" test caught exactly that.
  if (store.holes.length) {
    store.holes = coalesce(
      store.holes.flatMap((h) => {
        if (to < h.from || from > h.to) return [h]; // untouched by this scan
        const left = h.from < from ? [{ from: h.from, to: Math.min(h.to, from - 1) }] : [];
        const right = h.to > to ? [{ from: Math.max(h.from, to + 1), to: h.to }] : [];
        return [...left, ...right];
      }),
    );
  }

  const scannerHoles = res.holes.map((h) => ({ from: h, to: h }));
  if (newHoles.length || scannerHoles.length) {
    store.holes = coalesce([...store.holes, ...newHoles, ...scannerHoles]);
  }

  return { store, added };
}

export interface FollowerOptions {
  rpc: RpcFn;
  vault: string;
  load: () => BlockedStore;
  save: (s: BlockedStore) => void;
  /** Milliseconds between ticks. */
  intervalMs?: number;
  /** Hard cap on blocks examined per tick, so catch-up stays bounded. */
  maxBlocksPerTick?: number;
  /**
   * If the cursor falls further behind the head than this, STOP trying to
   * walk the gap: record it as a hole and resume at the head.
   *
   * Grinding through a day's backlog is tens of thousands of RPC calls and
   * leaves the follower useless for hours. Jumping silently would be worse —
   * it would report the skipped span as covered. Recording the hole keeps the
   * adapter current AND keeps the coverage claim true; the gap can then be
   * filled deliberately with scripts/scan-blocked.mjs.
   */
  maxCatchupBlocks?: number;
  onTick?: (info: { from: number; to: number; added: number; holes: number }) => void;
  /** Called when a backlog was too large to walk and became a hole. */
  onSkip?: (span: Hole) => void;
}

/**
 * Follows the chain head, recording refusals as they happen.
 *
 * Starts from the stored cursor when there is one, and otherwise from the
 * CURRENT head — never from genesis. A fresh adapter should not spend its
 * first hour replaying history nobody asked for; `scripts/scan-blocked.mjs`
 * exists for deliberate backfill.
 */
export class BlockedFollower {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly o: FollowerOptions) {}

  async tick(): Promise<void> {
    // Ticks must never overlap. A slow catch-up on a quiet RPC would
    // otherwise stack, and two scans sharing a cursor double the work and
    // race on the store.
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const head: number = (await this.o.rpc("block", { finality: "final" })).header.height;
      const store = this.o.load();
      const cap = this.o.maxBlocksPerTick ?? 50;
      const maxCatchup = this.o.maxCatchupBlocks ?? 5_000;
      let from = store.scannedTo === null ? head : store.scannedTo + 1;
      if (from > head) return;

      if (head - from > maxCatchup) {
        const skipFrom = from;
        const skipTo = head - 1;
        store.holes = coalesce([...store.holes, { from: skipFrom, to: skipTo }]);
        this.o.onSkip?.({ from: skipFrom, to: skipTo });
        from = head;
      }

      const to = Math.min(head, from + cap - 1);

      const res = await scanRange(this.o.rpc, this.o.vault, from, to);
      const { store: next, added } = mergeScan(store, from, to, res);
      next.vault = this.o.vault;
      this.o.save(next);
      this.o.onTick?.({ from, to, added, holes: res.holes.length });
    } catch {
      // A failed tick is normal on a public endpoint. Swallow it: the cursor
      // did not advance, so the next tick retries the same range.
    } finally {
      this.running = false;
    }
  }

  start(): void {
    this.stopped = false;
    const ms = this.o.intervalMs ?? 10_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), ms);
    // Do not hold the process open on this timer alone.
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

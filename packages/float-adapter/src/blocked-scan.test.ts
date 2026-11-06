import { describe, it, expect, vi } from "vitest";
import {
  adoptBlockedStore,
  BlockedFollower,
  EMPTY_TX_ROOT,
  emptyStore,
  extractBlocked,
  mergeScan,
  scanRange,
  coalesce,
  createRpc,
  type BlockedStore,
  type ScanResult,
  type RpcFn,
} from "./blocked-scan.js";

const VAULT = "v3.float.testnet";

/** The real event line the contract emits, verbatim from lib.rs:1275. */
const blockedLog = (id: string, node: number, code = "PARENT_DAILY_BUDGET") =>
  `EVENT_JSON:{"standard":"vault","version":"1.0.0","event":"request_blocked","data":[{"request_id":"${id}","node_id":${node},"reason_code":"${code}"}]}`;

const CTX = { agent: "s0.v3.float.testnet", txHash: "tx1", blockHeight: 100, blockTimestampNs: "5" };

describe("parsing refusal events", () => {
  it("reads the event the contract actually emits", () => {
    const [r] = extractBlocked([blockedLog("req-1", 5)], CTX);
    expect(r).toMatchObject({
      requestId: "req-1",
      nodeId: 5,
      reasonCode: "PARENT_DAILY_BUDGET",
      agent: "s0.v3.float.testnet",
      txHash: "tx1",
    });
  });

  it("ignores other events on the same transaction", () => {
    const other = `EVENT_JSON:{"standard":"vault","version":"1.0.0","event":"swept_stuck","data":[{"swept":2}]}`;
    expect(extractBlocked([other, "plain log line"], CTX)).toHaveLength(0);
  });

  it("keeps the good events when one log line is malformed", () => {
    // A truncated line must not discard the rest of the transaction.
    const broken = `EVENT_JSON:{"event":"request_blocked","data":[{`;
    const rs = extractBlocked([broken, blockedLog("req-2", 7)], CTX);
    expect(rs.map((r) => r.requestId)).toEqual(["req-2"]);
  });
});

/** A fake chain: one block, one non-empty chunk, one refusal. */
function fakeRpc(over: Partial<Record<string, any>> = {}): RpcFn {
  return vi.fn(async (method: string, params: any) => {
    if (method === "block") {
      if (params?.finality) return { header: { height: 100 } };
      return {
        header: { height: params.block_id, timestamp: "1700000000000000000" },
        chunks: [
          { tx_root: EMPTY_TX_ROOT, chunk_hash: "empty" },
          { tx_root: "abc", chunk_hash: "full" },
        ],
      };
    }
    if (method === "chunk") {
      return { transactions: [{ hash: "txA", signer_id: "s0.v3.float.testnet", receiver_id: VAULT }] };
    }
    if (method === "EXPERIMENTAL_tx_status") {
      return { receipts_outcome: [{ outcome: { logs: [blockedLog("req-A", 5)] } }] };
    }
    throw new Error(`unexpected ${method}`);
  }) as RpcFn;
}

describe("scanning a range", () => {
  it("finds a refusal and skips empty chunks without fetching them", async () => {
    const rpc = fakeRpc();
    const res = await scanRange(rpc, VAULT, 100, 100);
    expect(res.records.map((r) => r.requestId)).toEqual(["req-A"]);
    expect(res.chunksSkipped).toBe(1);
    expect(res.chunksFetched).toBe(1);
    // The saving is the point: the empty chunk cost zero RPC calls.
    const calls = (rpc as any).mock.calls.map((c: any[]) => c[0]);
    expect(calls.filter((m: string) => m === "chunk")).toHaveLength(1);
  });

  it("ignores transactions addressed to some other contract", async () => {
    const rpc: RpcFn = async (m, p: any) => {
      if (m === "block")
        return {
          header: { height: p.block_id, timestamp: "1" },
          chunks: [{ tx_root: "abc", chunk_hash: "c" }],
        };
      if (m === "chunk")
        return { transactions: [{ hash: "t", signer_id: "x.testnet", receiver_id: "other.testnet" }] };
      throw new Error("tx_status should not be reached");
    };
    const res = await scanRange(rpc, VAULT, 100, 100);
    expect(res.records).toEqual([]);
  });

  it("records an unreadable block as a HOLE rather than silently skipping", async () => {
    // The distinction that matters: a block we could not read is not a block
    // where nothing happened. Reporting the range as covered would turn "we
    // did not look" into "no refusals".
    const rpc: RpcFn = async (m, p: any) => {
      if (m === "block" && p?.block_id === 101) throw new Error("gc'd");
      if (m === "block")
        return { header: { height: p.block_id, timestamp: "1" }, chunks: [] };
      throw new Error(`unexpected ${m}`);
    };
    const res = await scanRange(rpc, VAULT, 100, 102);
    expect(res.holes).toEqual([101]);
    expect(res.blocksSeen).toBe(2);
  });
});

describe("merging into the store", () => {
  it("does not record the same refusal twice", () => {
    const s = emptyStore(VAULT);
    const rec = { requestId: "r", nodeId: 1, reasonCode: "X", agent: "a", txHash: "t", blockHeight: 1, blockTimestampNs: "1" };
    mergeScan(s, 1, 1, { records: [rec], blocksSeen: 1, chunksFetched: 0, chunksSkipped: 0, holes: [] });
    const second = mergeScan(s, 2, 2, { records: [rec], blocksSeen: 1, chunksFetched: 0, chunksSkipped: 0, holes: [] });
    expect(second.added).toBe(0);
    expect(Object.keys(s.blocked)).toHaveLength(1);
  });

  it("carries holes forward so coverage is never overstated", () => {
    const s = emptyStore(VAULT);
    mergeScan(s, 1, 10, { records: [], blocksSeen: 9, chunksFetched: 0, chunksSkipped: 0, holes: [4] });
    mergeScan(s, 11, 20, { records: [], blocksSeen: 9, chunksFetched: 0, chunksSkipped: 0, holes: [15] });
    expect(s.scannedFrom).toBe(1);
    expect(s.scannedTo).toBe(20);
    expect(s.holes).toEqual([
      { from: 4, to: 4 },
      { from: 15, to: 15 },
    ]);
  });
});

describe("the follower", () => {
  const mem = (init?: BlockedStore) => {
    let s = init ?? emptyStore(VAULT);
    return { load: () => s, save: (n: BlockedStore) => void (s = n), get: () => s };
  };

  it("starts at the head, not at genesis, when there is no cursor", async () => {
    // A fresh adapter must not spend its first hour replaying history.
    const store = mem();
    const rpc = fakeRpc();
    const f = new BlockedFollower({ rpc, vault: VAULT, load: store.load, save: store.save });
    await f.tick();
    expect(store.get().scannedFrom).toBe(100);
    expect(store.get().scannedTo).toBe(100);
  });

  it("caps how many blocks one tick will examine", async () => {
    // Otherwise a long outage turns catch-up into a thundering scan.
    const start = { ...emptyStore(VAULT), scannedFrom: 1, scannedTo: 1 };
    const store = mem(start);
    const rpc = fakeRpc();
    const f = new BlockedFollower({
      rpc,
      vault: VAULT,
      load: store.load,
      save: store.save,
      maxBlocksPerTick: 5,
    });
    await f.tick();
    expect(store.get().scannedTo).toBe(6); // 2..6, not 2..100
  });

  it("does not advance the cursor when the tick fails", async () => {
    // The next tick must retry the same range rather than skip over it.
    const store = mem({ ...emptyStore(VAULT), scannedFrom: 10, scannedTo: 10 });
    const rpc: RpcFn = async () => {
      throw new Error("rpc down");
    };
    const f = new BlockedFollower({ rpc, vault: VAULT, load: store.load, save: store.save });
    await f.tick();
    expect(store.get().scannedTo).toBe(10);
  });

  it("never runs two ticks at once", async () => {
    // Overlapping ticks share a cursor: they double the work and race on the
    // store. Proven by holding the first tick open and firing a second.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let headCalls = 0;
    const rpc: RpcFn = async (m, p: any) => {
      if (m === "block" && p?.finality) {
        headCalls++;
        await gate;
        return { header: { height: 100 } };
      }
      return { header: { height: p?.block_id ?? 100, timestamp: "1" }, chunks: [] };
    };
    const store = mem();
    const f = new BlockedFollower({ rpc, vault: VAULT, load: store.load, save: store.save });
    const first = f.tick();
    await f.tick(); // must return immediately, doing nothing
    expect(headCalls).toBe(1);
    release();
    await first;
    expect(headCalls).toBe(1);
  });
});

describe("coverage honesty under a large backlog", () => {
  it("coalesces adjacent and overlapping spans", () => {
    expect(coalesce([{ from: 5, to: 6 }, { from: 1, to: 3 }, { from: 4, to: 4 }])).toEqual([
      { from: 1, to: 6 },
    ]);
    expect(coalesce([{ from: 1, to: 2 }, { from: 10, to: 12 }])).toEqual([
      { from: 1, to: 2 },
      { from: 10, to: 12 },
    ]);
  });

  it("turns an oversized backlog into a HOLE and resumes at the head", async () => {
    // The adapter has been down a long time. Walking the gap would be tens of
    // thousands of RPC calls; jumping it silently would report the skipped
    // span as covered. Neither is acceptable, so the gap is recorded.
    let saved: BlockedStore | null = null;
    const store = { ...emptyStore(VAULT), scannedFrom: 1, scannedTo: 1_000 };
    const rpc = fakeRpc(); // head = 100 ... use a far head instead
    const farRpc: RpcFn = async (m: string, p: any) => {
      if (m === "block" && p?.finality) return { header: { height: 90_000 } };
      return { header: { height: p?.block_id ?? 0, timestamp: "1" }, chunks: [] };
    };
    const skips: unknown[] = [];
    const f = new BlockedFollower({
      rpc: farRpc,
      vault: VAULT,
      load: () => store,
      save: (s) => void (saved = s),
      maxCatchupBlocks: 5_000,
      maxBlocksPerTick: 50,
      onSkip: (s) => skips.push(s),
    });
    await f.tick();

    expect(skips).toEqual([{ from: 1_001, to: 89_999 }]);
    expect(saved!.holes).toEqual([{ from: 1_001, to: 89_999 }]);
    // And it is now current rather than 89k blocks behind.
    expect(saved!.scannedTo).toBe(90_000);
  });

  it("walks a small backlog normally instead of calling it a hole", async () => {
    const store = { ...emptyStore(VAULT), scannedFrom: 1, scannedTo: 95 };
    let saved: BlockedStore | null = null;
    const f = new BlockedFollower({
      rpc: fakeRpc(), // head = 100
      vault: VAULT,
      load: () => store,
      save: (s) => void (saved = s),
      maxCatchupBlocks: 5_000,
    });
    await f.tick();
    expect(saved!.holes).toEqual([]);
    expect(saved!.scannedTo).toBe(100);
  });
});

describe("rpc throttling behaviour", () => {
  const okBody = { ok: true, status: 200, json: async () => ({ result: { fine: true } }) };
  const throttled = { ok: false, status: 429, json: async () => ({}) };

  it("retries a 429 and succeeds, rather than turning it into a gap", async () => {
    // This is the whole reason createRpc exists. A transient 429 that
    // propagates becomes an unreadable block, which becomes a permanent hole
    // in the coverage map. One load test produced 33 such holes.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(throttled)
      .mockResolvedValueOnce(okBody);
    vi.stubGlobal("fetch", fetchMock);
    const waits: number[] = [];
    const rpc = createRpc("http://x", { paceMs: 0, onThrottle: (ms) => waits.push(ms) });

    await expect(rpc("block", {})).resolves.toEqual({ fine: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Backoff must grow, or a busy endpoint just gets hammered harder.
    expect(waits).toEqual([500, 1000]);
    vi.unstubAllGlobals();
  });

  it("gives up after the retry budget instead of hanging forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(throttled);
    vi.stubGlobal("fetch", fetchMock);
    const rpc = createRpc("http://x", { paceMs: 0, maxRetries: 2 });
    await expect(rpc("block", {})).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.unstubAllGlobals();
  });

  it("does not retry a genuine error like a bad method", async () => {
    // Retrying a 400 just wastes time; only throttling and 5xx are transient.
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const rpc = createRpc("http://x", { paceMs: 0 });
    await expect(rpc("nope", {})).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("adoptBlockedStore refuses another vault's log", () => {
  /**
   * CAUGHT ON A LIVE DASHBOARD. The adapter was pointed at
   * floatv4-testnet.fac.floatv4.testnet — a vault with exactly ONE node — and
   * the activity page showed six refusals attributed to nodes 5 through 20,
   * dated five days earlier, by agents named `s*.v3.floatvault-12329.testnet`.
   * They were real refusals from a DIFFERENT vault, left in
   * `.demo/blocked-log.json` by an earlier swarm test.
   *
   * `loadBlockedStore` read `parsed.vault ?? env.vault` and never compared the
   * two, so any vault's log loaded wholesale into any other vault's dashboard.
   *
   * It is not only a display bug. The store also carries `scannedFrom` and
   * `scannedTo`, so adopting a foreign log makes the follower believe it has
   * COVERAGE of block ranges it never scanned for this vault — turning "we
   * looked and found nothing" and "we never looked here" back into the same
   * thing, which is the confusion this whole module exists to remove.
   *
   * Refusing is the product's headline behaviour. A dashboard that shows
   * someone else's refusals as yours is worse than one that shows none.
   */
  const foreign: BlockedStore = {
    vault: "v3.floatvault-12329.testnet",
    scannedFrom: 274988000,
    scannedTo: 274990000,
    holes: [],
    blocked: {
      "swarm-1": {
        requestId: "swarm-1",
        nodeId: 6,
        reasonCode: "PARENT_DAILY_BUDGET",
        agent: "s1.v3.floatvault-12329.testnet",
        txHash: "BT2U18LPQfs1HwnMqn9GztFTdixRVESPBzaWupV9Zscb",
        blockHeight: 274988232,
        blockTimestampNs: 1793097136890744300,
      },
    },
  };

  it("discards a log belonging to a different vault", () => {
    const got = adoptBlockedStore(foreign, "floatv4-testnet.fac.floatv4.testnet");
    expect(got.vault).toBe("floatv4-testnet.fac.floatv4.testnet");
    expect(got.blocked).toEqual({});
  });

  /**
   * And it must not inherit the cursor. Keeping `scannedTo` from a foreign log
   * would claim coverage this vault has never had.
   */
  it("does not inherit the foreign scan cursor", () => {
    const got = adoptBlockedStore(foreign, "floatv4-testnet.fac.floatv4.testnet");
    expect(got.scannedFrom).toBeNull();
    expect(got.scannedTo).toBeNull();
    expect(got.holes).toEqual([]);
  });

  it("keeps a log that belongs to this vault", () => {
    const got = adoptBlockedStore(foreign, "v3.floatvault-12329.testnet");
    expect(Object.keys(got.blocked)).toEqual(["swarm-1"]);
    expect(got.scannedTo).toBe(274990000);
  });

  /**
   * A log with no vault recorded predates the field. Adopting it is the
   * lesser evil — it is almost certainly this vault's, written before the
   * field existed — but it must be ADOPTED UNDER THIS VAULT'S NAME rather
   * than left nameless, so the next load can check it.
   */
  it("adopts a log with no vault recorded, under this vault's name", () => {
    const legacy = { ...foreign, vault: undefined } as unknown as BlockedStore;
    const got = adoptBlockedStore(legacy, "floatv4-testnet.fac.floatv4.testnet");
    expect(got.vault).toBe("floatv4-testnet.fac.floatv4.testnet");
    expect(Object.keys(got.blocked)).toEqual(["swarm-1"]);
  });
});

describe("mergeScan records the gap between DISJOINT scans", () => {
  /**
   * CAUGHT LIVE, and it is the worst failure this module could have.
   *
   * Blocks 275882255..275883754 were scanned, then — 54,300 blocks later —
   * 275938055..275938214. `mergeScan` took the min/max envelope of the two and
   * recorded `scannedFrom: 275882255, scannedTo: 275938214, holes: []`.
   *
   * The store then claimed 55,960 blocks read when 1,660 had been. The
   * dashboard caveat built to prevent exactly this confusion would have
   * rendered the fabrication as fact: "Refusals have been read from blocks
   * 275882255-275938214 (55,960 blocks)."
   *
   * Scanner-reported holes were handled; the gap BETWEEN two scan ranges was
   * not, because nothing in a single `scanRange` call can observe it. Only the
   * merge can.
   */
  const res = (): ScanResult => ({ records: [], holes: [], blocksSeen: 0, chunksFetched: 0, chunksSkipped: 0 });

  it("records the gap when a later scan does not abut the earlier one", () => {
    let s = emptyStore("v.testnet");
    s = mergeScan(s, 1000, 1999, res()).store;
    s = mergeScan(s, 5000, 5999, res()).store;
    expect(s.scannedFrom).toBe(1000);
    expect(s.scannedTo).toBe(5999);
    const unread = s.holes.reduce((n, h) => n + (h.to - h.from + 1), 0);
    expect(unread).toBe(3000); // 2000..4999
    expect(s.holes).toContainEqual({ from: 2000, to: 4999 });
  });

  /** The honest total has to survive the merge. */
  it("keeps claimed-minus-unread equal to what was really read", () => {
    let s = emptyStore("v.testnet");
    s = mergeScan(s, 1000, 1999, res()).store; // 1000 blocks
    s = mergeScan(s, 5000, 5999, res()).store; // 1000 blocks
    const claimed = s.scannedTo! - s.scannedFrom! + 1;
    const unread = s.holes.reduce((n, h) => n + (h.to - h.from + 1), 0);
    expect(claimed - unread).toBe(2000);
  });

  it("adds no hole when the new range abuts the old one", () => {
    let s = emptyStore("v.testnet");
    s = mergeScan(s, 1000, 1999, res()).store;
    s = mergeScan(s, 2000, 2999, res()).store;
    expect(s.holes).toEqual([]);
  });

  it("adds no hole when the ranges overlap", () => {
    let s = emptyStore("v.testnet");
    s = mergeScan(s, 1000, 1999, res()).store;
    s = mergeScan(s, 1500, 2499, res()).store;
    expect(s.holes).toEqual([]);
  });

  /** Scanning BACKWARDS leaves the gap above the new range. */
  it("records the gap when the new range is below the old one", () => {
    let s = emptyStore("v.testnet");
    s = mergeScan(s, 5000, 5999, res()).store;
    s = mergeScan(s, 1000, 1999, res()).store;
    expect(s.scannedFrom).toBe(1000);
    expect(s.scannedTo).toBe(5999);
    expect(s.holes).toContainEqual({ from: 2000, to: 4999 });
  });

  /** Filling a gap must REMOVE it, or coverage understates forever. */
  it("clears a hole once the missing range is scanned", () => {
    let s = emptyStore("v.testnet");
    s = mergeScan(s, 1000, 1999, res()).store;
    s = mergeScan(s, 3000, 3999, res()).store;
    expect(s.holes.reduce((n, h) => n + (h.to - h.from + 1), 0)).toBe(1000);
    s = mergeScan(s, 2000, 2999, res()).store;
    expect(s.holes.reduce((n, h) => n + (h.to - h.from + 1), 0)).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  IDLE,
  MAX_POLLS,
  appliedMessage,
  shouldFetch,
  startWatch,
  stopWatch,
  tick,
  type WatchState,
} from "./watch";

const WATCHING: WatchState = { phase: "watching", polls: 0 };
const VISIBLE = { tabVisible: true };

/** Drive the machine n times with a fixed verdict. */
function run(s: WatchState, n: number, allApplied: boolean, tabVisible = true): WatchState {
  let cur = s;
  for (let i = 0; i < n; i++) cur = tick(cur, { allApplied, tabVisible });
  return cur;
}

describe("starting", () => {
  it("watches when there is something to watch for", () => {
    expect(startWatch(1).phase).toBe("watching");
    expect(startWatch(3).phase).toBe("watching");
  });

  it("stays idle when nothing was prepared", () => {
    expect(startWatch(0)).toEqual(IDLE);
  });

  it("resets the budget, so a second transaction gets a full three minutes", () => {
    const spent = run(WATCHING, 10, false);
    expect(spent.polls).toBe(10);
    expect(startWatch(1).polls).toBe(0);
  });
});

describe("success", () => {
  it("moves to applied the moment the chain agrees", () => {
    expect(tick(WATCHING, { allApplied: true, ...VISIBLE }).phase).toBe("applied");
  });

  it("is checked BEFORE the budget, so a last-moment landing still counts", () => {
    // The exact off-by-one that would report a successful change as "stopped
    // watching" for anyone whose transaction took the full window.
    const onTheEdge: WatchState = { phase: "watching", polls: MAX_POLLS };
    expect(tick(onTheEdge, { allApplied: true, ...VISIBLE }).phase).toBe("applied");
  });

  it("stays applied - it does not drift back to watching", () => {
    const done = tick(WATCHING, { allApplied: true, ...VISIBLE });
    expect(run(done, 20, false).phase).toBe("applied");
  });

  it("does not spend another read once applied", () => {
    const done = tick(WATCHING, { allApplied: true, ...VISIBLE });
    expect(shouldFetch(done, true)).toBe(false);
  });
});

describe("giving up", () => {
  it("keeps looking right up to the limit", () => {
    expect(run(WATCHING, MAX_POLLS, false).phase).toBe("watching");
  });

  it("stops one tick past it", () => {
    expect(run(WATCHING, MAX_POLLS + 1, false).phase).toBe("gave-up");
  });

  it("stops fetching once it has given up", () => {
    expect(shouldFetch(run(WATCHING, MAX_POLLS + 1, false), true)).toBe(false);
  });

  it("never reports failure - only that it stopped looking", () => {
    // The whole point. A view at final finality can trail a write, so
    // "not seen" and "rejected" are different claims and we can only make
    // the first.
    const phases = ["idle", "watching", "applied", "gave-up"];
    expect(phases).not.toContain("failed");
    expect(run(WATCHING, 99, false).phase).toBe("gave-up");
  });
});

describe("a hidden tab", () => {
  it("does not spend the budget", () => {
    const after = run(WATCHING, 100, false, false);
    expect(after.polls).toBe(0);
    expect(after.phase).toBe("watching");
  });

  it("does not fetch", () => {
    expect(shouldFetch(WATCHING, false)).toBe(false);
  });

  it("still has its full window when the tab comes back", () => {
    const hidden = run(WATCHING, 100, false, false);
    expect(run(hidden, MAX_POLLS, false, true).phase).toBe("watching");
    expect(run(hidden, MAX_POLLS + 1, false, true).phase).toBe("gave-up");
  });

  it("still notices a change that landed while hidden, on the first visible tick", () => {
    const hidden = run(WATCHING, 5, false, false);
    expect(tick(hidden, { allApplied: true, tabVisible: true }).phase).toBe("applied");
  });
});

describe("idle", () => {
  it("ignores ticks entirely", () => {
    expect(run(IDLE, 10, false)).toEqual(IDLE);
    expect(run(IDLE, 10, true)).toEqual(IDLE);
  });

  it("does not fetch", () => {
    expect(shouldFetch(IDLE, true)).toBe(false);
  });

  it("is what stopping produces", () => {
    expect(stopWatch()).toEqual(IDLE);
  });
});

describe("appliedMessage", () => {
  it("is singular for one transaction", () => {
    expect(appliedMessage(1)).toBe("Change applied");
  });

  it("counts when there are several", () => {
    expect(appliedMessage(2)).toBe("2 changes applied");
    expect(appliedMessage(3)).toBe("3 changes applied");
  });
});

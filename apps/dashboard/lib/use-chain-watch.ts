"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IDLE,
  POLL_MS,
  appliedMessage,
  shouldFetch,
  startWatch,
  stopWatch,
  tick,
  type WatchState,
} from "./watch";

/**
 * Watch the chain until a prepared transaction shows up on it.
 *
 * This hook owns NO decisions. Every transition lives in ./watch.ts as a
 * pure reducer, because the bug this replaced was invisible to typechecking
 * and to unit tests: the success branch started a timer and then set a piece
 * of state that was one of its own effect's dependencies, so the effect
 * re-ran, its cleanup fired, and the timer was cancelled before it did
 * anything. Keeping the logic out of the effect is what makes that shape
 * impossible rather than merely fixed.
 *
 * The caller supplies:
 *   txCount    how many transactions are prepared (0 stops the watch)
 *   allApplied whether the chain already shows all of them
 *   refresh    re-read the chain; called only when a poll is actually due
 */
export function useChainWatch({
  txCount,
  allApplied,
  refresh,
  onApplied,
}: {
  txCount: number;
  allApplied: boolean;
  refresh: () => void | Promise<void>;
  onApplied?: (message: string) => void;
}) {
  const [state, setState] = useState<WatchState>(IDLE);

  // Read through refs inside the interval so the timer never has to be torn
  // down and rebuilt when these change - which is what made the old version
  // cancel its own work.
  const appliedRef = useRef(allApplied);
  const refreshRef = useRef(refresh);
  const countRef = useRef(txCount);
  const announcedRef = useRef(false);
  appliedRef.current = allApplied;
  refreshRef.current = refresh;
  countRef.current = txCount;

  // A newly prepared transaction restarts the watch with a full budget.
  useEffect(() => {
    announcedRef.current = false;
    setState(startWatch(txCount));
  }, [txCount]);

  const lastFetch = useRef(0);
  const doRefresh = useCallback(() => {
    lastFetch.current = Date.now();
    void refreshRef.current();
  }, []);

  // A mirror of the state for the interval to read, so the decision can be
  // made OUTSIDE a setState updater.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (state.phase !== "watching") return;
    const id = setInterval(() => {
      const visible = typeof document === "undefined" || document.visibilityState !== "hidden";

      /**
       * The fetch happens HERE, not inside a setState updater.
       *
       * It used to live in the updater, which React double-invokes under
       * StrictMode in development precisely to surface impure updaters - so
       * every tick fetched twice while the poll budget counted once.
       * Measured: 2 reads where 1 was expected. Harmless in production,
       * where StrictMode is off, but it meant the budget was a lie and dev
       * burned double the requests against a public RPC.
       */
      const cur = stateRef.current;
      const next = tick(cur, { allApplied: appliedRef.current, tabVisible: visible });
      if (next !== cur) setState(next);
      if (shouldFetch(next, visible) && next.polls > cur.polls) doRefresh();
    }, POLL_MS);
    return () => clearInterval(id);
    // `state.phase` only - NOT the whole state. Depending on `polls` would
    // rebuild the interval on every tick, resetting the clock each time.
  }, [state.phase, doRefresh]);

  /**
   * Read immediately when the tab comes back.
   *
   * "Sign in wallet" opens the signing page in a NEW TAB, so the dashboard is
   * hidden for exactly as long as the owner is signing - and a hidden tab
   * deliberately spends no polls. Without this, returning to a finished
   * transaction means watching a "still looking" pulse for up to another full
   * interval, at the one moment the answer is certainly available.
   *
   * Throttled to one interval's worth, so flipping between tabs cannot turn
   * into a burst of reads against a public RPC.
   */
  useEffect(() => {
    if (state.phase !== "watching") return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetch.current < POLL_MS) return;
      doRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [state.phase, doRefresh]);

  // Announce once, outside the reducer, so the message is a side effect of
  // reaching the state rather than part of computing it.
  useEffect(() => {
    if (state.phase !== "applied" || announcedRef.current) return;
    announcedRef.current = true;
    onApplied?.(appliedMessage(countRef.current));
  }, [state.phase, onApplied]);

  const stop = useCallback(() => setState(stopWatch()), []);

  return { phase: state.phase, polls: state.polls, stop };
}

/**
 * A plain repeating refresh that respects whether anyone is looking.
 *
 * For pages that watch for something open-ended - a deposit landing, a link
 * session being claimed - rather than for one specific prepared transaction.
 *
 * The visibility guard is the whole point. /fund polled every 15 seconds
 * unconditionally and forever: a tab left open overnight is about 5,700
 * requests through the adapter to a public RPC, for a page nobody is reading.
 * This adapter has already rate-limited itself once in this project.
 *
 * Coming back refreshes immediately, so the guard costs nothing in practice -
 * the moment you look is the moment you get current data, which is better
 * than the old behaviour of showing whatever the last background tick found.
 */
export function useVisiblePolling(
  refresh: () => void | Promise<void>,
  ms: number,
  active = true,
) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastFetch = useRef(0);

  useEffect(() => {
    if (!active) return;

    const run = () => {
      lastFetch.current = Date.now();
      void refreshRef.current();
    };

    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      run();
    }, ms);

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Throttled by one interval, so flipping between tabs cannot turn into
      // a burst of reads.
      if (Date.now() - lastFetch.current < ms) return;
      run();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, active]);

}

/**
 * A message that shows itself and then leaves.
 *
 * Separate from the watcher: the panel dismissal used to hang off the
 * watcher's own effect, which is exactly how it got cancelled. Anything
 * timed off "we told the user" belongs here, keyed to a state that is stable
 * for its whole lifetime.
 */
export function useToast(ms = 6000) {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(t);
  }, [toast, ms]);
  return { toast, setToast };
}

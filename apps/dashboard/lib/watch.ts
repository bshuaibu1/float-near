/**
 * The "did my signature land?" state machine.
 *
 * Separated from React deliberately. The first version of this lived inside a
 * useEffect, and its success branch did:
 *
 *     setWatching(false);
 *     setToast(...);
 *     const t = setTimeout(() => setTxs([]), 1400);
 *     return () => clearTimeout(t);
 *
 * `watching` was one of that effect's own dependencies, so setting it false
 * re-ran the effect immediately, fired the cleanup, and cancelled the timer
 * before it could do anything. The toast appeared and the panel never
 * cleared. Nothing typechecked wrong and no unit test could see it, because
 * the whole bug lived in the interaction between two pieces of React state.
 *
 * As a pure reducer the transitions are inspectable and testable, and the
 * hook that drives it owns no decisions at all.
 *
 * ONE RULE: "gave-up" is NOT failure. A view call at final finality can trail
 * a write, and a transaction may simply not have been signed yet. The machine
 * stops LOOKING; it never concludes the change was rejected.
 */

export type WatchPhase = "idle" | "watching" | "applied" | "gave-up";

export type WatchState = {
  phase: WatchPhase;
  /** Network reads actually spent. A skipped tick does not count. */
  polls: number;
};

/**
 * 4s x 45 is three minutes: comfortably longer than a NEAR transaction plus
 * the lag before a final-finality view reports it, and short enough that a
 * wallet closed without signing stops hammering a public RPC. This adapter
 * has already rate-limited itself once in this project.
 */
export const POLL_MS = 4000;
export const MAX_POLLS = 45;

export const IDLE: WatchState = { phase: "idle", polls: 0 };

/** A newly prepared transaction restarts the watch from zero. */
export function startWatch(txCount: number): WatchState {
  return txCount > 0 ? { phase: "watching", polls: 0 } : IDLE;
}

/** Stop looking, without claiming anything about the outcome. */
export function stopWatch(): WatchState {
  return IDLE;
}

/**
 * One tick of the clock.
 *
 * `tabVisible` false means the tick is skipped entirely — the poll budget is
 * not spent on a tab nobody is looking at, so coming back to it still has its
 * full three minutes rather than having silently burnt them.
 */
export function tick(
  s: WatchState,
  opts: { allApplied: boolean; tabVisible: boolean },
): WatchState {
  if (s.phase !== "watching") return s;

  // Checked BEFORE the budget: a change that landed on the very last allowed
  // poll is applied, not given up on.
  if (opts.allApplied) return { phase: "applied", polls: s.polls };

  if (!opts.tabVisible) return s;

  const polls = s.polls + 1;
  if (polls > MAX_POLLS) return { phase: "gave-up", polls };
  return { phase: "watching", polls };
}

/** Whether this tick should actually hit the network. */
export function shouldFetch(s: WatchState, tabVisible: boolean): boolean {
  return s.phase === "watching" && tabVisible;
}

/** What to say once everything prepared is visible on chain. */
export function appliedMessage(txCount: number): string {
  return txCount > 1 ? `${txCount} changes applied` : "Change applied";
}

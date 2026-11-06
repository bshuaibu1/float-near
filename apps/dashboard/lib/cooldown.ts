/**
 * The cooldown control's state machine.
 *
 * Extracted because the select had a classic derived-state bug: its value was
 * computed PURELY from the seconds, as
 *
 *     value = isPreset(seconds) ? String(seconds) : "custom"
 *
 * with an onChange that ignored "custom" entirely. Choosing Custom therefore
 * changed no state, the value recomputed from the unchanged seconds, and the
 * dropdown snapped straight back to the preset. Custom was unreachable
 * whenever the current value happened to be a preset — which it is by
 * default, since a new node's cooldown is 0, "No wait".
 *
 * The fix is that "showing the custom input" is UI state, not a function of
 * the data. 60 seconds is a preset AND a legitimate thing to have typed by
 * hand, so the two cannot be told apart from the number alone.
 */
export const COOLDOWN_PRESETS = [
  { v: 0, label: "No wait" },
  { v: 10, label: "10 seconds" },
  { v: 30, label: "30 seconds" },
  { v: 60, label: "1 minute" },
  { v: 300, label: "5 minutes" },
  { v: 3600, label: "1 hour" },
] as const;

export const CUSTOM = "custom";

export function isPresetCooldown(seconds: number): boolean {
  return COOLDOWN_PRESETS.some((p) => p.v === seconds);
}

/** What the <select> should show. */
export function cooldownSelectValue(seconds: number, customMode: boolean): string {
  // customMode wins, so Custom stays selected even when the typed number
  // happens to equal a preset. A value off the preset list forces custom
  // regardless, because no option would otherwise match and the select would
  // render blank.
  if (customMode || !isPresetCooldown(seconds)) return CUSTOM;
  return String(seconds);
}

/** Whether the free-entry seconds box is shown beside the select. */
export function showsCustomInput(seconds: number, customMode: boolean): boolean {
  return cooldownSelectValue(seconds, customMode) === CUSTOM;
}

/** Apply a selection. Choosing Custom keeps the current number to edit. */
export function applyCooldownSelection(
  value: string,
  currentSeconds: number,
): { seconds: number; customMode: boolean } {
  if (value === CUSTOM) return { seconds: currentSeconds, customMode: true };
  return { seconds: Number(value), customMode: false };
}

/** Seeding from the chain: an off-preset value starts in custom mode. */
export function initialCustomMode(seconds: number): boolean {
  return !isPresetCooldown(seconds);
}

/** A number of seconds, named. */
export function cooldownLabel(seconds: number): string {
  return COOLDOWN_PRESETS.find((p) => p.v === seconds)?.label ?? `${seconds} seconds`;
}

/** Clamp typed input to a whole, non-negative number of seconds. */
export function parseCooldownInput(raw: string): number {
  return Math.max(0, Math.floor(Number(raw) || 0));
}

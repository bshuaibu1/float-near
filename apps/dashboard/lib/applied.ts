/**
 * Did the transaction the owner just signed actually change the chain?
 *
 * The page could prepare a perfectly correct transaction, the owner could
 * approve it, and the wallet could drop it — and nothing in this dashboard
 * would have said so. The displayed values only refresh on reload, so the old
 * numbers would sit there looking authoritative.
 *
 * So each prepared transaction carries a declarative expectation, and after
 * signing we re-read the chain and compare. Declarative rather than a
 * closure, so the comparison is a pure function that can be tested without a
 * React tree or a network.
 *
 * ONE RULE THROUGHOUT: a mismatch is "not yet", never "failed".
 *
 * A read at `final` finality taken moments after a write can legitimately be
 * a whole transaction behind — this is measured, recurring NEAR behaviour,
 * not a hypothetical. Reporting "did not apply" on the first miss would
 * routinely call a successful change a failure, which is a worse lie than
 * saying nothing. The caller re-checks; it does not conclude.
 */

export type PolicySnapshot = {
  nodeId: number;
  dailyBudget?: string;
  perTxLimit?: string;
  cooldownSeconds?: number;
  /** The node's OWN list. Absent/empty means it inherits. */
  ownAllowedAddresses?: string[];
  frozen: boolean;
};

export type VaultSnapshot = {
  paused: boolean;
  strictAllocation: boolean;
};

export type Expectation =
  | { kind: "caps"; nodeId: number; daily: string; perTx: string }
  | { kind: "cooldown"; nodeId: number; seconds: number }
  | { kind: "recipients"; nodeId: number; list: string[] }
  | { kind: "frozen"; nodeId: number; value: boolean }
  | { kind: "paused"; value: boolean }
  | { kind: "strict"; value: boolean };

/**
 * Compare two human amounts by VALUE, not by spelling.
 *
 * The page sends "25" and the adapter returns whatever `fromBaseUnits`
 * produces, which for 25 USDC at 6 decimals may be "25" or "25.0". A string
 * compare would report a correctly applied change as still pending forever,
 * and the user would conclude the product is broken when it worked.
 */
function sameAmount(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return a === b;
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * True when the chain already shows what was asked for.
 *
 * False means ONLY "not observed yet" — see the note at the top of the file.
 */
export function isApplied(
  e: Expectation,
  nodes: PolicySnapshot[],
  vault: VaultSnapshot | null,
): boolean {
  if (e.kind === "paused") return vault?.paused === e.value;
  if (e.kind === "strict") return vault?.strictAllocation === e.value;

  const n = nodes.find((x) => x.nodeId === e.nodeId);
  // A node that has vanished from the read is not a success. It is almost
  // certainly a half-loaded response, so it stays "not yet".
  if (!n) return false;

  switch (e.kind) {
    case "caps":
      return sameAmount(n.dailyBudget, e.daily) && sameAmount(n.perTxLimit, e.perTx);
    case "cooldown":
      return (n.cooldownSeconds ?? 0) === e.seconds;
    case "recipients":
      return sameList(n.ownAllowedAddresses, e.list);
    case "frozen":
      return n.frozen === e.value;
  }
}

/** A short, honest status for one expectation. */
export type AppliedStatus = "applied" | "not-yet";

export function appliedStatus(
  e: Expectation,
  nodes: PolicySnapshot[],
  vault: VaultSnapshot | null,
): AppliedStatus {
  return isApplied(e, nodes, vault) ? "applied" : "not-yet";
}

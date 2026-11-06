/**
 * The contract's own rules, checked before a transaction is ever built.
 *
 * WHY THIS IS NOT COSMETIC. Every rule here is one the contract enforces. If
 * the page lets a doomed edit through, the owner approves it in their wallet,
 * pays gas, and watches it revert. So a miss is not "a confusing message" - it
 * is the user paying for nothing.
 *
 * Transcribed from `validate_limits` and `set_node_caps` in
 * contracts/vault/src/lib.rs, with line numbers, NOT from intuition. Two
 * previous drafts got it wrong in exactly the way intuition does:
 *
 *   1. It called `per_tx > daily` a soft warning that "can never bind", on the
 *      assumption the daily cap would stop the payment first. lib.rs:2310
 *      fails outright with `per_tx_cap must be <= daily_cap`.
 *
 *   2. It applied the downward allocation rule ONLY at root. The contract
 *      applies it at every depth (lib.rs:854) - `child_sum_for` is maintained
 *      per node and MAX_DEPTH is 4, so "root -> team -> agent -> sub-agent" is
 *      the documented shape, not an edge case. Shrinking a mid-tree budget
 *      below its children's sum passed validation and reverted on chain. The
 *      page could not do better, because it only received `depth` and not
 *      `parent`: depth says a node is at level 2, not WHICH level-1 node it
 *      hangs from. The adapter now sends `parent`.
 *
 * Pure, so it can be tested and mutated. It was previously a useMemo inside an
 * 867-line component, where none of the above was reachable by a test.
 */

/** Only the fields the rules actually read. */
export type PolicyNode = {
  agentId: string;
  depth?: number;
  parent?: number | null;
  policy?: { dailyBudget?: string } | null;
};

export type ValidationInput = {
  /** Draft values, as typed. Strings because they come from inputs. */
  dailyCap: string;
  perTxCap: string;
  /** What is on chain now, to tell a real edit from an untouched field. */
  base: { daily: string; perTx: string };
  /** The node being edited. */
  selected: PolicyNode | null;
  /** Every node, for sibling and child sums. */
  all: PolicyNode[];
  /** Resolved payee list, already split and trimmed. */
  recipients: string[];
  strictAllocation: boolean;
  vaultId?: string | null;
  /** Maps a node to its contract id, since agentId is an account name. */
  nodeIdOf: (n: PolicyNode) => number;
};

export type ValidationResult = { errs: string[]; warns: string[] };

const capOf = (n: PolicyNode): number => Number(n.policy?.dailyBudget ?? 0) || 0;

/**
 * The children of `node`, by parent id.
 *
 * Replaces `agents.filter(a => a.depth === 1)`, which is only the children of
 * ROOT and silently returns the wrong set for anything else.
 */
export function childrenOf(node: PolicyNode, all: PolicyNode[], nodeIdOf: (n: PolicyNode) => number): PolicyNode[] {
  const id = nodeIdOf(node);
  return all.filter((a) => a.parent === id);
}

export function validatePolicyDraft(input: ValidationInput): ValidationResult {
  const { dailyCap, perTxCap, base, selected, all, recipients, strictAllocation, vaultId, nodeIdOf } =
    input;

  const errs: string[] = [];
  const warns: string[] = [];
  const d = Number(dailyCap);
  const p = Number(perTxCap);
  const capsTouched = dailyCap !== base.daily || perTxCap !== base.perTx;

  if (capsTouched) {
    // validate_limits, lib.rs:2307 - caps must be positive.
    if (!Number.isFinite(d) || d <= 0) {
      errs.push("Daily limit must be greater than zero - the contract rejects a zero cap.");
    }
    if (!Number.isFinite(p) || p <= 0) {
      errs.push("Per payment must be greater than zero - the contract rejects a zero cap.");
    }
    // validate_limits, lib.rs:2310 - per_tx_cap <= daily_cap. Strictly
    // greater-than fails, so an equal pair is legal and must NOT be flagged.
    if (Number.isFinite(d) && Number.isFinite(p) && d > 0 && p > 0 && p > d) {
      errs.push(
        `Per payment (${perTxCap}) cannot exceed the daily limit (${dailyCap}). The contract refuses this outright: "per_tx_cap must be <= daily_cap".`,
      );
    }
  }

  if (capsTouched && strictAllocation && selected && Number.isFinite(d) && d > 0) {
    /**
     * DOWNWARD, at any depth: lib.rs:854.
     *
     *   if l.daily_cap.0 < node.child_sum_for(&l.token) { fail }
     *
     * There is no depth condition in the contract, and there must not be one
     * here. This is the check that used to run only for root.
     */
    const kids = childrenOf(selected, all, nodeIdOf);
    if (kids.length) {
      const allocated = kids.reduce((s, a) => s + capOf(a), 0);
      if (d < allocated) {
        const who = selected.depth === 0 ? "the master" : `"${selected.agentId}"`;
        errs.push(
          `Strict allocation is on, and ${allocated} is already allocated to the budgets beneath ${who}. A cap of ${dailyCap} is below that, which the contract rejects.`,
        );
      }
    }

    /**
     * UPWARD, at any depth: lib.rs:869-878.
     *
     *   new_sum = parent.child_sum - this_node's_old_cap + proposed_cap
     *   if new_sum > parent_cap { fail }
     *
     * `parent.child_sum - old` is exactly the sum of this node's SIBLINGS,
     * which is what is computed below.
     */
    const parentNode = all.find((a) => nodeIdOf(a) === selected.parent);
    if (parentNode) {
      const parentCap = capOf(parentNode);
      if (parentCap > 0) {
        const siblings = childrenOf(parentNode, all, nodeIdOf).filter(
          (a) => a.agentId !== selected.agentId,
        );
        const others = siblings.reduce((s, a) => s + capOf(a), 0);
        if (others + d > parentCap) {
          errs.push(
            `Strict allocation is on. ${others} is allocated to the other budgets under "${parentNode.agentId}", so ${dailyCap} here would take the total to ${
              others + d
            }, above that budget's ${parentCap}. The contract rejects this.`,
          );
        }
      }
    }
  }

  const dupes = recipients.filter((l, i) => recipients.indexOf(l) !== i);
  if (dupes.length) errs.push(`Duplicate payee: ${dupes[0]}`);
  if (vaultId && recipients.includes(vaultId)) errs.push("A vault cannot pay itself.");
  // validate_recipients, lib.rs:2318 - 1..=32.
  if (recipients.length > 32) errs.push("At most 32 payees - the contract rejects more.");

  return { errs, warns };
}

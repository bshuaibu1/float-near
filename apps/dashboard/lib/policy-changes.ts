/**
 * The diff between what the owner typed and what the chain holds.
 *
 * This is what the review panel shows before anyone signs, so it is the last
 * description of the edit a user reads. Getting it wrong is not cosmetic: a
 * row that says "unset -> 50" when the real transition is "100 -> 50" invites
 * someone to approve a REDUCTION believing they are filling in a blank.
 *
 * GROUPED BY TRANSACTION, NOT BY FIELD. `daily_cap` and `per_tx_cap` are two
 * arguments of one `set_node_caps` call. The earlier page gave each its own
 * row and its own button, so editing both and pressing either shipped the
 * other silently, under a label naming only one. The group is what makes the
 * page honest about what a signature does.
 *
 * Pure, so it can be tested and mutated - it was a useMemo inside an 867-line
 * component, where it could not be.
 */
import { cooldownLabel } from "./cooldown";

export type ChangeGroup = "caps" | "cooldown" | "recipients";

export type Change = {
  group: ChangeGroup;
  label: string;
  from: string;
  to: string;
};

export type DraftState = {
  dailyCap: string;
  perTxCap: string;
  cooldown: number;
  /** Already split and trimmed, one payee per entry. */
  recipients: string[];
};

export type ChainState = {
  daily: string;
  perTx: string;
  cooldown: number;
  /** This node's OWN list. Empty means it inherits from an ancestor. */
  ownRecipients: string[];
};

/**
 * INHERIT and EMPTY are different states, and the wording keeps them apart.
 *
 * The contract rejects an empty recipient list outright - `validate_recipients`
 * fails on `is_empty()` with "1..=32 recipients, or None to inherit". So a
 * cleared box does not mean "allow nobody", it means "go back to inheriting",
 * and the review line has to say that or the owner will read it as a lockout.
 */
const INHERITED_FROM = "inherited from above";
const INHERIT_FROM = "inherit from above";

export function computeChanges(
  draft: DraftState,
  base: ChainState,
  hasSelection: boolean,
): Change[] {
  if (!hasSelection) return [];
  const out: Change[] = [];

  if (draft.dailyCap !== base.daily) {
    out.push({
      group: "caps",
      label: "Daily limit",
      // "unset" only when the chain genuinely holds nothing. An empty string
      // here is a node with no limit for this token, not a zero.
      from: base.daily ? `${base.daily} USDC` : "unset",
      to: `${draft.dailyCap || "0"} USDC`,
    });
  }

  if (draft.perTxCap !== base.perTx) {
    out.push({
      group: "caps",
      label: "Per payment",
      from: base.perTx ? `${base.perTx} USDC` : "unset",
      to: `${draft.perTxCap || "0"} USDC`,
    });
  }

  if (draft.cooldown !== base.cooldown) {
    out.push({
      group: "cooldown",
      label: "Cooldown",
      from: cooldownLabel(base.cooldown),
      to: cooldownLabel(draft.cooldown),
    });
  }

  // Compared as a joined string so ORDER counts: the contract stores a list,
  // and reordering it is a real edit that produces a real transaction.
  if (draft.recipients.join("\n") !== base.ownRecipients.join("\n")) {
    out.push({
      group: "recipients",
      label: "Who this agent may pay",
      from: base.ownRecipients.length ? base.ownRecipients.join(", ") : INHERITED_FROM,
      to: draft.recipients.length ? draft.recipients.join(", ") : INHERIT_FROM,
    });
  }

  return out;
}

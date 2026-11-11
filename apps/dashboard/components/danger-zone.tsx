"use client";

/**
 * Closing a vault, as far as a browser can honestly take it.
 *
 * THERE IS NO "CLOSE VAULT" BUTTON HERE, and that is the design.
 *
 * Closing is six steps (scripts/teardown-vault.mjs) and four of them need the
 * VAULT as signer, not the owner: the gas-key withdrawal, the token's
 * `storage_unregister`, the 33-byte stub deploy and the `DeleteAccount`
 * itself. A wallet refuses `DeployContract` from a dApp — which is the entire
 * reason vault CREATION goes through a factory — so no amount of work in this
 * component reaches them.
 *
 * A control that cannot do what it says is bad anywhere and worst here, where
 * the thing it claims to do is irreversible. So this offers the two steps a
 * browser signature CAN reach, and hands over the exact command for the rest.
 *
 * The order is not cosmetic. Step 1 is first because deleting an account does
 * NOT return fungible tokens: the ledger keeps a row keyed to an account
 * nobody can ever sign for again. Step 2 is the only lever that shrinks STATE,
 * and without it the delete is refused outright.
 */

import { useState } from "react";
import { DANGER, SUCCESS, WARN } from "@/lib/colors";
import { teardownState, teardownCommand, baseToDecimal } from "@/lib/teardown";
import { usdc } from "@/lib/money";

export type DangerZoneVault = {
  vaultId: string;
  network: string;
  /**
   * Both REQUIRED, and that is deliberate rather than tidy. The handed-over
   * command needs `OWNER` and `TOKEN`; while they were optional the command
   * omitted them and the script fell back to its author's dev accounts and
   * the mock FT — a wrong token reads as a zero balance and the delete
   * strands the real one. Making them optional here is what let that ship,
   * so the type refuses to build a command it cannot fill in.
   */
  owner: string;
  tokenId: string;
  tokenDecimals?: number;
  vaultTokenBalance?: string | null;
  currentDay?: number | null;
};

export function DangerZone({
  info,
  onPlan,
}: {
  info: DangerZoneVault;
  onPlan: (
    body: Record<string, unknown>,
    label: string,
    from: string,
    to: string,
  ) => Promise<void>;
}) {
  const [receiver, setReceiver] = useState("");
  const [copied, setCopied] = useState(false);

  const state = teardownState(info.vaultTokenBalance);
  const decimals = info.tokenDecimals ?? 6;

  /**
   * The expectation passed to the script, and NULL when the balance is not
   * known to be a clean base-unit string.
   *
   * `teardownState` is the only thing that has validated it, so the guard is
   * its verdict rather than a second opinion: anything other than
   * withdrawable-or-empty means the value was unreadable, and an unreadable
   * balance must omit `EXPECT_TOKENS` entirely. Sending `0` there would
   * convert "I could not read this" into "I checked, it is empty" — the exact
   * substitution that makes a silent delete look verified.
   */
  const expectTokens =
    (state.canWithdraw || state.isEmpty) && typeof info.vaultTokenBalance === "string"
      ? baseToDecimal(info.vaultTokenBalance, decimals)
      : null;

  const cmd = teardownCommand(
    info.vaultId,
    info.network,
    info.owner,
    info.tokenId,
    expectTokens,
  );

  /**
   * Hoisted so the narrowing survives into the click handler. TypeScript
   * will not keep a `typeof info.currentDay === "number"` refinement across
   * a closure — the object could change between render and click — and it is
   * right to refuse: reading it again at click time could find null and send
   * `beforeDay: NaN + 1`, which is a cutoff that deletes nothing while
   * looking like it worked.
   */
  const today = typeof info.currentDay === "number" ? info.currentDay : null;

  /**
   * The readable figure, for a human. EVERY DECISION above uses the base
   * string — this is display only, and it is computed from a value already
   * known to be a plain decimal because `teardownState` refused otherwise.
   */
  const human =
    state.canWithdraw || state.isEmpty
      ? usdc(Number(info.vaultTokenBalance) / 10 ** decimals)
      : null;

  return (
    <div className="mt-8 rounded-xl border bg-card p-5" style={{ borderColor: "#F0D2D2" }}>
      <p
        className="text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: DANGER }}
      >
        Danger zone
      </p>
      <p className="mt-1 text-[13px] font-semibold text-ink">Close this vault</p>
      <p className="mt-1 text-[12px] leading-5 text-muted">
        The deposit that created this vault is storage stake, not a fee, and it comes back
        when the account is deleted. That takes three steps, and the last one needs a
        command: a wallet will not deploy or delete.
      </p>

      {/* 1 — the step that decides whether the money survives */}
      <section className="mt-4 border-t border-line pt-4">
        <p className="text-[12px] font-medium text-ink">1. Move the tokens out</p>
        <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
          Deleting an account does <strong className="font-medium">not</strong> return
          fungible tokens. The ledger keeps a row for an account nobody can sign for again,
          so this step is not optional.
        </p>

        <p className="mt-2 text-[12px] text-muted">
          Vault balance{" "}
          <span className="font-mono tabular-nums text-ink">
            {human !== null ? `${human} USDC` : "unknown"}
          </span>
        </p>

        {state.canWithdraw ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={receiver}
              onChange={(e) => setReceiver(e.target.value)}
              placeholder={`where to send it, e.g. you.${info.network === "mainnet" ? "near" : "testnet"}`}
              aria-label="Account to receive the withdrawn tokens"
              className="min-h-11 min-w-[14rem] flex-1 rounded-lg border border-line bg-card px-3 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
            />
            <button
              type="button"
              disabled={!receiver.trim()}
              onClick={() =>
                void onPlan(
                  {
                    action: "withdraw",
                    /**
                     * The base-unit string the chain returned, VERBATIM.
                     * Any reparse here rounds past 2^53 and leaves dust, and
                     * a vault with dust in it never reaches the zero the
                     * delete needs.
                     */
                    amountBase: info.vaultTokenBalance,
                    receiverId: receiver.trim(),
                  },
                  `Withdraw everything to ${receiver.trim()}`,
                  `${human} USDC in the vault`,
                  "0",
                )
              }
              className="min-h-11 rounded-lg px-4 text-[13px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: DANGER }}
            >
              Withdraw all
            </button>
          </div>
        ) : (
          <p
            className="mt-2 text-[11.5px] leading-5"
            style={{ color: state.isEmpty ? SUCCESS : WARN }}
          >
            {state.isEmpty ? "Nothing to move: the vault holds no tokens." : state.blocker}
          </p>
        )}
      </section>

      {/* 2 — the only lever that shrinks state */}
      <section className="mt-4 border-t border-line pt-4">
        <p className="text-[12px] font-medium text-ink">2. Shrink its records</p>
        <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
          Without this the delete is refused outright. It removes settled payment history:
          spend totals are not refunded, and a purged request id becomes reusable.
        </p>
        {today !== null ? (
          <button
            type="button"
            onClick={() =>
              void onPlan(
                /**
                 * `current_day + 1` — records are removed strictly BEFORE the
                 * cutoff, so today needs the day after it to be included.
                 *
                 * The day comes from the CONTRACT, never from the browser
                 * clock: the vault carries a `clock_mode`, and a test clock
                 * does not track UTC. A cutoff one day out either deletes
                 * live records or silently deletes nothing.
                 */
                { action: "purge", beforeDay: today + 1, limit: 100 },
                "Purge settled payment records",
                "stored",
                "deleted",
              )
            }
            className="mt-2 min-h-11 rounded-lg border border-line bg-card px-4 text-[13px] font-medium text-ink transition-colors hover:bg-chip"
          >
            Purge up to 100 records
          </button>
        ) : (
          <p className="mt-2 text-[11.5px] leading-5" style={{ color: WARN }}>
            The contract day counter could not be read, so a cutoff cannot be built.
            Nothing here will guess one.
          </p>
        )}
      </section>

      {/* 3 — handed over rather than faked */}
      <section className="mt-4 border-t border-line pt-4">
        <p className="text-[12px] font-medium text-ink">3. Delete the account</p>
        <p className="mt-0.5 text-[11.5px] leading-5 text-muted">
          A wallet refuses <code className="font-mono text-[11px]">DeployContract</code> and{" "}
          <code className="font-mono text-[11px]">DeleteAccount</code> from a web page, so
          this part cannot happen here. Run it yourself; it returns the whole remaining
          balance.
        </p>
        {state.isEmpty ? (
          <div className="mt-2 flex items-stretch gap-2">
            <code className="min-w-0 flex-1 rounded-lg border border-line bg-chip px-3 py-2 font-mono text-[11.5px] leading-5 text-ink [overflow-wrap:anywhere]">
              {cmd}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(cmd);
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }}
              className="min-h-11 shrink-0 rounded-lg border border-line bg-card px-3 text-[12px] font-medium text-muted transition-colors hover:bg-chip"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-[11.5px] leading-5" style={{ color: WARN }}>
            {state.blocker}
          </p>
        )}
      </section>
    </div>
  );
}

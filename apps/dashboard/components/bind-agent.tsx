"use client";

/**
 * Giving an agent key spending authority, after the vault already exists.
 *
 * THE SECRET NEVER TOUCHES THIS PAGE, and that constraint shapes everything
 * here. The page beside this one already explains why there is no "generate
 * an agent" button: creating one needs a keypair whose SECRET has to reach
 * whatever runs the agent, and a browser can only put that on a screen or
 * hand it to a server. So the key is generated on the user's own machine,
 * and this takes the PUBLIC half only.
 *
 * What this closes is a real gap. A vault created by following a link
 * carries no `agent_pk`, so no key is bound — the MCP can read it and plan
 * changes and never spend. Until now the only route back was the CLI.
 *
 * `add_role`, NOT `bind_virtual_agent`, and the difference is the feature.
 * Binding alone grants authority and leaves the key unable to transact: it
 * still needs installing as a NEP-611 gas key ON the vault, and that AddKey
 * needs the VAULT as signer, which a browser cannot provide. The contract
 * says it plainly in its own comment — "THE KEY IS ADDED TO THIS ACCOUNT,
 * BY THIS ACCOUNT. That is the only way an AddKey can reach the vault from a
 * browser signature." One owner signature does the node, the binding, the
 * key install and the funding.
 *
 * The cost is that it creates a NEW node under root rather than attaching to
 * an existing one. That is the honest trade, because the alternative is not
 * "attach to an existing node" — it is "cannot be done from a browser".
 */

import { useState } from "react";
import { WARN } from "@/lib/colors";

/**
 * The same validator the signing page uses, and for the same reason: this
 * value is rendered to a user as the thing they are authorising, so
 * `ed25519:` followed by arbitrary text must never look like a plausible
 * key. Anchored at BOTH ends — without `$`, a valid prefix followed by
 * anything passes, which is how an injected payload rides along behind a
 * real key.
 */
const AGENT_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * MIN_AGENT_GAS_FUNDING, mirrored from the contract (6e22 yocto).
 *
 * NEAR reserves `prepaid_gas * 1e9` up front, so a key funded to its
 * expected BURN (~0.0007) cannot make a single call. The planner refuses
 * below this and so does the contract; defaulting to the floor here means
 * the common case needs no decision, and the field stays editable for
 * anyone who wants to fund more.
 */
const MIN_FUNDING_NEAR = 0.06;

export function BindAgent({
  onPlan,
}: {
  onPlan: (
    body: Record<string, unknown>,
    label: string,
    from: string,
    to: string,
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [daily, setDaily] = useState("");
  const [perTx, setPerTx] = useState("");
  const [fundingNear, setFundingNear] = useState(String(MIN_FUNDING_NEAR));

  const key = publicKey.trim();
  const keyOk = AGENT_KEY.test(key);
  const fundingNum = Number(fundingNear);
  const fundingOk = Number.isFinite(fundingNum) && fundingNum >= MIN_FUNDING_NEAR;
  const ready = label.trim().length > 0 && keyOk && fundingOk;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-4 min-h-11 rounded-lg border border-line bg-card px-4 text-[13px] font-medium text-ink transition-colors hover:bg-chip"
      >
        Bind an agent key
      </button>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-card p-5">
      <p className="text-[13px] font-semibold text-ink">Bind an agent key</p>
      <p className="mt-1 text-[12px] leading-5 text-muted">
        Paste the <strong className="font-medium">public</strong> key your agent printed.
        Its secret stays on the machine that generated it and must never be pasted
        anywhere, including here. One signature creates the budget node, authorises the
        key, installs it as a gas key on the vault and funds it.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-muted">
            Name
          </span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="research"
            className="min-h-11 w-full rounded-lg border border-line bg-card px-3 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-muted">
            Agent public key
          </span>
          <input
            value={publicKey}
            onChange={(e) => setPublicKey(e.target.value)}
            placeholder="ed25519:..."
            spellCheck={false}
            className="min-h-11 w-full rounded-lg border bg-card px-3 font-mono text-[12px] text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
            style={{ borderColor: key && !keyOk ? WARN : undefined }}
          />
          {key && !keyOk ? (
            <span className="mt-1 block text-[11.5px] leading-5" style={{ color: WARN }}>
              That is not an ed25519 public key. It should start{" "}
              <code className="font-mono">ed25519:</code> and be 43 or 44 base58
              characters — no 0, O, I or l.
            </span>
          ) : null}
        </label>

        <div className="flex flex-wrap gap-3">
          <label className="min-w-[8rem] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-muted">
              Daily cap
            </span>
            <input
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              inputMode="decimal"
              placeholder="25"
              aria-label="Daily cap, in USDC"
              className="min-h-11 w-full rounded-lg border border-line bg-card px-3 text-[13px] tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
            />
          </label>
          <label className="min-w-[8rem] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-muted">
              Per payment
            </span>
            <input
              value={perTx}
              onChange={(e) => setPerTx(e.target.value)}
              inputMode="decimal"
              placeholder="5"
              aria-label="Per payment cap, in USDC"
              className="min-h-11 w-full rounded-lg border border-line bg-card px-3 text-[13px] tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
            />
          </label>
          <label className="min-w-[8rem] flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-muted">
              Gas funding
            </span>
            <input
              value={fundingNear}
              onChange={(e) => setFundingNear(e.target.value)}
              inputMode="decimal"
              aria-label="Gas key funding, in NEAR"
              className="min-h-11 w-full rounded-lg border bg-card px-3 text-[13px] tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
              style={{ borderColor: fundingNear && !fundingOk ? WARN : undefined }}
            />
          </label>
        </div>

        <p className="text-[11.5px] leading-5 text-muted">
          The gas funding is NEAR, not USDC, and it is recoverable rather than a fee.
          {fundingNear && !fundingOk ? (
            <span style={{ color: WARN }}>
              {" "}
              Below {MIN_FUNDING_NEAR} the key is installed and cannot complete a single
              call: NEAR reserves the prepaid gas up front, so the contract refuses it.
            </span>
          ) : null}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() =>
            void onPlan(
              {
                action: "role",
                label: label.trim(),
                dailyCap: daily.trim() || "0",
                perTxCap: perTx.trim() || "0",
                publicKey: key,
                /**
                 * NEAR -> yocto with string surgery, not `* 1e24`.
                 * 0.06 * 1e24 is 5.999999999999999e+22 in binary floating
                 * point, and `BigInt` of that throws — so the obvious
                 * version fails on the DEFAULT value.
                 */
                fundingYocto: nearToYocto(fundingNear),
              },
              `Bind ${label.trim()} to ${key.slice(0, 20)}...`,
              "no agent",
              `${label.trim()} can spend`,
            )
          }
          className="min-h-11 rounded-lg bg-ink px-4 text-[13px] font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          Prepare the transaction
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 rounded-lg border border-line bg-card px-4 text-[13px] font-medium text-muted transition-colors hover:bg-chip"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A NEAR decimal string to yoctoNEAR, exactly.
 *
 * NOT `BigInt(Number(n) * 1e24)`, AND THE REASON IS WORSE THAN IT LOOKS.
 *
 * The first version of this comment said that route throws, because
 * `0.06 * 1e24` is not an integer. That was wrong twice over: it IS an
 * integer (every double above 2^52 is), it does not throw, and for 0.06 it
 * happens to land on exactly the right answer — so the obvious check passes
 * on the one value this component defaults to.
 *
 * Measured across realistic inputs, it is wrong for 8 of 10, SILENTLY:
 *
 *   1      NEAR -> 999999999999999983222784   (16,777,216 yocto short)
 *   3.348  NEAR -> 3347999999999999924502528  (the create page's own figure)
 *   0.1    NEAR -> 100000000000000008388608
 *
 * A quiet wrong number attached to a transaction is the exact failure a
 * wallet confirmation cannot catch, because the wallet shows what it was
 * given. String surgery has no such cliff.
 */
export function nearToYocto(near: string): string {
  const [whole = "0", frac = ""] = near.trim().split(".");
  const padded = (frac + "0".repeat(24)).slice(0, 24);
  // `BigInt(10) ** BigInt(24)`, not `10n ** 24n`: this app targets ES2017
  // where a BigInt literal is a compile error, and vitest never sees it
  // because oxc strips types without checking them.
  return (BigInt(whole || "0") * BigInt(10) ** BigInt(24) + BigInt(padded || "0")).toString();
}

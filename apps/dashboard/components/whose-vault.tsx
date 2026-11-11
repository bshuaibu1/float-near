"use client";

/**
 * "Whose vault?" — the whole of signing in to a dashboard that signs nothing.
 *
 * Every read here is a keyless view call and every owner action leaves as a
 * `signLink` approved in the user's own wallet. So this needs IDENTITY, not
 * authentication: an account id, which grants no authority because there is no
 * authority here to grant. No wallet library, no session token, no new trust
 * surface, and it works identically on mainnet and testnet because the proxy
 * routes by the account's own suffix.
 *
 * WHY IT ASKS INSTEAD OF DEFAULTING. The dashboard used to fall through to
 * whichever vault the adapter was configured with, so a visitor landed on the
 * OPERATOR'S vault believing it was theirs — showing one user another user's
 * money. Asking is better than guessing wrong.
 *
 * NO VAULT IS AN OFFER, NOT AN ERROR. It is the commonest state a first-time
 * visitor is in. The adapter already returns the id their vault WOULD have, so
 * the dead end becomes onboarding: here is where yours would live, here is how
 * to make it.
 */

import { useState, type FormEvent } from "react";
import { useWallet } from "./wallet-provider";

const CARD = "#ffffff";
const LINE = "#e6e6e3";
const INK = "#1a1a18";
const MUTED = "#6b6b66";

/** Where a user with no vault goes. Carries no owner — the page derives the
 *  address from whichever wallet they connect, which is the honest flow. */
const CREATE_URL = "https://usefloat.xyz/";

/**
 * A plausible NEAR account id, checked before a round trip.
 *
 * Deliberately loose: it rejects an empty box and obvious nonsense, and lets
 * the CHAIN decide the rest. A client-side rule strict enough to be
 * authoritative would eventually reject something the protocol allows, and
 * then nobody could reach their own vault.
 */
const LOOKS_LIKE_ACCOUNT = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function WhoseVault() {
  const { login, connecting, error, noVault } = useWallet();
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = value.trim().toLowerCase();
    if (!LOOKS_LIKE_ACCOUNT.test(id)) {
      setLocalError("That does not look like a NEAR account id. Try alice.near or alice.testnet.");
      return;
    }
    setLocalError(null);
    // PUT IT IN THE URL. A vault view becomes linkable — pasteable into chat,
    // into a demo script, into a message to someone you want to show.
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.set("owner", id);
      window.history.replaceState({}, "", u.toString());
    }
    await login(id);
  };

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-16">
      <div className="rounded-xl p-6" style={{ background: CARD, border: `1px solid ${LINE}` }}>
        <h1 className="text-lg font-semibold" style={{ color: INK }}>
          Whose vault?
        </h1>
        <p className="mt-1 text-sm" style={{ color: MUTED }}>
          Enter a NEAR account and we will find its vault. Everything here is read-only, so
          this asks for an account id and never a key or a seed phrase.
        </p>

        <form onSubmit={submit} className="mt-5 flex gap-2">
          <input
            value={value}
            onChange={(ev) => setValue(ev.target.value)}
            placeholder="alice.near"
            autoFocus
            spellCheck={false}
            autoCapitalize="none"
            className="min-w-0 flex-1 rounded-lg px-3 py-2 font-mono text-sm outline-none"
            style={{ border: `1px solid ${LINE}`, color: INK }}
            aria-label="NEAR account id"
          />
          <button
            type="submit"
            disabled={connecting}
            className="shrink-0 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
            style={{ background: INK }}
          >
            {connecting ? "Looking…" : "View vault"}
          </button>
        </form>

        {localError ? (
          <p className="mt-3 text-sm" style={{ color: "#b4442e" }}>
            {localError}
          </p>
        ) : null}

        {/* THE OFFER. `noVault` means the lookup worked and the answer was
            "not yet" — which is not a failure and must not look like one. */}
        {noVault ? (
          <div
            className="mt-5 rounded-lg p-4 text-sm"
            style={{ background: "#faf9f6", border: `1px solid ${LINE}`, color: INK }}
          >
            <p className="font-medium">{noVault.owner} does not have a vault yet.</p>
            {noVault.vault ? (
              <p className="mt-1" style={{ color: MUTED }}>
                It would live at <span className="font-mono">{noVault.vault}</span> — that address
                is derived from the account, so it is reserved for them and nobody else can take
                it by creating first.
              </p>
            ) : null}
            <a
              href={CREATE_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block rounded-lg px-3 py-2 text-sm font-medium text-white"
              style={{ background: INK }}
            >
              Create a vault →
            </a>
            <p className="mt-2 text-xs" style={{ color: MUTED }}>
              Opens the signing page. You approve it in your own wallet; nothing is signed here.
            </p>
          </div>
        ) : null}

        {/* A genuine failure — the adapter unreachable, a malformed reply. Kept
            visually distinct from `noVault`, because "we could not look" and
            "there is nothing there" are different facts and conflating them is
            how someone concludes their vault is gone. */}
        {error && !noVault ? (
          <p className="mt-4 text-sm" style={{ color: "#b4442e" }}>
            {error}
          </p>
        ) : null}
      </div>

      <p className="mt-4 text-center text-xs" style={{ color: MUTED }}>
        Works for mainnet and testnet — the network is read from the account id.
      </p>
    </div>
  );
}

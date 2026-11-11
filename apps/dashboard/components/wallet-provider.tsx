"use client";

import { floatFetch } from "@/lib/float-fetch";

/**
 * NEAR replacement for Float's Phantom/Solana wallet provider.
 *
 * DROP-IN: the exported names and the `WalletContextValue` shape are identical
 * to the Solana original, so all ten consumers — top-nav, app-shell and every
 * page — are untouched. This is a data-layer swap, not a redesign.
 *
 * Why there is no wallet popup here: on NEAR this dashboard is read-only plus
 * the existing pay flow. Owner actions are emitted as UNSIGNED payloads for
 * approval in the owner's own wallet, so the dashboard never needs signing
 * authority. `authenticated` therefore means "a reachable vault is configured"
 * rather than "a key is connected" — and if the vault or adapter is
 * unreachable you get the sign-in screen with the real error, which is more
 * useful than an empty dashboard.
 *
 * The Phantom original is preserved in the Float repo and in this repo's git
 * history.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  clearFloatOwnerSession,
  getFloatOwnerSession,
  saveFloatOwnerSession,
} from "@/lib/float-session";

export type WalletLoginMethod = "google" | "apple" | "wallet";

type WalletContextValue = {
  walletAddress: string | null;
  ready: boolean;
  authenticated: boolean;
  connecting: boolean;
  error: string | null;
  /** The account that has no vault yet, with the id its vault WOULD have. */
  noVault: { owner: string; vault: string | null } | null;
  login: (methodOrOwner?: WalletLoginMethod | string) => Promise<void>;
  disconnect: () => void;
  clearError: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

// `/api/float`, NOT the adapter directly. The browser talks only to this
// origin; `app/api/float/[...path]/route.ts` forwards to the adapter over
// loopback and adds the bearer token server-side, so the adapter never needs
// to be reachable from the internet and the token never enters a bundle.
//
// This file was missed when the ten page-level copies were repointed, because
// the sweep globbed `app/**` and `lib/**` and `components/` is neither. It is
// the one that renders "Could not reach the vault", so it was also the only
// one the user ever saw fail.
const API_BASE_URL =
  process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "/api/float";

interface SettingsResponse {
  ownerWallet: string;
  notificationEmail: string | null;
  error?: string;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the account is real but has no vault yet — an offer, not a failure. */
  const [noVault, setNoVault] = useState<{ owner: string; vault: string | null } | null>(null);

  /**
   * Connect AS SOMEONE. The account id is an identity, not a credential.
   *
   * This dashboard signs nothing: every read is a keyless view call, and every
   * owner action leaves as a `signLink` the user approves in their own wallet.
   * So multi-tenancy needs to know WHO is asking, and nothing more — no wallet
   * library, no session token, no new trust surface. Naming an account grants
   * no authority, because there is no authority here to grant.
   *
   * Passing `owner` makes the proxy resolve that account's vault through the
   * factory (`/v1/resolve`), instead of serving whichever vault the adapter
   * happens to be configured with. Without it, every visitor saw the operator's
   * demo vault and had no way to reach their own — which is exactly the
   * confusion that started this work.
   */
  const connect = useCallback(async (asOwner?: string) => {
    setConnecting(true);
    setError(null);
    setNoVault(null);
    try {
      const q = asOwner ? `?owner=${encodeURIComponent(asOwner)}` : "";
      const res = await floatFetch(`/v1/settings${q}`, { cache: "no-store" });
      // The NO_VAULT shape is the adapter's, not SettingsResponse's: it carries
      // the owner it was asked about and the vault id that owner WOULD have.
      const body = (await res.json()) as SettingsResponse & {
        error?: string;
        owner?: string;
        vault?: string;
        exists?: boolean;
      };

      /**
       * NO VAULT IS NOT AN ERROR. It is the most common state a first-time
       * visitor is in, and treating it as a failure turns the one moment
       * someone is motivated into a dead end. The adapter already tells us the
       * id their vault WOULD have, so the honest answer is "you do not have one
       * yet, here is where it would live" — and an offer to create it.
       */
      if (res.status === 404 && body?.error === "NO_VAULT") {
        setOwner(null);
        setNoVault({ owner: body.owner ?? asOwner ?? "", vault: body.vault ?? null });
        return;
      }

      if (!res.ok) throw new Error(body?.error ?? `adapter returned ${res.status}`);
      if (!body.ownerWallet) throw new Error("the vault reported no owner");

      setOwner(body.ownerWallet);
      // Written so the pages' existing getOwnerQuery()/auth-header helpers keep
      // working unchanged.
      saveFloatOwnerSession({
        ownerControlKey: `near:${body.ownerWallet}`,
        ownerWallet: body.ownerWallet,
        ownerDisplayName: body.ownerWallet,
        savedAt: new Date().toISOString(),
      });
    } catch (e) {
      setOwner(null);
      setError(
        `Could not reach the vault via ${API_BASE_URL}: ${(e as Error).message}. ` +
          `Start the adapter (npm -w @floatonnear/float-adapter start) and check ` +
          `NEAR_VAULT_CONTRACT.`,
      );
    } finally {
      setConnecting(false);
      setReady(true);
    }
  }, []);

  /**
   * WHO ARE WE LOOKING AT? In priority order, and the order is the point.
   *
   *   1. `?owner=` in the URL     — makes a vault LINKABLE. Paste it in chat,
   *                                 put it in a demo script, send it to a judge.
   *   2. the saved session        — so a return visit does not re-ask.
   *   3. nothing                  — show the prompt.
   *
   * (3) IS DELIBERATE AND IS A BEHAVIOUR CHANGE. It used to fall through to
   * whatever vault the adapter was configured with, so a stranger landed on the
   * OPERATOR'S vault and reasonably believed it was theirs. On a public
   * dashboard that is not a convenience, it is showing one user another user's
   * money. Asking is better than guessing wrong.
   */
  useEffect(() => {
    const fromUrl =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("owner")?.trim()
        : null;
    const saved = fromUrl ? null : getFloatOwnerSession()?.ownerWallet;
    const who = fromUrl || saved;
    if (who) {
      void connect(who);
    } else {
      setReady(true);
    }
  }, [connect]);

  /**
   * "Log in" is naming an account. There is nothing to authenticate.
   *
   * The legacy `WalletLoginMethod` argument is still accepted so the existing
   * menu keeps compiling, but a STRING is the useful call now: the account id
   * whose vault to show.
   */
  const login = useCallback(
    async (methodOrOwner?: WalletLoginMethod | string) => {
      const asOwner = typeof methodOrOwner === "string" ? methodOrOwner.trim() : undefined;
      await connect(asOwner || undefined);
    },
    [connect],
  );

  const disconnect = useCallback(() => {
    setOwner(null);
    setError(null);
    setNoVault(null);
    clearFloatOwnerSession();
    // Drop `?owner=` too, or a reload silently signs back in as the account
    // the user just chose to leave.
    if (typeof window !== "undefined" && window.location.search.includes("owner=")) {
      const u = new URL(window.location.href);
      u.searchParams.delete("owner");
      window.history.replaceState({}, "", u.toString());
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<WalletContextValue>(
    () => ({
      walletAddress: owner,
      ready,
      authenticated: Boolean(owner),
      connecting,
      error,
      noVault,
      login,
      disconnect,
      clearError,
    }),
    [owner, ready, connecting, error, noVault, login, disconnect, clearError],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error("useWallet must be used within a WalletProvider.");
  }
  return context;
}

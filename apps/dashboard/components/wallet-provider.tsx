"use client";

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

import { clearFloatOwnerSession, saveFloatOwnerSession } from "@/lib/float-session";

export type WalletLoginMethod = "google" | "apple" | "wallet";

type WalletContextValue = {
  walletAddress: string | null;
  ready: boolean;
  authenticated: boolean;
  connecting: boolean;
  error: string | null;
  login: (method?: WalletLoginMethod) => Promise<void>;
  disconnect: () => void;
  clearError: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

const API_BASE_URL =
  process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";

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

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      // The vault's own `owner` field is the identity here — asking the chain
      // who owns it beats trusting a value typed into the browser.
      const res = await fetch(`${API_BASE_URL}/v1/settings`, { cache: "no-store" });
      const body = (await res.json()) as SettingsResponse;
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

  useEffect(() => {
    void connect();
  }, [connect]);

  const login = useCallback(
    async (_method?: WalletLoginMethod) => {
      // No popup to open: nothing this dashboard does requires a signature.
      // Retrying the vault read is the whole of "logging in".
      await connect();
    },
    [connect],
  );

  const disconnect = useCallback(() => {
    setOwner(null);
    setError(null);
    clearFloatOwnerSession();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<WalletContextValue>(
    () => ({
      walletAddress: owner,
      ready,
      authenticated: Boolean(owner),
      connecting,
      error,
      login,
      disconnect,
      clearError,
    }),
    [owner, ready, connecting, error, login, disconnect, clearError],
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

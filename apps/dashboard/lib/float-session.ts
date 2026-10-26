import { useEffect, useState } from "react";

export const FLOAT_OWNER_SESSION_KEY = "float.owner.session.v1";

export type FloatOwnerSession = {
  ownerControlKey: string;
  ownerWallet: string | null;
  ownerEmail?: string | null;
  ownerDisplayName?: string | null;
  agentId?: string;
  agentWalletAddress?: string;
  treasuryWalletAddress?: string;
  savedAt: string;
};

export function getFloatOwnerSession(): FloatOwnerSession | null {
  if (typeof window === "undefined") return null;

  const raw = window.localStorage.getItem(FLOAT_OWNER_SESSION_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<FloatOwnerSession>;
    if (!parsed.ownerControlKey || typeof parsed.ownerControlKey !== "string") {
      return null;
    }

    return {
      ownerControlKey: parsed.ownerControlKey,
      ownerWallet: parsed.ownerWallet ?? null,
      ownerEmail: parsed.ownerEmail ?? null,
      ownerDisplayName: parsed.ownerDisplayName ?? null,
      agentId: parsed.agentId,
      agentWalletAddress: parsed.agentWalletAddress,
      treasuryWalletAddress: parsed.treasuryWalletAddress,
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveFloatOwnerSession(session: FloatOwnerSession): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(FLOAT_OWNER_SESSION_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event("float-owner-session-updated"));
}

export function clearFloatOwnerSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(FLOAT_OWNER_SESSION_KEY);
  window.dispatchEvent(new Event("float-owner-session-updated"));
}

export function getOwnerAuthHeaders(): HeadersInit {
  const session = getFloatOwnerSession();
  return session?.ownerControlKey
    ? { Authorization: `Bearer ${session.ownerControlKey}` }
    : {};
}

export function getOwnerQuery(walletAddress?: string | null): string {
  const session = getFloatOwnerSession();
  const params = new URLSearchParams();

  if (session?.ownerWallet) {
    params.set("owner", session.ownerWallet);
  } else if (session?.ownerEmail) {
    params.set("email", session.ownerEmail);
  } else if (walletAddress) {
    params.set("owner", walletAddress);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getOwnerWalletForBody(walletAddress?: string | null): string | undefined {
  return getFloatOwnerSession()?.ownerWallet ?? walletAddress ?? undefined;
}

export function hasOwnerSession(): boolean {
  return Boolean(getFloatOwnerSession()?.ownerControlKey);
}

export function useOwnerSessionAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const update = () => setAvailable(hasOwnerSession());
    update();
    window.addEventListener("float-owner-session-updated", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("float-owner-session-updated", update);
      window.removeEventListener("storage", update);
    };
  }, []);

  return available;
}

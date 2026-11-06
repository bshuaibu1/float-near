/**
 * Getting a cross-chain quote, and signing the binding the vault verifies.
 *
 * A cross-chain payment is an ordinary NEP-141 transfer on NEAR to a ONE-TIME
 * deposit address; a NEAR Intents solver delivers the destination asset and
 * prices the far chain's gas into the quote. No MPC signature, no derived
 * address, no ETH to keep topped up.
 *
 * The catch is that the deposit address is unpredictable and single-use, so it
 * can never be on the vault's payee allowlist. The vault checks the allowlist
 * against the final payee and then sends the money somewhere it cannot connect
 * back to that payee. If an agent could choose that address, the allowlist
 * would be decorative — quote a swap paying yourself and the vault funds it
 * with every other check passing.
 *
 * So a key the vault owner registered signs the binding between payee and
 * deposit address, and the contract refuses any Intents payment without it.
 * This module is the holder of that key. It is a TRUSTED PRODUCER: whoever
 * runs it can redirect any Intents payment the budget allows, which is why it
 * belongs on the operator's machine and not on the ones agents run on.
 */

import { ed25519 } from "@noble/curves/ed25519";

export const ONE_CLICK_URL = process.env.ONE_CLICK_URL ?? "https://1click.chaindefuser.com";

/** Mainnet asset ids, from GET /v0/tokens. Intents has no testnet. */
export const ASSETS = {
  usdcNear: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  usdcBase: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
} as const;

// ---------------------------------------------------------------- borsh

/**
 * Borsh, hand-rolled, because exactly one struct crosses this boundary and a
 * dependency would be more surface than the twenty lines below.
 *
 * It must match `QuoteBinding` in contracts/vault/src/types.rs BYTE FOR BYTE.
 * If it does not, no signature ever verifies, and the failure is silent and
 * total — indistinguishable from a wrong key. The same vector is asserted in
 * `quote_binding_borsh_vector` on the Rust side and in quote.test.ts here, so
 * a field reorder breaks a test rather than the rail.
 */
const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
/** borsh u128: 16 bytes little-endian. */
const u128le = (n: bigint): Uint8Array => {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, n & 0xffffffffffffffffn, true);
  dv.setBigUint64(8, n >> 64n, true);
  return b;
};
/** borsh string: u32 length prefix, then utf8. The prefix is what makes the
 *  encoding unambiguous — a plain concatenation would let ("alic","ebob") and
 *  ("alice","bob") produce identical bytes and sign each other's quotes. */
const str = (s: string): Uint8Array => {
  const utf8 = new TextEncoder().encode(s);
  return concat(u32le(utf8.length), utf8);
};
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface QuoteBinding {
  vault: string;
  requestId: string;
  token: string;
  amount: bigint;
  payee: string;
  depositAddress: string;
  deadlineNs: bigint;
}

/** Field order is the struct's declaration order; borsh has no field names. */
export function encodeBinding(b: QuoteBinding): Uint8Array {
  return concat(
    str(b.vault),
    str(b.requestId),
    str(b.token),
    u128le(b.amount),
    str(b.payee),
    str(b.depositAddress),
    u64le(b.deadlineNs),
  );
}

export function signBinding(b: QuoteBinding, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 32) {
    throw new Error(`quote signer key must be 32 bytes, got ${secretKey.length}`);
  }
  return ed25519.sign(encodeBinding(b), secretKey);
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

export const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

// ---------------------------------------------------------------- 1Click

export interface QuoteResult {
  /** Where the vault must send the NEAR-side tokens. */
  depositAddress: string;
  /** What leaves the vault, in base units. */
  amountIn: bigint;
  /** What the payee receives on the destination chain, in base units. */
  amountOut: bigint;
  deadlineNs: bigint;
  timeEstimateSec: number;
}

/**
 * Ask 1Click what it costs to deliver `amountOut` to `payee` on the
 * destination chain.
 *
 * EXACT_OUTPUT, deliberately. A payment is a promise about what the PAYEE
 * receives; EXACT_INPUT would deliver "about a dollar" and leave the agent
 * unable to settle an invoice. The vault is then charged `amountIn`, which is
 * what actually leaves it — so the budget governs real outflow, not the
 * nominal figure.
 */
export async function getQuote(opts: {
  originAsset?: string;
  destinationAsset?: string;
  amountOut: bigint;
  payee: string;
  refundTo: string;
  deadline: Date;
  slippageBps?: number;
  jwt?: string;
  dry?: boolean;
}): Promise<QuoteResult> {
  const body = {
    dry: opts.dry ?? false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: opts.slippageBps ?? 100,
    originAsset: opts.originAsset ?? ASSETS.usdcNear,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: opts.destinationAsset ?? ASSETS.usdcBase,
    amount: opts.amountOut.toString(),
    refundTo: opts.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: opts.payee,
    recipientType: "DESTINATION_CHAIN",
    deadline: opts.deadline.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  const r = await fetch(`${ONE_CLICK_URL}/v0/quote`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`1Click HTTP ${r.status}: ${text.slice(0, 220)}`);

  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`1Click returned non-JSON: ${text.slice(0, 160)}`);
  }
  const q = j.quote;
  if (!q) throw new Error(`1Click returned no quote: ${text.slice(0, 220)}`);

  // A dry quote has no deposit address — it is a price, not an instruction.
  // Treating one as live would send real money to `undefined`.
  const depositAddress = j.quote?.depositAddress ?? j.depositAddress;
  if (!opts.dry && !depositAddress) {
    throw new Error("1Click returned no depositAddress for a live quote");
  }

  return {
    depositAddress: depositAddress ?? "",
    amountIn: BigInt(q.amountIn),
    amountOut: BigInt(q.amountOut),
    deadlineNs: BigInt(opts.deadline.getTime()) * 1_000_000n,
    timeEstimateSec: Number(q.timeEstimate ?? 0),
  };
}

/** The `route` argument for a cross-chain payment. */
export function intentsRoute(
  depositAddress: string,
  deadlineNs: bigint,
  signature: Uint8Array,
): { intents: { deposit_address: string; quote_deadline_ns: string; signature: string } } {
  return {
    intents: {
      deposit_address: depositAddress,
      quote_deadline_ns: deadlineNs.toString(),
      signature: toBase64(signature),
    },
  };
}

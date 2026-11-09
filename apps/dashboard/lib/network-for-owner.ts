/**
 * Which NEAR network does this wallet belong to?
 *
 * WHY THE DASHBOARD CAN ANSWER THIS WITHOUT BEING TOLD. Every page already
 * sends `?owner=<wallet>` and nothing else, and a NEAR account id carries its
 * network in its suffix: `alice.near` is mainnet, `alice.testnet` is testnet.
 * So the wallet a visitor connects decides which chain they are looking at,
 * which is also the only answer that can be right — a mainnet wallet has no
 * testnet vault and vice versa.
 *
 * That means no page changes, the same way answering `?owner=` server-side
 * meant no page changes.
 *
 * NULL IS NOT "DEFAULT TO TESTNET". An id this cannot classify — an implicit
 * 64-hex account, or something malformed — must not be silently routed to a
 * chain it does not live on. Today has already produced three bugs of exactly
 * that shape: a failure or an unknown turned into a confident wrong answer.
 * An implicit account cannot have a vault under any factory anyway, so there
 * is nothing to route.
 */
export type NearNetwork = "mainnet" | "testnet";

/** A NEAR implicit account: 64 lowercase hex characters, no suffix. */
const IMPLICIT = /^[0-9a-f]{64}$/;

export function networkForOwner(owner: string | null | undefined): NearNetwork | null {
  const id = owner?.trim().toLowerCase();
  if (!id) return null;

  // CHECKED FIRST. An implicit id has no dot and cannot have a vault, so
  // classifying it by suffix would be meaningless rather than merely wrong.
  if (IMPLICIT.test(id)) return null;

  // ORDER MATTERS ONLY IN THE SENSE THAT THESE ARE DISJOINT. `.testnet` does
  // not end with `.near`, so neither can shadow the other — but writing the
  // narrower suffix first keeps that obvious to the next reader.
  if (id.endsWith(".testnet")) return "testnet";
  if (id.endsWith(".near")) return "mainnet";

  // A bare `near`/`testnet` (the registrar accounts themselves), a `.sweat`
  // or anything else: not something this dashboard can place.
  return null;
}

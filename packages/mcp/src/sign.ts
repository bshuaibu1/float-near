/**
 * The ONLY place in this server that touches a key.
 *
 * It signs exactly one method — `request_payment` — with the restricted key
 * of a VIRTUAL AGENT, installed as a NEP-611 gas key on the vault and bound
 * with `bind_virtual_agent`. That key is cryptographically incapable of
 * doing anything else: its `receiver_id` is the vault, its `method_names` is
 * `["request_payment"]`, and a NEAR function-call key cannot attach a deposit
 * at all. So the worst a compromised copy of this server can do is make
 * payments the vault's on-chain policy already permits.
 *
 * Owner methods are deliberately NOT here. They are emitted as unsigned
 * payloads (see payloads.ts) for the human to approve in their own wallet,
 * which keeps this server out of the trust path for anything that changes
 * policy — the property that distinguishes the design from a custodial agent
 * wallet.
 */

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

/** Must match AGENT_ALLOWED_METHOD in the contract; pinned by constants.test.ts. */
const ALLOWED_METHOD = "request_payment";

/**
 * Fee and ordering fields for a Base-routed payment. Decimal strings.
 *
 * There is no `nonce`. The CONTRACT allocates it, because it is part of the
 * signed payload and a caller cannot choose one safely: two payments in the
 * same block read the same chain state, sign for the same nonce, and one is
 * rejected AFTER its NEAR reservation has been consumed. The contract is the
 * only place that sees every Base signature in a serial order.
 */
/**
 * The contract's `route` argument.
 *
 * Note what is NOT here: no payload, no destination, no amount. For a
 * cross-chain payment the contract transfers to the quote's deposit address
 * and checks the allowlist against the final payee; nothing a caller passes
 * can redirect where value ends up. If this type ever grows a `payload`
 * field, that property is gone.
 *
 * A cross-chain payment is an ordinary NEP-141 transfer to a solver's
 * deposit address — no derived address, no ETH to fund, no nonce.
 */
export type RouteArg =
  | "near_direct"
  | { intents: { deposit_address: string; quote_deadline_ns: string; signature: string } };

export function buildRoute(rail: "near"): RouteArg;
export function buildRoute(rail: "intents", intents: IntentsRouteFields): RouteArg;
export function buildRoute(rail: "near" | "intents", intents?: IntentsRouteFields): RouteArg {
  if (rail === "near") return "near_direct";
  if (!intents) {
    throw new Error("rail 'intents' requires depositAddress, quoteDeadlineNs and signature");
  }
  if (!/^[0-9]+$/.test(intents.quoteDeadlineNs)) {
    // U64 crosses the ABI as a decimal string; a JSON number loses precision
    // above 2^53 and a nanosecond deadline is far past that.
    throw new Error(`quoteDeadlineNs must be a decimal string, got ${intents.quoteDeadlineNs}`);
  }
  if (!intents.depositAddress) {
    // An empty deposit address is what a DRY quote returns. Sending one would
    // transfer real funds to "", which the token contract rejects only after
    // the vault has already reserved the budget.
    throw new Error("depositAddress is empty — a dry quote cannot be paid");
  }
  return {
    intents: {
      deposit_address: intents.depositAddress,
      quote_deadline_ns: intents.quoteDeadlineNs,
      signature: intents.signature,
    },
  };
}

/** Fields of a cross-chain route, all produced by the quote signer. */
export interface IntentsRouteFields {
  depositAddress: string;
  quoteDeadlineNs: string;
  /** base64 ed25519 over borsh(QuoteBinding). See quote.ts. */
  signature: string;
}

export interface PayArgs {
  rpcUrl: string;
  vault: string;
  agentId: string;
  agentKey: string;
  requestId: string;
  token: string;
  /** Base units. Already scaled by amounts.toBaseUnits. */
  amount: bigint;
  recipient: string;
  memo: string;
  gasTgas: number;
  /** Omitted means the NEAR rail, matching the contract's `Option<Route>`. */
  route?: RouteArg;
}

export async function sendRequestPayment(a: PayArgs): Promise<unknown> {
  const provider = new JsonRpcProvider({ url: a.rpcUrl });
  const signer = new KeyPairSigner(KeyPair.fromString(a.agentKey as never));
  const account = new Account(a.agentId, provider, signer);

  return account.callFunction({
    contractId: a.vault,
    methodName: ALLOWED_METHOD,
    args: {
      request_id: a.requestId,
      token: a.token,
      // U128 crosses the ABI as a decimal string; a JSON number would lose
      // precision above 2^53.
      amount: a.amount.toString(),
      recipient: a.recipient,
      memo: a.memo,
      // Omitted entirely when undefined: the contract takes `Option<Route>`
      // and a missing field deserialises to None, which is the NEAR rail.
      ...(a.route === undefined ? {} : { route: a.route }),
    },
    gas: BigInt(a.gasTgas) * 10n ** 12n,
    // Hardcoded zero, and not a parameter. A function-call key that attaches
    // any deposit is rejected by the protocol with
    // InvalidAccessKeyError(DepositWithFunctionCall) — so a non-zero value
    // here would not be a security hole, it would simply make every payment
    // fail. Keeping it a constant means that cannot be introduced by a caller.
    deposit: 0n,
  });
}

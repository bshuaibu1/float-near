/**
 * The ONLY place in this server that touches a key.
 *
 * It signs exactly one method — `request_payment` — with the restricted key
 * issued by `create_agent_account`. That key is cryptographically incapable of
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

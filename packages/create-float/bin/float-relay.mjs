#!/usr/bin/env node
/**
 * Virtual-agent signing and relaying.
 *
 * Two halves of one flow:
 *   sign()  — the AGENT side. Holds only a keypair, no NEAR account. Produces
 *             a signature over VirtualAgentBinding.
 *   relay() — the OWNER side. Pays the gas and submits. Trusted for nothing:
 *             every field it could rewrite is inside the signature.
 *
 * THE BORSH ENCODING BELOW MUST MATCH `VirtualAgentBinding` IN types.rs BYTE
 * FOR BYTE. If it does not, every signature fails to verify, and the failure
 * mode is indistinguishable from a wrong key — which is exactly how a silent
 * mismatch survives. `npm run check-binding` cross-checks this against bytes
 * emitted by the Rust struct; run it after ANY field change on either side.
 *
 * Field order is load-bearing and must track the struct:
 *   vault, nonce, deadline_ns, request_id, token, amount, recipient, memo, route
 */
import { KeyPair } from "near-api-js";

/** borsh: u32 LE length prefix, then UTF-8. AccountId encodes as String. */
function bstring(s) {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

/** borsh: u64 LE. */
function bu64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b;
}

/** borsh: u128 LE. near_sdk's U128 serialises as the bare 16 bytes. */
function bu128(n) {
  const b = Buffer.alloc(16);
  let v = BigInt(n);
  for (let i = 0; i < 16; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

/**
 * borsh: enum variants are tagged by POSITION as a u8.
 *
 * `NearDirect` is index 0 and carries no fields. The Route comment in
 * types.rs pins this ordering — a future variant must be APPENDED, because
 * renumbering would silently reinterpret both stored requests and every
 * signature produced here.
 */
function broute(route) {
  if (!route || route === "NearDirect" || route.NearDirect !== undefined) {
    return Buffer.from([0]);
  }
  if (route.Intents) {
    const { deposit_address, quote_deadline_ns, signature } = route.Intents;
    const sig = Buffer.from(signature, "base64");
    const siglen = Buffer.alloc(4);
    siglen.writeUInt32LE(sig.length, 0);
    return Buffer.concat([
      Buffer.from([1]),
      bstring(deposit_address),
      bu64(quote_deadline_ns),
      siglen,
      sig,
    ]);
  }
  throw new Error(`unrecognised route: ${JSON.stringify(route)}`);
}

/** The exact bytes the contract reconstructs and verifies against. */
export function encodeBinding({
  vault,
  nonce,
  deadlineNs,
  requestId,
  token,
  amount,
  recipient,
  memo,
  route,
}) {
  return Buffer.concat([
    bstring(vault),
    bu64(nonce),
    bu64(deadlineNs),
    bstring(requestId),
    bstring(token),
    bu128(amount),
    bstring(recipient),
    bstring(memo),
    broute(route),
  ]);
}

/**
 * AGENT SIDE. `secretKey` never leaves the caller; nothing here touches the
 * network, so an agent can sign while entirely offline.
 */
export function sign(secretKey, binding) {
  const kp = KeyPair.fromString(secretKey);
  const msg = encodeBinding(binding);
  const { signature } = kp.sign(msg);
  return {
    public_key: kp.getPublicKey().toString(),
    signature: Buffer.from(signature).toString("base64"),
  };
}

/**
 * OWNER SIDE. Pre-validates before spending gas.
 *
 * The relayer pays for every submission, valid or not, so an unchecked relay
 * is a griefing target: anyone could feed it garbage and drain its balance on
 * reverts. These checks are a cost control, NOT a security boundary — the
 * contract re-checks all of them and is the only thing that decides.
 */
export async function relay({ provider, ownerAccount, vault, binding, signed }) {
  const onChainNode = await provider.callFunction({
    contractId: vault,
    method: "get_virtual_agent_node",
    args: { public_key: signed.public_key },
  });
  if (onChainNode === null || onChainNode === undefined) {
    throw new Error(`refusing to relay: ${signed.public_key} is not bound to a node`);
  }

  const expected = await provider.callFunction({
    contractId: vault,
    method: "get_virtual_agent_nonce",
    args: { public_key: signed.public_key },
  });
  if (BigInt(binding.nonce) < BigInt(expected)) {
    throw new Error(
      `refusing to relay: nonce ${binding.nonce} is stale, chain expects >= ${expected}. ` +
        `This payload has already been used or superseded.`,
    );
  }

  // A deadline already past cannot succeed, so do not pay to discover that.
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  if (BigInt(binding.deadlineNs) < nowNs) {
    throw new Error(
      `refusing to relay: deadline ${binding.deadlineNs} has passed (now ~${nowNs})`,
    );
  }

  return ownerAccount.callFunction({
    contractId: vault,
    methodName: "request_payment_signed",
    args: {
      request_id: binding.requestId,
      token: binding.token,
      amount: String(binding.amount),
      recipient: binding.recipient,
      memo: binding.memo,
      route: binding.route ?? null,
      public_key: signed.public_key,
      nonce: Number(binding.nonce),
      deadline_ns: String(binding.deadlineNs),
      signature: signed.signature,
    },
    gas: 100n * 10n ** 12n,
    deposit: 0n,
  });
}

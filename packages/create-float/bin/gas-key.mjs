/**
 * What a VIRTUAL AGENT's gas key costs, and why.
 *
 * A virtual agent is a NEP-611 gas key bound to a node on the vault. It is not
 * a NEAR account: there is no sub-account to create, no 0.05 of account
 * storage, and no 0.5 key allowance. The key carries its OWN balance and pays
 * its own gas, which is the whole point — validated on mainnet 2026-11-01,
 * where the gas key burned 0.000925 and the vault's balance moved by exactly
 * its storage growth and nothing else.
 *
 * Everything here is a measurement, not a guess.
 */

/**
 * What NEAR holds for one in-flight call.
 *
 * `prepaid_gas x 1e9`, where 1e9 is the MAX gas price — ten times the current
 * 1e8 — refunded a receipt later. This is the figure that decides whether an
 * agent can transact at all, and it is ~350x the real burn, so funding by
 * expected cost alone produces a key that fails every call with
 * NotEnoughBalance. Measured repeatedly: 60 TGas reserves 0.0609.
 */
export const gasReservation = (tgas) => BigInt(tgas) * 10n ** 12n * 10n ** 9n;

/**
 * The real cost of one `request_payment`, rounded up from measurement.
 *
 * Mainnet 0.000925 (node at depth 2, 64-char token id), testnet 0.000801.
 * 0.0012 leaves headroom over the worse of the two without inviting the reader
 * to treat it as exact.
 */
export const PAYMENT_BURN = 12n * 10n ** 20n;

/**
 * MIN_GAS_FOR_DISPATCH in the vault. A call arriving with less is refused
 * `INSUFFICIENT_GAS` before anything happens, so funding below this reservation
 * buys nothing.
 */
export const MIN_TGAS = 50;

/**
 * Fund a gas key for `payments` calls at `tgas` each.
 *
 * reservation + burn x payments. The reservation is charged ONCE however many
 * payments are funded, because it comes back after each call — so doubling the
 * payment budget does not double the funding.
 */
/**
 * Which credential can sign an AddKey ON the vault: "owner" | "vault" | "none".
 *
 * Adding a gas key is an action on the VAULT account, so it needs a
 * full-access key OF the vault. create-float finishes by adding the owner's
 * key to the vault and deleting the temporary setup key, so for a wizard-made
 * vault the owner's credential signs for it.
 *
 * That is not universal, which is why this is resolved rather than assumed.
 * Measured 2026-11-01: on mainnet `float.test015.near` carries the owner's key;
 * on testnet `approve.floatv4.testnet` does NOT — it was upgraded from an older
 * deployment and holds its own. Assuming the owner's key there would fail with
 * InvalidAccessKeyError, which reads like a contract bug rather than a missing
 * credential.
 */
export function signerChoice({ ownerPublicKey, vaultKeys = [], hasVaultCredential = false }) {
  if (ownerPublicKey && vaultKeys.includes(ownerPublicKey)) return "owner";
  if (hasVaultCredential) return "vault";
  return "none";
}

export function gasKeyFunding({ tgas = 60, payments = 50 } = {}) {
  if (tgas < MIN_TGAS) {
    throw new Error(`tgas must be at least ${MIN_TGAS} (the vault's MIN_GAS_FOR_DISPATCH)`);
  }
  return gasReservation(tgas) + PAYMENT_BURN * BigInt(payments);
}

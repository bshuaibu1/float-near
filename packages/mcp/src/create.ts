/**
 * Onboarding: what a user with NO vault yet needs in order to get one.
 *
 * This is the only part of the server that talks to someone who is not yet a
 * customer, and it holds no key and signs nothing — same trust model as the
 * plan tools. It answers three questions and hands back a URL:
 *
 *   where does my vault go     the FACTORY's own `vault_id_for` view
 *   what must I attach          the factory's `required_deposit` + code storage
 *   how do I sign it            the web page, which the user's wallet approves
 *
 * THE DERIVATION IS NOT REIMPLEMENTED HERE. `vault_id_for` exists on the
 * factory precisely so there is one implementation of it; a local copy is a
 * thing that drifts. The factory's prefix rule has already changed once (labels
 * are now rooted in the caller's prefix after a squatting hole), and a client
 * that had copied the old rule would have gone on confidently printing wrong
 * addresses.
 */

/**
 * Bytes of the vault contract the factory deploys.
 *
 * 301,033 until `create_agent_account` was removed, which took 7,305 bytes
 * with it — about 0.073 NEAR off every vault's storage deposit. The pin
 * caught the drift the moment the contract shrank, which is the entire
 * reason it exists.
 *
 * Mirrors `packages/create-float/res/vault.wasm`, and `create.pins.test.ts`
 * reads that file and fails if the two disagree — so a contract rebuild cannot
 * silently leave this quoting a deposit that is too small. Too small is not a
 * clean failure: CreateAccount succeeds and the vault sits below its own
 * storage requirement, bricking on the first write.
 */
export const CONTRACT_BYTES = 293728;

/** NEAR charges 1e19 yoctoNEAR per byte of storage. */
export const STORAGE_COST_PER_BYTE = 10n ** 19n;

/**
 * Gas the create page attaches. MEASURED commitment is 124.88 TGas:
 * 42.79 to deliver and decode the 401 KB base64 argument (measured on chain),
 * plus CreateAccount 7.70, Transfer 0.23, DeployContract 34.16, and the
 * factory's forwarded 30 + 10. 200 keeps ~60% headroom.
 *
 * Must match `web/index.html`. It is not a free choice — see
 * `GAS_RESERVATION_YOCTO`.
 */
export const CREATE_GAS_TGAS = 200n;

/**
 * What the user must HOLD on top of the deposit, at signing time.
 *
 * A transaction reserves `prepaid_gas * 1e9` — the MAXIMUM gas price — for the
 * duration of the call, and refunds the unused part a receipt later. Almost
 * none of it is burned (~0.004 in practice), but the wallet checks the balance
 * against the reservation and refuses below it. Quoting only the deposit is
 * what produced:
 *
 *   Sender work12.testnet does not have enough balance 3.5234
 *   for operation costing 3.674061500357969
 *
 * so the quoted total includes it.
 */
export const GAS_RESERVATION_YOCTO = CREATE_GAS_TGAS * 10n ** 12n * 10n ** 9n;

/**
 * Known factories.
 *
 * MAINNET IS DELIBERATELY ABSENT until one is deployed and verified. A wrong
 * default here does not fail safely: it sends a real user with real NEAR to
 * sign a 3.4 NEAR deposit into an account we do not control. Absent means the
 * tool asks, which is the correct behaviour for a value nobody has measured.
 */
export const FACTORY_BY_NETWORK: Record<string, string | undefined> = {
  testnet: "fac.floatv4.testnet",
  mainnet: undefined,
};

export interface CreatePlanInput {
  owner: string;
  /**
   * False when the caller does not know the user's NEAR account.
   *
   * An agent onboarding a stranger has no account id to pass, and demanding
   * one assumes the user knows it, types it correctly, and has one at all.
   * The page derives everything from the CONNECTED wallet anyway, so an
   * owner-less link is not degraded — it asks the wallet instead of the human.
   */
  ownerKnown?: boolean;
  /** From the factory's `vault_id_for`. `null` means no legal derived id. */
  vaultId: string | null;
  factory: string;
  network: string;
  /** From the factory's `get_config`. */
  requiredDepositYocto: string;
  paused: boolean;
  appUrl: string;
  /** Whether the derived account is already on chain. */
  exists?: boolean;
}

export interface CreatePlan {
  owner: string | null;
  /** Null when the owner is unknown — the wallet decides it at signing time. */
  vault: string | null;
  factory: string;
  network: string;
  depositYocto: string;
  depositNear: string;
  gasTgas: number;
  gasReservationNear: string;
  totalRequiredYocto: string;
  totalRequiredNear: string;
  url: string;
  warnings: string[];
  note: string;
}

/** yoctoNEAR -> a NEAR string, without floating point. */
export function yoctoToNear(y: bigint, dp = 5): string {
  const neg = y < 0n;
  const v = neg ? -y : y;
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").slice(0, dp);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function buildCreatePlan(i: CreatePlanInput): CreatePlan {
  if (i.paused) {
    throw new Error(
      `The factory ${i.factory} is paused — vault creation is disabled. ` +
        `This is the operator's kill switch; try again later.`,
    );
  }
  // UNKNOWN OWNER IS A VALID CASE, not a missing argument. Everything below
  // that depends on the owner is skipped rather than guessed: no derived
  // address, no existence check, and no `owner` on the url — the page refuses
  // when that parameter disagrees with the connected wallet, so a blank or
  // invented one would turn every link into a refusal.
  const known = i.ownerKnown !== false && !!i.owner;

  if (known && !i.vaultId) {
    throw new Error(
      `${i.owner} has no legal vault id under ${i.factory}. ` +
        `An implicit account (a 64-character hex id) cannot have one: the derived ` +
        `prefix is already 64 characters, so "<prefix>.${i.factory}" exceeds NEAR's ` +
        `64-character limit. Use a named account.`,
    );
  }
  if (known && i.exists) {
    throw new Error(
      `${i.vaultId} already exists. That is this owner's vault — connect to it ` +
        `with NEAR_VAULT_CONTRACT=${i.vaultId} rather than creating another.`,
    );
  }

  const deposit = BigInt(i.requiredDepositYocto) + BigInt(CONTRACT_BYTES) * STORAGE_COST_PER_BYTE;
  const total = deposit + GAS_RESERVATION_YOCTO;

  const url = new URL(i.appUrl);
  if (known) url.searchParams.set("owner", i.owner);
  url.searchParams.set("factory", i.factory);
  url.searchParams.set("network", i.network);

  const unknownOwnerWarnings = known
    ? []
    : [
        `The vault address is not known yet — it is derived from whichever wallet ` +
          `you connect, and the page will show it before you approve anything.`,
        `Nothing has checked whether you already have a vault. If you do, the page ` +
          `will say so rather than creating a second one.`,
      ];

  return {
    owner: known ? i.owner : null,
    vault: known ? i.vaultId : null,
    factory: i.factory,
    network: i.network,
    depositYocto: deposit.toString(),
    depositNear: yoctoToNear(deposit),
    gasTgas: Number(CREATE_GAS_TGAS),
    gasReservationNear: yoctoToNear(GAS_RESERVATION_YOCTO),
    totalRequiredYocto: total.toString(),
    totalRequiredNear: yoctoToNear(total),
    url: url.toString(),
    warnings: [
      ...unknownOwnerWarnings,
      `Almost all of the ${yoctoToNear(deposit)} NEAR is a refundable storage ` +
        `deposit held by your vault, not a fee.`,
      `You must HOLD ${yoctoToNear(total)} NEAR at signing time: the deposit plus a ` +
        `${yoctoToNear(GAS_RESERVATION_YOCTO)} gas reservation. The reservation is ` +
        `refunded moments later — only about 0.004 is actually spent — but a wallet ` +
        `refuses the transaction if the balance is below it.`,
      `Nothing can spend from this vault until you add an agent and give it a budget.`,
    ],
    note:
      `This server never sees or holds a key. Open the URL and approve the ` +
      `transaction in your own wallet; the contract travels as an argument to ` +
      `one ordinary function call, and the factory deploys it for you.`,
  };
}

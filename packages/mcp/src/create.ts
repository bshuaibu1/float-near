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
 * 298,819 -> 298,920 on 2026-11-08, when `new` began giving a creation-time
 * agent its OWN child node instead of binding it to root. +101 bytes, about
 * 0.00101 NEAR more per vault. The pin caught this one too, on the first gate
 * run after the rebuild.
 *
 * Mirrors `packages/create-float/res/vault.wasm`, and `create.pins.test.ts`
 * reads that file and fails if the two disagree — so a contract rebuild cannot
 * silently leave this quoting a deposit that is too small. Too small is not a
 * clean failure: CreateAccount succeeds and the vault sits below its own
 * storage requirement, bricking on the first write.
 */
export const CONTRACT_BYTES = 298839;

/** NEAR charges 1e19 yoctoNEAR per byte of storage. */
export const STORAGE_COST_PER_BYTE = 10n ** 19n;

/**
 * What `web/index.html` adds on top of the code's storage stake.
 *
 * THE FACTORY'S FLOOR IS NOT WHAT THE USER IS ASKED FOR, and conflating the
 * two quoted a deposit 0.26 NEAR too low. `begin()` in
 * contracts/factory/src/lib.rs rejects below `required_deposit + bytes * 1e19`
 * — a real floor, 3.037280 on testnet today. But the page attaches
 * `stake + 0.36` instead, as headroom for the root node's state, and a wallet
 * checks the balance against what the PAGE attaches.
 *
 * Measured 2026-11-03: a vault created through the page,
 * tinyrice9138-testnet.fac.floatv4.testnet, holds exactly 3.297280 — the
 * page's figure to the yoctoNEAR. A user funded to the old 3.237280 quote is
 * rejected by their wallet needing 3.497280, which is precisely the failure
 * GAS_RESERVATION_YOCTO below was written to prevent, arriving through the
 * other term.
 *
 * This is a COPY of a value in a file that cannot import from here — the page
 * is standalone HTML served to a browser with no build step. `create.pins.
 * test.ts` reads that file and fails if the two disagree, the same way
 * CONTRACT_BYTES and CREATE_GAS_TGAS are pinned. A copy nothing checks is a
 * copy that drifts.
 */
export const PAGE_HEADROOM_YOCTO = 36n * 10n ** 22n;

/**
 * Funding for an agent's gas key, when one is bound at creation.
 *
 * A NEP-611 gas key's BALANCE is its spending cap — `allowance` is null by
 * design — so this is the only thing bounding how much gas the agent burns.
 * 0.12 NEAR ≈ 50 payments at the vault's 50-TGas `MIN_GAS_FOR_DISPATCH`
 * floor, matching `gasKeyFunding({tgas:60, payments:50})` in create-float.
 *
 * Charged ONLY when an agent is bound. The factory raises its own on-chain
 * deposit floor by exactly this amount in that case, so a quote that omits it
 * is refused with DEPOSIT_TOO_SMALL — and a quote that always includes it
 * overcharges everyone who creates a bare vault.
 *
 * A COPY of `AGENT_GAS_KEY_FUNDING` in contracts/factory/src/lib.rs and
 * `AGENT_GAS` in web/index.html. Three files, one number, which is exactly
 * the shape that already shipped a 0.26 NEAR underquote here — so
 * `create.pins.test.ts` reads both of the others and fails if any disagree.
 */
export const AGENT_GAS_KEY_FUNDING_YOCTO = 12n * 10n ** 22n;

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
 * MAINNET WAS DELIBERATELY ABSENT until one was deployed AND VERIFIED, because
 * a wrong default here does not fail safely: it sends a real user with real
 * NEAR to sign a ~3.4 NEAR deposit into an account we do not control.
 *
 * That precondition is now met. `usefloat.near` was registered on 2026-11-09
 * (tx 2Gfh9H5T1VhEZ465NJ15CnuxFZpyMgsjchY66Lgsvntm) and the factory deployed
 * into it, verified against the chain rather than against the deploy's own
 * report:
 *
 *   local sha256                  ee925937c7b90771c477dd5e0a36770cd2c9654e…
 *   chain code_hash (b58 -> hex)  ee925937c7b90771c477dd5e0a36770cd2c9654e…
 *   deployed bytes fetched        163,525 — byte-for-byte equal to the artifact
 *   get_config                    network mainnet, not paused, deposit 0.1
 *   vault_id_for(test015.near)    test015-near.usefloat.near
 *
 * The name is TOP-LEVEL on purpose (DECISIONS.md 2026-11-08): it is embedded
 * in every user's vault address permanently, because a vault is a sub-account
 * of its factory, and `float.near` was already taken.
 */
export const FACTORY_BY_NETWORK: Record<string, string | undefined> = {
  testnet: "fac.floatv4.testnet",
  mainnet: "usefloat.near",
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
  /**
   * The EXISTING account's own `get_config.owner`, when it could be read.
   *
   * WHY THIS IS NOT OPTIONAL REASONING. "The account at your derived id exists,
   * therefore it is yours" is an inference from the derivation, not a fact
   * about the account — and `derive_prefix` IS NOT INJECTIVE. The factory says
   * so in capitals, and `derive_prefix_collides_between_a_dot_and_a_hyphen`
   * asserts it: `a.b.testnet` and `a-b.testnet` both land on `a-b-testnet`,
   * because replacing the dot merges it into an alphabet that already contains
   * the hyphen. Whoever creates first takes the id.
   *
   * Without reading the vault back, this tool would tell the LOSER of that
   * collision to point their agent at the WINNER's vault. Narrow, but the
   * failure is "you are now configured against someone else's money".
   *
   * `null` means the read failed, or the account is not a Float vault at all.
   * That is a THIRD outcome and must not be flattened into either of the
   * others — "I could not check" is not "it is yours".
   */
  existingOwner?: string | null;
  /**
   * The agent public key to bind at creation, if any.
   *
   * Only affects the QUOTE here — the server neither generates nor holds the
   * secret half, and the page still asks the user to confirm the key before
   * anything is signed.
   */
  agentPk?: string | null;
  /**
   * The root node's caps and token, in HUMAN units — the answers to "how much
   * per day?" and "how much per payment?".
   *
   * WHY THESE EXIST. The signing page has read `?daily=`, `?pertx=`, `?token=`
   * and `?decimals=` since it was written, defaulting to 2.04/0.51 USDC on
   * mainnet. This builder sent four params and never those, so an agent could
   * not ask the user their budget and hand back a ready-to-sign link — which
   * is the entire point of the flow. The page was finished; this side was not,
   * and nothing compared the two lists.
   *
   * HUMAN UNITS, NOT BASE UNITS. The page scales by `decimals` itself —
   * `units()` pads the fraction to DECIMALS digits — so base units passed here
   * would be scaled a second time and turn a 100 USDC cap into 100 million.
   */
  daily?: string;
  perTx?: string;
  token?: string;
  decimals?: number;
  /**
   * A vault label, which is PART OF THE ADDRESS.
   *
   * `resolve_vault` builds `{prefix}-{label}.{factory}`, so a labelled create
   * does NOT land on the id `vault_id_for` returned. The page already knows
   * this and appends the suffix before showing an address; this builder has to
   * agree with it, or the user is told one address and gets another.
   */
  label?: string;
}

/**
 * Refuse a cap the page would silently round, or the contract would reject.
 *
 * EVERY ONE OF THESE IS A POST-SIGNATURE FAILURE IF IT GETS THROUGH. These
 * values go into a transaction the user approves, so a bad one is not a
 * validation error they can correct — it is a panic after the deposit moved,
 * or worse, a cap that is quietly not the number they agreed to.
 */
export function validateCaps(i: {
  daily?: string;
  perTx?: string;
  decimals?: number;
  token?: string;
  label?: string;
  factory: string;
}): string[] {
  const problems: string[] = [];
  const dp = i.decimals ?? 6;
  const numeric = /^\d+(\.\d+)?$/;

  if (
    i.decimals !== undefined &&
    (!Number.isInteger(i.decimals) || i.decimals < 0 || i.decimals > 24)
  ) {
    problems.push(`decimals must be an integer 0-24, got ${i.decimals}`);
  }

  for (const [name, v] of [
    ["daily", i.daily],
    ["perTx", i.perTx],
  ] as const) {
    if (v === undefined) continue;
    if (!numeric.test(v)) {
      problems.push(
        `${name} must be a plain decimal in HUMAN units, e.g. "100" or "2.04", got "${v}"`,
      );
      continue;
    }
    if (Number(v) <= 0) {
      problems.push(`${name} must be greater than 0 — a zero cap refuses every payment`);
      continue;
    }
    // THE PAGE TRUNCATES; IT DOES NOT ROUND AND DOES NOT COMPLAIN. `units()`
    // slices the fraction to `decimals` digits, so "2.0400001" against a
    // 6-decimal token becomes 2.040000 and the user approves a cap that is not
    // the one they were quoted. Never silently alter a number about money.
    const frac = v.split(".")[1] ?? "";
    if (frac.length > dp) {
      problems.push(
        `${name} "${v}" has ${frac.length} decimal places but the token has ${dp}. ` +
          `The signing page truncates rather than rounding, so the cap would silently ` +
          `become "${v.split(".")[0]}.${frac.slice(0, dp)}".`,
      );
    }
  }

  if (i.daily && i.perTx && numeric.test(i.daily) && numeric.test(i.perTx)) {
    if (Number(i.perTx) > Number(i.daily)) {
      problems.push(
        `perTx (${i.perTx}) is larger than daily (${i.daily}), so the per-payment cap ` +
          `can never bind — the daily cap refuses first. Probably swapped.`,
      );
    }
  }

  if (i.token !== undefined && !/^[a-z0-9._-]{2,64}$/.test(i.token)) {
    problems.push(`token "${i.token}" is not a legal NEAR account id`);
  }

  if (i.label !== undefined) {
    // The CONTRACT's rule, not a looser one, so a bad label is refused here
    // rather than panicking BAD_LABEL after the user has paid.
    if (!/^[a-z0-9]{1,16}$/.test(i.label)) {
      problems.push(`label "${i.label}" must be 1-16 characters of a-z or 0-9`);
    } else if (i.label === i.factory.split(".").pop()) {
      // Added to the factory on 2026-11-10: a label equal to the factory's own
      // suffix rebuilds another account's derived id. The page predates that
      // guard and does not know about it, so this is the only layer that can
      // catch it before a signature.
      problems.push(
        `label "${i.label}" is the factory's own suffix, which the factory refuses — ` +
          `it would rebuild another account's derived vault id`,
      );
    }
  }

  return problems;
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
  /** What the agent should do after the user signs, instead of asking them. */
  confirm: {
    vault: string | null;
    tool: string;
    args: { vault: string | null; owner: string; network: string } | null;
    instruction: string;
  };
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
    // Three outcomes, deliberately not two. The old message asserted the
    // first one for all three.
    if (i.existingOwner && i.existingOwner === i.owner) {
      throw new Error(
        `${i.vaultId} already exists and ${i.owner} owns it — confirmed by reading ` +
          `its get_config. Connect to it with NEAR_VAULT_CONTRACT=${i.vaultId} ` +
          `rather than creating another.`,
      );
    }
    if (i.existingOwner) {
      throw new Error(
        `${i.vaultId} already exists and is owned by ${i.existingOwner}, NOT by ` +
          `${i.owner}. Do NOT point an agent at it.\n\n` +
          `The factory derives a vault id by replacing dots with hyphens, and that ` +
          `is not injective: "a.b.near" and "a-b.near" both derive "a-b-near", and ` +
          `whoever created first holds the id. Create yours under a label instead, ` +
          `which puts it at a different address.`,
      );
    }
    throw new Error(
      `${i.vaultId} already exists, but its owner could NOT be read, so whether it ` +
        `is yours is unknown — not assumed. It may not be a Float vault at all. ` +
        `Check it before pointing anything at it:\n` +
        `  near view ${i.vaultId} get_config`,
    );
  }

  // Two different floors, and the quote must clear BOTH.
  //
  //   pageAttaches   what the wallet is actually asked to approve
  //   factoryFloor   what `begin()` rejects below, on chain
  //
  // They are independent: the page's headroom is a fixed constant while the
  // factory's floor moves with `set_required_deposit`. Quoting either one
  // alone is what broke — the old code quoted the floor, and the page then
  // asked for 0.26 more.
  const stake = BigInt(CONTRACT_BYTES) * STORAGE_COST_PER_BYTE;
  // Both floors move by the gas-key funding when an agent is bound: the page
  // attaches it, and the factory requires it.
  const agentFunding = i.agentPk ? AGENT_GAS_KEY_FUNDING_YOCTO : 0n;
  const pageAttaches = stake + PAGE_HEADROOM_YOCTO + agentFunding;
  const factoryFloor = BigInt(i.requiredDepositYocto) + stake + agentFunding;
  const deposit = pageAttaches > factoryFloor ? pageAttaches : factoryFloor;
  const total = deposit + GAS_RESERVATION_YOCTO;

  // If the operator raises `required_deposit` past the page's headroom, the
  // page under-attaches and the create is rejected ON CHAIN with
  // DEPOSIT_TOO_SMALL. Quoting the higher figure does not rescue that — the
  // user would hold enough and still fail, because the page attaches the
  // lesser amount regardless of what they hold. Say so rather than quoting a
  // number that cannot help.
  const underAttachWarning =
    factoryFloor > pageAttaches
      ? [
          `WARNING: ${i.factory} now requires ${yoctoToNear(factoryFloor)} NEAR, but the ` +
            `create page attaches only ${yoctoToNear(pageAttaches)}. The transaction will be ` +
            `rejected on chain with DEPOSIT_TOO_SMALL no matter how much you hold. The page's ` +
            `headroom constant needs raising — this is an operator bug, not a funding problem.`,
        ]
      : [];

  // REFUSE BEFORE BUILDING A LINK, not after. Returning a URL alongside a
  // warning would still be a URL the agent hands over and the user signs.
  const capProblems = validateCaps({
    daily: i.daily,
    perTx: i.perTx,
    decimals: i.decimals,
    token: i.token,
    label: i.label,
    factory: i.factory,
  });
  if (capProblems.length) {
    throw new Error(
      `Refusing to build a signing link:\n  - ${capProblems.join("\n  - ")}\n\n` +
        `These become part of a transaction the user approves, so a bad value is ` +
        `not a correctable error — it is a panic after the deposit moved, or a cap ` +
        `that is not the number they agreed to.`,
    );
  }

  const url = new URL(i.appUrl);
  if (known) url.searchParams.set("owner", i.owner);
  if (i.agentPk) url.searchParams.set("agent_pk", i.agentPk);
  url.searchParams.set("factory", i.factory);
  url.searchParams.set("network", i.network);
  // The interview answers. Names are the PAGE's (`pertx`, not `perTx`) —
  // `scripts/check-create-url-params.mjs` compares the two lists so a rename
  // on either side cannot drift silently again.
  if (i.daily !== undefined) url.searchParams.set("daily", i.daily);
  if (i.perTx !== undefined) url.searchParams.set("pertx", i.perTx);
  if (i.token !== undefined) url.searchParams.set("token", i.token);
  if (i.decimals !== undefined) url.searchParams.set("decimals", String(i.decimals));
  if (i.label !== undefined) url.searchParams.set("label", i.label);

  const unknownOwnerWarnings = known
    ? []
    : [
        `The vault address is not known yet — it is derived from whichever wallet ` +
          `you connect, and the page will show it before you approve anything.`,
        `Nothing has checked whether you already have a vault. If you do, the page ` +
          `will say so rather than creating a second one.`,
      ];

  // THE LABEL IS PART OF THE ADDRESS, so the id the factory's view returned is
  // not where a labelled create lands. `web/index.html:1282` does exactly this
  // and says why: showing the unlabelled id while signing for the labelled one
  // tells the user the wrong address.
  //
  // Derived by surgery on the VIEW's answer rather than by reimplementing
  // `derive_prefix` — this file states that the derivation is not duplicated
  // here, and a second copy of it is how the two would disagree. `vault_id`
  // builds `{prefix}.{factory}`, so stripping the known factory suffix leaves
  // exactly the prefix. Asserted rather than assumed, because a `vaultId` that
  // did not end in the factory would silently produce a nonsense address.
  let vault = known ? i.vaultId : null;
  if (vault && i.label !== undefined) {
    const suffix = `.${i.factory}`;
    if (!vault.endsWith(suffix)) {
      throw new Error(
        `vaultId "${vault}" does not end in ".${i.factory}", so the label suffix ` +
          `cannot be placed. Refusing to guess an address next to a real deposit.`,
      );
    }
    vault = `${vault.slice(0, -suffix.length)}-${i.label}${suffix}`;
  }

  return {
    owner: known ? i.owner : null,
    vault,
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
      ...underAttachWarning,
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
    /**
     * WHAT THE AGENT DOES NEXT, so it stops asking the user to read an address
     * back to it.
     *
     * The derived id is known BEFORE anything is signed, so "did it work?" is a
     * question this server can answer by looking at the chain. It used to end
     * at "approve it in your wallet", which left the human relaying an account
     * id the agent already had — the clunkiest step in the flow and a pure
     * documentation gap, not a technical limit.
     *
     * OWNERSHIP IS A SEPARATE CHECK FROM EXISTENCE, and that is the whole
     * reason this names a method rather than saying "poll until it appears".
     * `derive_prefix` is not injective, so an account AT the derived id is not
     * proof the vault is the user's: `vault_await_create` reads `get_config`
     * back and compares `owner`. Three outcomes, never two — mine, someone
     * else's, or could-not-read.
     */
    confirm: known
      ? {
          vault,
          tool: "vault_await_create",
          args: { vault, owner: i.owner, network: i.network },
          instruction:
            `Do NOT ask the user to paste the vault id back — you already have it. ` +
            `After they say they have signed, call \`vault_await_create\` with the ` +
            `arguments above. It polls for the account and verifies \`get_config.owner\` ` +
            `is ${i.owner}, because an account existing at a derived id is not proof it ` +
            `belongs to them.`,
        }
      : {
          vault: null,
          tool: "vault_await_create",
          args: null,
          instruction:
            `The address depends on which wallet connects, so it is not known yet. ` +
            `Ask the user for their account id once they have signed, then call ` +
            `\`vault_await_create\` with it — or call \`vault_create\` again with ` +
            `\`owner\` set to get the address up front.`,
        },
  };
}

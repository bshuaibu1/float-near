import { statSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AGENT_GAS_KEY_FUNDING_YOCTO,
  buildCreatePlan,
  CONTRACT_BYTES,
  CREATE_GAS_TGAS,
  PAGE_HEADROOM_YOCTO,
} from "./create.js";

/**
 * Pins against the real artifacts, because both of these numbers are copies.
 *
 * A copy that nothing checks is a copy that drifts, and this repo has already
 * paid for that: a stale build artifact was one command away from redeploying
 * vulnerable code while reporting the fix as shipped, with the two builds 24
 * bytes apart. These tests are cheap; the failure mode is a user being quoted
 * a deposit too small to cover their own vault's storage, which does not fail
 * cleanly — CreateAccount succeeds and the vault bricks on its first write.
 */

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const WASM = resolve(ROOT, "packages", "create-float", "res", "vault.wasm");
const PAGE = resolve(ROOT, "web", "index.html");
const FACTORY_RS = resolve(ROOT, "contracts", "factory", "src", "lib.rs");

describe("CONTRACT_BYTES", () => {
  it("matches the vault wasm create-float actually ships", () => {
    if (!existsSync(WASM)) {
      // Skipping loudly rather than silently: a missing artifact must not read
      // as a passing pin.
      console.warn(`SKIPPED: ${WASM} not present, cannot pin CONTRACT_BYTES`);
      return;
    }
    expect(CONTRACT_BYTES).toBe(statSync(WASM).size);
  });
});

/**
 * THE PLAN MUST NEVER QUOTE LESS THAN THE PAGE ASKS FOR.
 *
 * This is the pin that was missing, and its absence shipped a quote 0.26 NEAR
 * too low. `buildCreatePlan` priced the FACTORY'S FLOOR — `required_deposit +
 * bytes * 1e19`, which `begin()` in contracts/factory/src/lib.rs really does
 * enforce — while web/index.html attaches `stake + 0.36` as headroom for the
 * root node's state. Both numbers are defensible alone. They disagreed, and a
 * user funded by the plan is charged by the page.
 *
 * Measured 2026-11-03 on testnet: a vault created through the page,
 * tinyrice9138-testnet.fac.floatv4.testnet, holds exactly 3.297280 — the
 * page's figure to the yoctoNEAR, against a quoted must-hold of 3.237280.
 * Funding to the quote produces the wallet rejection quoted in create.ts's
 * own header.
 *
 * The gas pin above already compared this module to the page. The deposit did
 * not, because there was no constant to compare — the quote was assembled
 * from a runtime argument instead. A number with no name cannot be pinned.
 */
describe("the quoted deposit against the page", () => {
  it("is at least what web/index.html actually attaches", () => {
    if (!existsSync(PAGE)) {
      console.warn(`SKIPPED: ${PAGE} not present, cannot pin the deposit`);
      return;
    }
    const html = readFileSync(PAGE, "utf8");
    const m = html.match(/const baseTotal = stake \+ (\d+)n \* 10n \*\* (\d+)n;/);
    expect(m, "no deposit formula found in web/index.html").not.toBeNull();

    const pageAttaches = BigInt(CONTRACT_BYTES) * 10n ** 19n + BigInt(m![1]) * 10n ** BigInt(m![2]);

    // Priced with the factory's real testnet floor, so this is the exact
    // situation a live user is in rather than a hypothetical one.
    const plan = buildCreatePlan({
      owner: "alice.testnet",
      vaultId: "alice-testnet.fac.floatv4.testnet",
      factory: "fac.floatv4.testnet",
      network: "testnet",
      requiredDepositYocto: (10n ** 23n).toString(), // 0.1, as deployed
      paused: false,
      appUrl: "https://app.usefloat.xyz",
    });

    expect(BigInt(plan.depositYocto)).toBeGreaterThanOrEqual(pageAttaches);
    // And the total must additionally cover the reservation the wallet checks.
    expect(BigInt(plan.totalRequiredYocto)).toBeGreaterThanOrEqual(
      pageAttaches + CREATE_GAS_TGAS * 10n ** 12n * 10n ** 9n,
    );
  });

  /**
   * The `>=` above is the safety-critical direction — quoting less than the
   * page asks strands a user at a wallet prompt. It does NOT catch drift the
   * other way: a headroom raised here but not on the page would quote more
   * than anyone needs and pass. Harmless to a user, but it means the two
   * files have silently stopped being copies of one value, and the next
   * person to reconcile them has no way to tell which is authoritative.
   *
   * So pin it exactly, the way CONTRACT_BYTES is pinned to the wasm.
   */
  it("holds exactly the constant the page uses, in both directions", () => {
    if (!existsSync(PAGE)) {
      console.warn(`SKIPPED: ${PAGE} not present, cannot pin PAGE_HEADROOM_YOCTO`);
      return;
    }
    const m = readFileSync(PAGE, "utf8").match(/const baseTotal = stake \+ (\d+)n \* 10n \*\* (\d+)n;/);
    expect(m, "no deposit formula found in web/index.html").not.toBeNull();
    expect(PAGE_HEADROOM_YOCTO).toBe(BigInt(m![1]) * 10n ** BigInt(m![2]));
  });
});

/**
 * THE GAS-KEY FUNDING LIVES IN THREE FILES.
 *
 * `AGENT_GAS_KEY_FUNDING_YOCTO` here, `AGENT_GAS` in web/index.html, and
 * `AGENT_GAS_KEY_FUNDING` in contracts/factory/src/lib.rs. None can import
 * from another: the page is standalone HTML and the factory is Rust.
 *
 * The factory raises its on-chain deposit floor by this amount when an agent
 * is bound, so disagreement is not cosmetic in either direction — quote or
 * attach too little and the create is rejected with DEPOSIT_TOO_SMALL after
 * the user has signed; too much and every vault silently overpays.
 *
 * Three copies of one number is precisely the shape that already shipped a
 * 0.26 NEAR underquote in this file's absence.
 */
describe("AGENT_GAS_KEY_FUNDING_YOCTO", () => {
  it("matches the constant web/index.html attaches", () => {
    if (!existsSync(PAGE)) {
      console.warn(`SKIPPED: ${PAGE} not present`);
      return;
    }
    const m = readFileSync(PAGE, "utf8").match(/const AGENT_GAS = (\d+)n \* 10n \*\* (\d+)n;/);
    expect(m, "no AGENT_GAS constant found in web/index.html").not.toBeNull();
    expect(AGENT_GAS_KEY_FUNDING_YOCTO).toBe(BigInt(m![1]) * 10n ** BigInt(m![2]));
  });

  it("matches the floor the factory contract enforces", () => {
    if (!existsSync(FACTORY_RS)) {
      console.warn(`SKIPPED: ${FACTORY_RS} not present`);
      return;
    }
    const m = readFileSync(FACTORY_RS, "utf8").match(
      /const AGENT_GAS_KEY_FUNDING: NearToken = NearToken::from_yoctonear\((\d+) \* 10u128\.pow\((\d+)\)\);/,
    );
    expect(m, "no AGENT_GAS_KEY_FUNDING found in the factory contract").not.toBeNull();
    expect(AGENT_GAS_KEY_FUNDING_YOCTO).toBe(BigInt(m![1]) * 10n ** BigInt(m![2]));
  });

  /**
   * And the quote must actually move when an agent is requested. Pinning the
   * constant proves the three files agree on a number; this proves the number
   * is wired into the figure a user is given.
   */
  it("is added to the quote when an agent is bound, and only then", () => {
    const base = {
      owner: "alice.testnet",
      vaultId: "alice-testnet.fac.floatv4.testnet",
      factory: "fac.floatv4.testnet",
      network: "testnet",
      requiredDepositYocto: (10n ** 23n).toString(),
      paused: false,
      appUrl: "https://app.usefloat.xyz",
    };
    const bare = buildCreatePlan(base);
    const withAgent = buildCreatePlan({
      ...base,
      agentPk: "ed25519:9ErYvQWQeQNFRAVW4qsaNiPVf4zSQFidTPdeJMCXXDvJ",
    });
    expect(BigInt(withAgent.depositYocto) - BigInt(bare.depositYocto)).toBe(
      AGENT_GAS_KEY_FUNDING_YOCTO,
    );
    // And the key must reach the link, or the page can never bind it.
    expect(new URL(withAgent.url).searchParams.get("agent_pk")).toBe(
      "ed25519:9ErYvQWQeQNFRAVW4qsaNiPVf4zSQFidTPdeJMCXXDvJ",
    );
    expect(new URL(bare.url).searchParams.has("agent_pk")).toBe(false);
  });
});

describe("CREATE_GAS_TGAS", () => {
  it("matches the gas the create page actually attaches", () => {
    if (!existsSync(PAGE)) {
      console.warn(`SKIPPED: ${PAGE} not present, cannot pin CREATE_GAS_TGAS`);
      return;
    }
    const html = readFileSync(PAGE, "utf8");
    const m = html.match(/gas:\s*"(\d+)"/);
    expect(m, "no gas literal found in web/index.html").not.toBeNull();
    // Assert the units before comparing, so a page that switched to a
    // different representation fails here rather than quietly passing.
    const attached = BigInt(m![1]);
    expect(attached % 10n ** 12n).toBe(0n);
    expect(attached / 10n ** 12n).toBe(CREATE_GAS_TGAS);
  });
});

/**
 * THE PAGE'S DEFAULT CAPS MUST BE ABLE TO SEND A ROUND PAYMENT.
 *
 * Cross-chain quotes are EXACT_OUTPUT: the payee receives `amount` and the
 * vault is charged MORE — measured 1.5% at 0.50 USDC, 3.5% at 0.10, because a
 * solver's fixed cost dominates at small sizes. So a per-tx cap EQUAL to a
 * round amount refuses that amount.
 *
 * This bit twice in one sitting. The shipped default was 0.51, which reads as
 * "sized for a 0.50 payment" and is not — 0.50 costs 0.5075. Replacing it with
 * 5 reproduced the identical defect at a different scale, because 5.00 costs
 * 5.075. Both looked obviously fine while being obviously wrong, which is the
 * definition of a thing that needs a test rather than a comment.
 *
 * Reads the DEFAULTS OUT OF THE PAGE instead of restating them. A copy here
 * would pass while the shipped page stayed broken.
 */
describe("the page's default caps can actually deliver a round payment", () => {
  const html = readFileSync(PAGE, "utf8");
  /**
   * NO REGEX. The first version of this built one from a template literal and
   * lost a backslash level on the way in, so it compiled to
   * `q.get("pertx")s*??s*(...)` and threw "Nothing to repeat". It failed
   * loudly, which is the only reason it was caught — a subtler escaping slip
   * could have matched the wrong number and pinned a value nobody chose,
   * which is precisely the failure this whole block exists to prevent.
   *
   * Splitting on fixed strings has no escaping to get wrong.
   */
  const def = (name: string) => {
    const marker = `q.get("${name}") ?? (NETWORK === "mainnet" ? "`;
    const at = html.indexOf(marker);
    if (at === -1) throw new Error(`could not find the mainnet '${name}' default in web/index.html`);
    const rest = html.slice(at + marker.length);
    const raw = rest.slice(0, rest.indexOf('"'));
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`'${name}' default parsed as "${raw}", not a number`);
    return n;
  };

  /** Worst measured solver overhead, at the small end where it is highest. */
  const FEE = 0.035;

  it("lets a round 5.00 USDC cross-chain payment through the per-tx cap", () => {
    const perTx = def("pertx");
    // Not `>=`. Equal means the fee pushes it over and the payment is refused.
    expect(
      perTx,
      `per-tx default ${perTx} cannot deliver a round 5.00: it is charged ${(5 * (1 + FEE)).toFixed(3)}`,
    ).toBeGreaterThan(5 * (1 + FEE));
  });

  it("is not sized to look like a payment amount", () => {
    // 0.51 was the tell: a cap a hair above a round number reads as "chosen for
    // that payment" and is the one value guaranteed to refuse it.
    const perTx = def("pertx");
    for (const round of [0.1, 0.5, 1, 2, 5, 10, 20, 25, 50, 100]) {
      const charged = round * (1 + FEE);
      expect(
        perTx > round && perTx < charged,
        `per-tx default ${perTx} sits between a round ${round} and its true cost ` +
          `${charged.toFixed(3)} — it looks sized for that payment and would refuse it`,
      ).toBe(false);
    }
  });

  it("allows more than one max-size payment per day", () => {
    expect(def("daily")).toBeGreaterThanOrEqual(def("pertx") * 2);
  });
});

import { describe, it, expect } from "vitest";
import { UnknownActionError, planOwnerAction } from "./owner-plan.js";

/**
 * The owner-plan builder, which had NO tests while living inline in a switch
 * inside the request handler — unreachable from a test because nothing
 * exported it.
 *
 * It is worth testing because it is the only place the dashboard's intent
 * becomes an actual contract call. A wrong method name here produces a
 * signing link the owner approves in their wallet, and a wrong ARGUMENT
 * produces one that succeeds while doing something other than what the page
 * said it would.
 */
const ENV = { vault: "v.fac.testnet", token: "ft.testnet", decimals: 6 };

describe("planOwnerAction", () => {
  it("builds set_node_caps in HUMAN units, not base units", () => {
    // The scaling trap: planSetNodeCaps scales internally. Pre-scaling here
    // too would turn a 100 USDC cap into 100 million USDC — a cap that is
    // silently no cap at all.
    const p = planOwnerAction({ action: "caps", nodeId: 1, dailyCap: "100", perTxCap: "10" }, ENV);
    expect(p.methodName).toBe("set_node_caps");
    expect(JSON.stringify(p.args)).toContain("100000000");
    expect(JSON.stringify(p.args)).not.toContain("100000000000000");
  });

  it("builds set_cooldown", () => {
    const p = planOwnerAction({ action: "cooldown", nodeId: 2, cooldownSec: 60 }, ENV);
    expect(p.methodName).toBe("set_cooldown");
  });

  it("builds set_recipients, and an ABSENT list means inherit (null), never []", () => {
    // `validate_recipients` panics on an empty vec with "1..=32 recipients, or
    // None to inherit", so a missing list must reach the contract as null.
    const p = planOwnerAction({ action: "recipients", nodeId: 3 }, ENV);
    expect(p.methodName).toBe("set_recipients");
    expect((p.args as Record<string, unknown>).recipients).toBeNull();
  });

  it("builds freeze_node", () => {
    const p = planOwnerAction({ action: "freeze", nodeId: 4, frozen: true }, ENV);
    expect(p.methodName).toBe("freeze_node");
  });

  /* The two the sidebar rendered as dead text. Both have contract setters and
     both are checked on every payment, so both are policies the owner can
     actually change — they were readouts only because nothing wired them. */

  it("builds set_paused, addressed to the VAULT and not to a node", () => {
    const p = planOwnerAction({ action: "pause", paused: true }, ENV);
    expect(p.methodName).toBe("set_paused");
    expect(p.receiverId).toBe(ENV.vault);
    expect(p.args).toEqual({ paused: true });
    // Vault-wide: a nodeId would imply it only stops one agent.
    expect(p.args).not.toHaveProperty("node_id");
  });

  it("builds set_paused(false) to RESUME, not a second pause", () => {
    const p = planOwnerAction({ action: "pause", paused: false }, ENV);
    expect(p.args).toEqual({ paused: false });
  });

  it("builds set_strict_allocation", () => {
    const p = planOwnerAction({ action: "allocation", strict: true }, ENV);
    expect(p.methodName).toBe("set_strict_allocation");
    expect(p.receiverId).toBe(ENV.vault);
    expect(p.args).toEqual({ strict: true });
  });

  it("builds set_strict_allocation(false) to allow overcommit", () => {
    const p = planOwnerAction({ action: "allocation", strict: false }, ENV);
    expect(p.args).toEqual({ strict: false });
  });

  it("carries one yocto on every owner method, or assert_one_yocto rejects it", () => {
    for (const req of [
      { action: "pause", paused: true },
      { action: "allocation", strict: true },
      { action: "freeze", nodeId: 1, frozen: true },
    ] as const) {
      expect(planOwnerAction(req, ENV).depositYocto).toBe("1");
    }
  });

  /* ADD ROLE.

     The one owner method whose deposit is NOT one yocto: `add_role` is
     #[payable] and the attached NEAR becomes the new agent's gas-key
     balance, which IS its spending cap - a gas key's allowance is null by
     design. Sending one yocto would install a key that cannot make a
     single call, because NEAR reserves `prepaid_gas * 1e9` up front.

     The adapter never generates the keypair. The caller creates it locally
     and passes only the PUBLIC half; the secret has to land on the machine
     that will run the agent, and an adapter that touched it would be
     custodial. */
  describe("addRole", () => {
    const KEY = "ed25519:FmcccnmgVhPNgKSm64Rgp9ZmFs6ckBVqLZeMPaRRPFZu";
    const FUNDING = String(12n * 10n ** 22n); // 0.12 NEAR

    it("builds add_role addressed to the vault", () => {
      const p = planOwnerAction(
        {
          action: "addRole",
          label: "marketing",
          dailyCap: "25",
          perTxCap: "5",
          cooldownSec: 0,
          recipients: null,
          publicKey: KEY,
          fundingYocto: FUNDING,
        },
        ENV,
      );
      expect(p.methodName).toBe("add_role");
      expect(p.receiverId).toBe(ENV.vault);
      expect((p.args as Record<string, unknown>).label).toBe("marketing");
      expect((p.args as Record<string, unknown>).public_key).toBe(KEY);
    });

    it("attaches the FUNDING as the deposit, not one yocto", () => {
      const p = planOwnerAction(
        {
          action: "addRole",
          label: "news",
          dailyCap: "10",
          perTxCap: "2",
          publicKey: KEY,
          fundingYocto: FUNDING,
        },
        ENV,
      );
      expect(p.depositYocto).toBe(FUNDING);
      expect(p.depositYocto).not.toBe("1");
    });

    it("scales the caps from HUMAN units like every other cap action", () => {
      const p = planOwnerAction(
        {
          action: "addRole",
          label: "marketing",
          dailyCap: "25",
          perTxCap: "5",
          publicKey: KEY,
          fundingYocto: FUNDING,
        },
        ENV,
      );
      const j = JSON.stringify(p.args);
      expect(j).toContain("25000000"); // 25 USDC at 6dp
      expect(j).not.toContain("25000000000000"); // not scaled twice
    });

    it("defaults an absent recipients list to null (INHERIT), never []", () => {
      // `validate_recipients` panics on an empty vec.
      const p = planOwnerAction(
        {
          action: "addRole",
          label: "marketing",
          dailyCap: "25",
          perTxCap: "5",
          publicKey: KEY,
          fundingYocto: FUNDING,
        },
        ENV,
      );
      expect((p.args as Record<string, unknown>).recipients).toBeNull();
    });

    it("REFUSES funding below the gas-key minimum - a key funded under it is installed and cannot transact", () => {
      expect(() =>
        planOwnerAction(
          {
            action: "addRole",
            label: "marketing",
            dailyCap: "25",
            perTxCap: "5",
            publicKey: KEY,
            fundingYocto: String(5n * 10n ** 22n), // 0.05, under the 0.06 floor
          },
          ENV,
        ),
      ).toThrow(/0\.06|gas key/i);
    });

    it("REFUSES a malformed public key", () => {
      expect(() =>
        planOwnerAction(
          {
            action: "addRole",
            label: "marketing",
            dailyCap: "25",
            perTxCap: "5",
            publicKey: "not-a-key",
            fundingYocto: FUNDING,
          },
          ENV,
        ),
      ).toThrow(/public key/i);
    });

    it("REFUSES an empty or over-long label", () => {
      for (const label of ["", "x".repeat(49)]) {
        expect(() =>
          planOwnerAction(
            {
              action: "addRole",
              label,
              dailyCap: "25",
              perTxCap: "5",
              publicKey: KEY,
              fundingYocto: FUNDING,
            },
            ENV,
          ),
        ).toThrow(/label/i);
      }
    });
  });

  it("REFUSES an unknown action rather than planning something arbitrary", () => {
    expect(() => planOwnerAction({ action: "drain" } as never, ENV)).toThrow(UnknownActionError);
  });

  /**
   * A VALIDATION failure is not an unknown action.
   *
   * The HTTP handler caught every throw from here and reported
   * `unknown action: <name>`, so underfunding a gas key, mistyping a public
   * key or using a 60-character label all told the caller the action did
   * not exist. The one message that cannot help them.
   */
  it("distinguishes a bad ARGUMENT from an unknown ACTION", () => {
    let thrown: unknown;
    try {
      planOwnerAction(
        {
          action: "addRole",
          label: "marketing",
          dailyCap: "25",
          perTxCap: "5",
          publicKey: "ed25519:FmcccnmgVhPNgKSm64Rgp9ZmFs6ckBVqLZeMPaRRPFZu",
          fundingYocto: String(5n * 10n ** 22n),
        },
        ENV,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnknownActionError);
    expect(String((thrown as Error).message)).toMatch(/gas key|0.06/i);
  });
});

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

  /**
   * OMITTING A FIELD MUST NOT TRIGGER THE DESTRUCTIVE DIRECTION.
   *
   * `frozen` and `paused` are optional, and both default to false. Flip
   * either default and a request that merely forgot the field becomes a
   * transaction that freezes an agent or stops the entire vault - and it
   * would be signed, because the summary would read as intended.
   * Mutation-confirmed: both inversions survived the whole suite.
   */
  it("defaults `frozen` to false, so a bare freeze request does not freeze", () => {
    const p = planOwnerAction({ action: "freeze", nodeId: 1 }, ENV);
    expect(JSON.stringify(p.args)).toContain("false");
    expect(JSON.stringify(p.args)).not.toContain("true");
  });

  it("defaults `paused` to false, so a bare pause request does not stop the vault", () => {
    const p = planOwnerAction({ action: "pause" }, ENV);
    expect(p.args).toEqual({ paused: false });
  });

  it("defaults `strict` to false", () => {
    expect(planOwnerAction({ action: "allocation" }, ENV).args).toEqual({ strict: false });
  });

  /**
   * Every action is addressed to the VAULT.
   *
   * The receiver is the one argument that decides which contract runs the
   * call, and only one test asserted it - and that test went out with
   * addRole, leaving the gap invisible until a mutant pointed caps at
   * another account and survived.
   */
  it("addresses every action to the vault", () => {
    const reqs = [
      { action: "caps", nodeId: 1, dailyCap: "10", perTxCap: "2" },
      { action: "cooldown", nodeId: 1, cooldownSec: 60 },
      { action: "recipients", nodeId: 1, recipients: ["a.testnet"] },
      { action: "freeze", nodeId: 1, frozen: true },
      { action: "pause", paused: true },
      { action: "allocation", strict: true },
    ] as const;
    for (const r of reqs) {
      expect(planOwnerAction(r, ENV).receiverId).toBe(ENV.vault);
    }
  });

  it("REFUSES an unknown action rather than planning something arbitrary", () => {
    expect(() => planOwnerAction({ action: "drain" } as never, ENV)).toThrow(UnknownActionError);
  });

  /**
   * A VALIDATION failure is not an unknown action.
   *
   * The HTTP handler caught every throw from here and reported
   * `unknown action: <name>`, so a negative cooldown, a duplicate
   * recipient or an over-long list all told the caller the action did not
   * exist - the one message that cannot help them.
   */
  it("distinguishes a bad ARGUMENT from an unknown ACTION", () => {
    let thrown: unknown;
    try {
      planOwnerAction({ action: "cooldown", nodeId: 1, cooldownSec: -5 }, ENV);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnknownActionError);
    expect(String((thrown as Error).message)).toMatch(/cooldown/i);
  });
});

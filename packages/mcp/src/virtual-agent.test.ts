import { describe, expect, it } from "vitest";

import { planBindVirtualAgent, planUnbindVirtualAgent } from "./payloads.js";

const VAULT = "alice-near.float.near";
const PK = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

/**
 * Virtual agents REPLACED `create_agent_account`, which funded a sub-account
 * with 0.55 NEAR behind a function-call key that could never sign
 * `DeleteAccount` — stranding it permanently. 10.7752 NEAR is stuck across 18
 * testnet agents that way, plus 0.54434 on mainnet.
 *
 * So these payloads are the ONLY way to add an agent now, and the thing they
 * must never do is reintroduce a funded account.
 */
describe("planBindVirtualAgent", () => {
  it("targets bind_virtual_agent on the vault", () => {
    const p = planBindVirtualAgent(VAULT, 2, PK);
    expect(p.receiverId).toBe(VAULT);
    expect(p.methodName).toBe("bind_virtual_agent");
    expect(p.args).toEqual({ node_id: 2, public_key: PK });
  });

  /**
   * ONE YOCTO, NOT A FUNDING DEPOSIT. `bind_virtual_agent` calls
   * `assert_owner()`, which calls `assert_one_yocto()`. Attaching more would
   * not fail, but a payload that asks the owner to attach real NEAR to bind an
   * agent is how the 0.55-per-agent habit creeps back in.
   */
  it("attaches exactly one yocto, never a funding amount", () => {
    expect(planBindVirtualAgent(VAULT, 2, PK).depositYocto).toBe("1");
  });

  it("rejects a key that is not a recognisable public key", () => {
    for (const bad of ["", "aaa", "ed25519:", "notakey"]) {
      expect(() => planBindVirtualAgent(VAULT, 2, bad)).toThrow(/public key/i);
    }
  });

  it("rejects a negative node id", () => {
    expect(() => planBindVirtualAgent(VAULT, -1, PK)).toThrow(/node/i);
  });

  /**
   * MANY-TO-ONE is the headline difference from sub-accounts and the reason a
   * swarm no longer consumes one of the 64 MAX_NODES per member. If the
   * summary does not say so, an owner will assume one key per node.
   */
  it("says the node can hold more than one key", () => {
    const p = planBindVirtualAgent(VAULT, 2, PK);
    expect(`${p.summary} ${p.warnings.join(" ")}`).toMatch(/more than one|several|multiple|many/i);
  });
});

describe("planUnbindVirtualAgent", () => {
  it("targets unbind_virtual_agent with one yocto", () => {
    const p = planUnbindVirtualAgent(VAULT, PK);
    expect(p.methodName).toBe("unbind_virtual_agent");
    expect(p.args).toEqual({ public_key: PK });
    expect(p.depositYocto).toBe("1");
  });

  /**
   * The replay guard is the thing an owner will get wrong. Unbinding frees the
   * 82-byte pubkey->node entry but DELIBERATELY retains the 86-byte nonce
   * entry forever — confirmed live, next_nonce stayed 2 rather than resetting
   * to 1. Without that, unbind/rebind would reset the nonce and reopen replay.
   * An owner who expects all the storage back needs telling.
   */
  it("warns that the nonce entry is retained on purpose", () => {
    const p = planUnbindVirtualAgent(VAULT, PK);
    expect(p.warnings.join(" ")).toMatch(/nonce|replay/i);
  });
});

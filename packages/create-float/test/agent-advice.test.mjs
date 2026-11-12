import { test } from "node:test";
import assert from "node:assert/strict";

import { agentAdvice } from "../bin/agent-advice.mjs";

/**
 * The wizard builds a vault that CANNOT PAY and used to say nothing about it.
 *
 * These pin the branch that closes the CLI-vs-browser asymmetry. The epilogue
 * itself cannot be executed in a test — it prints only after a complete, paid,
 * on-chain run — which is exactly why the logic was extracted here.
 */

const BASE = { vault: "float.alice.near", owner: "alice.near", network: "mainnet" };

test("no agent bound: says it cannot pay and gives the exact command", () => {
  const a = agentAdvice({ ...BASE, gasKeyCount: 0 });
  assert.equal(a.canPay, false);
  assert.match(a.headline, /cannot pay/);
  // The COMMAND is the point. "Bind an agent" without the invocation is the
  // same dead end in friendlier words.
  assert.equal(
    a.command,
    "npx -p @floatonnear/create-float float-agent --vault float.alice.near --owner alice.near",
  );
});

test("mainnet omits --network; testnet includes it", () => {
  // Mainnet is every CLI's default, so printing the flag there teaches the
  // wrong default back to the user.
  assert.ok(!agentAdvice({ ...BASE, gasKeyCount: 0 }).command.includes("--network"));

  const t = agentAdvice({ ...BASE, network: "testnet", gasKeyCount: 0 });
  assert.match(t.command, /--network testnet$/);
});

test("agent already bound: does not tell a working vault to add another", () => {
  const one = agentAdvice({ ...BASE, gasKeyCount: 1 });
  assert.equal(one.canPay, true);
  assert.equal(one.command, null, "a bound vault must not be handed a bind command");
  assert.match(one.headline, /key is bound/, "singular for one key");

  assert.match(agentAdvice({ ...BASE, gasKeyCount: 3 }).headline, /keys are bound/);
});

/**
 * THE THIRD STATE, and the reason the signature takes `number|null` rather than
 * a count with 0 standing in for "could not read".
 *
 * Collapsing unknown into 0 would tell a working setup to spend another 0.12
 * NEAR on a redundant key. Collapsing it into >0 would hide the one step
 * between the user and a working payment. Neither is acceptable, so the read
 * failing is its own answer.
 */
test("unreadable chain is reported as unknown, not as either answer", () => {
  const u = agentAdvice({ ...BASE, gasKeyCount: null });
  assert.equal(u.canPay, null);
  assert.equal(u.command, null, "must not hand out a command on a guess");
  assert.match(u.headline, /unknown/);
  assert.doesNotMatch(u.headline, /cannot pay/, "unknown must not read as 'no agent'");
});

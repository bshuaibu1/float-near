import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, makeReaders, agentCount, UsageError, RPC_DEFAULTS } from "../bin/args.mjs";


/**
 * node:assert's `throws` returns undefined, unlike Vitest/Jest where it hands
 * back the error. Capturing it there silently yields `undefined` and the test
 * dies on `.exitCode` with a TypeError that looks like an implementation bug
 * rather than a harness one. This returns the error so it can be inspected.
 */
function caught(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw, got none");
}

test("defaults: MAINNET, its RPC, nothing opted into", () => {
  // Flipped from testnet on 2026-10-30. The product runs on mainnet: NEAR
  // Intents has no testnet, so the cross-chain rail — the reason this exists —
  // cannot be exercised there at all, and a default that silently produces a
  // vault with that rail closed is a default that misrepresents the product.
  //
  // Defaulting to a network that spends real funds is only acceptable because
  // of the gate further in: the wizard prints the full bill and requires the
  // word "mainnet" to be TYPED before it sends anything. Removing that gate
  // and leaving this default would be indefensible.
  const c = parseArgs([]);
  assert.equal(c.network, "mainnet");
  assert.equal(c.mainnet, true);
  assert.equal(c.rpc, RPC_DEFAULTS.mainnet);
  assert.equal(c.dry, false);
  assert.equal(c.yes, false);
  assert.equal(c.owner, null);
  assert.equal(c.decimals, 6);
});

test("testnet remains reachable as an explicit opt-in", () => {
  // Kept as a development escape hatch: the sandbox tier, deploy-testnet.sh and
  // the v4.floatv4.testnet virtual-agent proving ground all still use it.
  const c = parseArgs(["--network", "testnet"]);
  assert.equal(c.network, "testnet");
  assert.equal(c.mainnet, false);
  assert.equal(c.rpc, RPC_DEFAULTS.testnet);
});

test("mainnet gets a per-network RPC default, not null", () => {
  // The regression this pins: without a per-network default, --network mainnet
  // left RPC null and every call failed with "Failed to parse URL from null",
  // which names neither the flag nor the network.
  const c = parseArgs(["--network", "mainnet"]);
  assert.equal(c.mainnet, true);
  assert.equal(c.rpc, RPC_DEFAULTS.mainnet);
  assert.notEqual(c.rpc, null);
  assert.notEqual(RPC_DEFAULTS.mainnet, RPC_DEFAULTS.testnet);
});

test("--rpc overrides the per-network default on both networks", () => {
  for (const net of ["testnet", "mainnet"]) {
    const c = parseArgs(["--network", net, "--rpc", "http://127.0.0.1:1"]);
    assert.equal(c.rpc, "http://127.0.0.1:1");
  }
});

test("an unknown network THROWS rather than exiting the process", () => {
  // It used to call process.exit(2) at module scope, so importing this file to
  // read one flag could kill the caller — including a test runner. The exit
  // code is carried on the error instead, and the CLI applies it.
  const e = caught(() => parseArgs(["--network", "betanet"]));
  assert.ok(e instanceof UsageError, `expected UsageError, got ${e?.name}`);
  assert.equal(e.exitCode, 2);
  assert.match(e.message, /Unknown network 'betanet'/);
  assert.match(e.message, /testnet or mainnet/);
});

test("flags are recognised anywhere in argv, and values are read positionally", () => {
  const c = parseArgs(["--yes", "--owner", "me.testnet", "--dry-run", "--network", "mainnet"]);
  assert.equal(c.yes, true);
  assert.equal(c.dry, true);
  assert.equal(c.owner, "me.testnet");
  assert.equal(c.mainnet, true);
});

test("opt() treats a flag with no following value as absent", () => {
  // `--owner` at the end of argv must fall back to the default rather than
  // yield undefined, which would otherwise flow into an account id and fail
  // much later with a message naming neither the flag nor the omission.
  const { opt } = makeReaders(["--owner"]);
  assert.equal(opt("--owner", "fallback"), "fallback");
  const { opt: opt2 } = makeReaders(["--owner", "--yes"]);
  assert.equal(opt2("--owner", "fallback"), "--yes", "a following token is taken as the value, even if it looks like a flag");
});

// ---- --agents

test("--agents: absent, zero and 'all'", () => {
  assert.equal(agentCount(null, 4), 0, "absent means defer, not create");
  assert.equal(agentCount("0", 4), 0);
  assert.equal(agentCount("all", 4), 4);
});

test("--agents clamps to what the tree actually offers", () => {
  assert.equal(agentCount("2", 4), 2);
  assert.equal(agentCount("99", 4), 4, "cannot create more agents than there are agent nodes");
  assert.equal(agentCount("-3", 4), 0, "negative cannot mean 'create some'");
});

test("--agents refuses a non-numeric value instead of silently meaning zero", () => {
  // Creating no agents for `--agents some` would look like success and only
  // surface later as a vault with nothing bound to it.
  for (const bad of ["some", "", "   ", "all-of-them", "1.5"]) {
    const e = caught(() => agentCount(bad, 4));
    assert.ok(e instanceof UsageError, `"${bad}" should be refused with a UsageError, got ${e?.name}`);
    assert.equal(e.exitCode, 2);
  }
});

test("--agents refuses '3abc', which the old inline check ACCEPTED as 3", () => {
  // Number.parseInt("3abc") is 3 and is finite, so the previous guard let it
  // through — contradicting its own comment about refusing non-numeric values.
  // Tightened during extraction; this row is the reason to notice.
  assert.throws(() => agentCount("3abc", 4), UsageError);
});

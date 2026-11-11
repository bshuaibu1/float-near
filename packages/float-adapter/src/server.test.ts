import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve as resolve_ } from "node:path";
import { rpcForNetwork, RPC_BY_NETWORK } from "@floatonnear/mcp";
/**
 * THE RPC MUST FOLLOW THE NETWORK — the same bug as @floatonnear/mcp's.
 *
 * `rpcUrl` was `NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com"`, the
 * TESTNET endpoint, regardless of NEAR_VAULT_NETWORK. An operator setting
 * `NEAR_VAULT_NETWORK=mainnet` and nothing else queried testnet about a
 * mainnet vault and got "account usefloat.near does not exist while viewing" —
 * which names the account, not the chain, and reads as "your factory is gone".
 *
 * THE DEPLOYED COPY MASKED IT: deploy-skill-host.sh sets NEAR_VAULT_RPC_URL
 * explicitly, so the box worked while every hand-run instance failed. A
 * default that is only ever correct because something else overrides it is a
 * trap with one authorised path around it.
 */
describe("the adapter's RPC follows the configured network", () => {
  const resolve = (network: string, override?: string) =>
    rpcForNetwork(network, { configuredNetwork: network, override });

  it("uses the mainnet endpoint for mainnet", () => {
    expect(resolve("mainnet")).toBe(RPC_BY_NETWORK.mainnet);
    // The regression specifically: it must not be the testnet default.
    expect(resolve("mainnet")).not.toBe(RPC_BY_NETWORK.testnet);
  });

  it("uses the testnet endpoint for testnet", () => {
    expect(resolve("testnet")).toBe(RPC_BY_NETWORK.testnet);
  });

  it("still honours an explicit override, which operators rely on", () => {
    expect(resolve("mainnet", "https://my.node.example")).toBe("https://my.node.example");
  });

  it("does not hardcode the testnet URL as a fallback any more", () => {
    // Reads the SOURCE: the bug was a literal, and a behavioural test on
    // rpcForNetwork stays green while the call site still carries one.
    const src = readFileSync(resolve_(import.meta.dirname, "server.ts"), "utf8");
    expect(
      /rpcUrl:\s*process\.env\.NEAR_VAULT_RPC_URL\s*\?\?\s*"https:\/\/test/.test(src),
      "the hardcoded testnet fallback is back",
    ).toBe(false);
  });
});

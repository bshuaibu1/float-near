import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

/**
 * Drives the BUILT server over real stdio MCP.
 *
 * Typecheck cannot see a duplicate tool name, a malformed schema, or a tool
 * that fails to register — those only surface when the server actually starts
 * and answers `tools/list`. This also pins the trust boundary: exactly one
 * tool signs, and it is the one restricted to `request_payment`.
 *
 * No network and no key: the server must start and list its tools with
 * nothing configured beyond the contract id.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, "../dist/server.js");
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { version: string };

interface Tool {
  name: string;
  description?: string;
}

let tools: Tool[] = [];
let serverInfo: { name?: string; version?: string } = {};

async function listTools(): Promise<Tool[]> {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, NEAR_VAULT_CONTRACT: "vault.testnet", NEAR_VAULT_TOKEN: "usdc.testnet" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  });

  return await new Promise<Tool[]>((ok, bad) => {
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      bad(new Error(`server did not answer tools/list in 20s. stderr:\n${stderr}`));
    }, 20_000);

    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("exit", (code) => {
      if (tools.length === 0) {
        clearTimeout(timer);
        bad(new Error(`server exited (${code}) before listing tools. stderr:\n${stderr}`));
      }
    });

    child.stdout.on("data", (d) => {
      buf += String(d);
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let msg: {
          id?: number;
          result?: { tools?: Tool[]; serverInfo?: { name?: string; version?: string } };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // partial line; the next chunk completes it
        }
        if (msg.id === 1) {
          // The handshake's own payload, which this harness used to discard.
          // It is the only place the server's advertised identity appears, and
          // it is what a user sees in their client's server list.
          serverInfo = msg.result?.serverInfo ?? {};
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          child.kill();
          ok(msg.result.tools);
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
  });
}

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error(`run \`npm run build\` first — ${SERVER} is missing`);
  tools = await listTools();
}, 40_000);

describe("the MCP server starts and registers its tools", () => {
  it("answers tools/list with no key configured", () => {
    // Reads and planning must work with zero secrets; only paying needs a key.
    expect(tools.length).toBeGreaterThan(0);
  });

  it("registers every expected tool", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "vault_budget",
        "vault_pending_approval",
        "vault_plan_approve_payment",
        "vault_plan_reject_payment",
        "vault_plan_set_approval_threshold",
        "vault_config",
        "vault_pay",
        "vault_plan_add_node",
        "vault_plan_bind_agent",
        "vault_plan_unbind_agent",
        "vault_plan_freeze",
        "vault_plan_pause",
        "vault_plan_purge",
        "vault_plan_set_caps",
        "vault_plan_set_cooldown",
        "vault_plan_set_recipients",
        "vault_request",
        "vault_tree",
        "vault_create",
      ].sort(),
    );
  });

  it("has no duplicate tool names", () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // THE trust boundary, asserted rather than described. Exactly one tool
  // signs. Everything that changes policy emits an unsigned payload, which is
  // what keeps this server out of the trust path.
  it("exposes exactly ONE signing tool", () => {
    // This used to filter out vault_plan_* and then assert vault_pay appeared
    // once -- which is satisfied by vault_pay EXISTING, and would pass just as
    // happily with a second signing tool beside it. A weak assertion under a
    // strong name, on the single most important property of this server.
    //
    // Now every tool must be classified. A new tool that is neither a known
    // read nor a vault_plan_* fails here until someone decides, deliberately,
    // which side of the trust boundary it belongs on.
    const READS = new Set([
      "vault_tree",
      "vault_budget",
      "vault_request",
      "vault_config",
      "vault_pending_approval",
    ]);
    // ONBOARDING: reads the factory and returns a URL for the USER's wallet to
    // approve. Holds no key and signs nothing, so it sits on the read side of
    // the boundary — but it is listed separately rather than folded into READS
    // because it is the one tool that talks to someone with no vault, and that
    // deserves to be visible here rather than hidden in a set named "reads".
    const ONBOARDING = new Set(["vault_create"]);
    const unclassified = tools
      .map((t) => t.name)
      .filter(
        (n) =>
          n !== "vault_pay" &&
          !n.startsWith("vault_plan_") &&
          !READS.has(n) &&
          !ONBOARDING.has(n),
      );
    expect(unclassified).toEqual([]);

    // And the signer is present, exactly once.
    expect(tools.filter((t) => t.name === "vault_pay")).toHaveLength(1);
  });

  it("describes every owner action as unsigned", () => {
    for (const t of tools.filter((t) => t.name.startsWith("vault_plan_"))) {
      expect(t.description ?? "").toMatch(/unsigned|not signed/i);
    }
  });

  // The name a user actually sees. A client lists its MCP servers by
  // serverInfo.name, so this string -- not the package name, not the config
  // key -- is the product's label in the one place the product is visible.
  // It said "near-vault", which is the repo directory.
  it("identifies itself as float", () => {
    expect(serverInfo.name).toBe("float");
  });

  it("advertises the package's own version, not a hardcoded one that can drift", () => {
    // server.ts carries the version as a literal, so it silently goes stale the
    // first time package.json is bumped and a client then reports the wrong
    // version forever. Pinned here so the bump has to move both.
    expect(serverInfo.version).toBe(pkg.version);
  });

  it("offers no path to the test clock", () => {
    for (const t of tools) {
      expect(t.name).not.toMatch(/day_len|clock/i);
      expect(t.description ?? "").not.toMatch(/set_day_len/i);
    }
  });
});

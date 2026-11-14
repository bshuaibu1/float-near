import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { KeyPair } from "near-api-js";

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
let instructions = "";

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
          // The instructions block, which this harness also used to discard.
          // It is injected into the client's system prompt and is the only
          // place the server explains what the product IS, as opposed to what
          // each call does.
          instructions = msg.result?.instructions ?? "";
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
        "vault_plan_withdraw",
        "vault_plan_set_caps",
        "vault_plan_set_cooldown",
        "vault_plan_set_recipients",
        "vault_request",
        "vault_teardown_report",
        "vault_tree",
        "vault_create",
        "vault_add_role",
        "vault_roles",
        "vault_gas",
        "vault_await_create",
        "vault_plan_set_strict_allocation",
        "vault_history",
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
      /**
       * Reads gas-key balances and QUOTES what a top-up would cost or buy. It
       * signs nothing and holds no key.
       *
       * It cannot be a plan tool either, and that is the interesting part: a
       * top-up is `transferToGasKey`, an action on the VAULT account, so it
       * needs a full-access key OF the vault — and wallets ignore `signerId`,
       * signing as the connected account while reporting success. So there is
       * no payload a user could approve in a wallet. It hands over a CLI
       * command instead, exactly as `vault_teardown_report` does.
       */
      "vault_gas",
      "vault_tree",
      "vault_budget",
      "vault_request",
      "vault_config",
      "vault_pending_approval",
      // Lists which agents this server can sign AS, by role. Returns no key
      // material — only role, node and account id.
      "vault_roles",
      /**
       * A READ, and the name was changed to say so.
       *
       * It was first called `vault_teardown_plan`, which this gate rejected —
       * correctly. `vault_plan_*` promises an unsigned PAYLOAD, and this
       * returns a report: what closing the vault would give back, what it
       * would strand, and the command. View calls only, no key, nothing
       * written, nothing signed.
       *
       * The point of it is to answer "can I close this and what do I get
       * back?" WITHOUT anyone exporting a key first — so it being a pure
       * read is the feature, not an implementation detail.
       */
      /**
       * The activity feed. View calls only, no key, nothing signed.
       *
       * Its caveat travels WITH the data rather than in a doc: a refused
       * payment is never stored by the contract, so an empty feed means
       * "nothing was paid", not "nothing was attempted".
       */
      "vault_history",
      "vault_teardown_report",
      /**
       * Polls for a newly created vault and VERIFIES THE OWNER. View calls
       * only, no key, nothing signed.
       *
       * A read even though it is part of a write flow, and the distinction
       * matters: the signature happened in the user's own wallet, on the
       * create page. This only looks at the result. It exists so the agent
       * stops asking the user to read back an account id it already derived.
       *
       * Its reason for existing is the owner comparison, not the polling.
       * `derive_prefix` is not injective, so an account AT the derived id can
       * belong to whoever created first — reporting "live" on existence alone
       * would point a user's agent at a stranger's money. Three outcomes:
       * LIVE, NOT_YOURS, UNVERIFIED.
       */
      "vault_await_create",
    ]);
    // PROVISIONING: generates an AGENT's keypair locally, writes the secret
    // to the keyring, and returns an UNSIGNED payload for the owner's wallet.
    //
    // A third category on purpose. These are not reads — they write key
    // material to disk — and they are not `vault_plan_*`, because that prefix
    // promises a pure function of its arguments. But they do not sign, and
    // the key they create is an AGENT's: restricted to `request_payment` on
    // one vault, bounded by the budget tree, unable to attach a deposit. The
    // owner's key still never comes near this server, which is the property
    // the whole boundary exists to protect.
    //
    // `vault_create` moved here from a set that described it as holding no
    // key. That stopped being true when it gained `bindAgent`.
    const PROVISIONING = new Set(["vault_create", "vault_add_role"]);
    const unclassified = tools
      .map((t) => t.name)
      .filter(
        (n) =>
          n !== "vault_pay" &&
          !n.startsWith("vault_plan_") &&
          !READS.has(n) &&
          !PROVISIONING.has(n),
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

  /**
   * THE INSTRUCTIONS BLOCK IS WHY AN AGENT UNDERSTANDS THE PRODUCT.
   *
   * It had none until 2026-11-08. A client got 23 tool descriptions, which say
   * what each CALL does and nothing about what Float IS, when to reach for it,
   * or which trust lane a task belongs in. The field is injected into the
   * client's system prompt, so servers that set it feel like the agent already
   * knows the project — the difference the owner noticed between this and
   * agentcash, which ships a workflow there.
   *
   * Asserted on CONTENT, not just presence. An empty string, or a line of
   * boilerplate, would satisfy "is it set" while telling a model nothing.
   * Each clause below is something a tool schema cannot express.
   */
  it("ships instructions that say what a tool list cannot", () => {
    const text = instructions;

    expect(text.length, "no instructions; the client sees only tool schemas").toBeGreaterThan(500);

    // The trust model. A plan tool RETURNS A PAYLOAD; calling one is not doing
    // the thing, and an agent reporting "done" after planning is the failure
    // this sentence exists to prevent.
    expect(text).toMatch(/never signs/i);
    expect(text).toMatch(/UNSIGNED PAYLOAD/i);

    // The distinction the whole hierarchy exists for. A model that cannot tell
    // these apart will retry a payment that a sibling made impossible.
    expect(text).toMatch(/PARENT_DAILY_BUDGET/);
    expect(text).toMatch(/DAILY_BUDGET/);

    // The two things users discover painfully otherwise.
    expect(text).toMatch(/implicit account/i);
    expect(text).toMatch(/float-exit/);

    // Never ask for a key: the product exists so nobody has to hand one over.
    expect(text).toMatch(/private key or seed phrase/i);
  });

  it("offers no path to the test clock", () => {
    for (const t of tools) {
      expect(t.name).not.toMatch(/day_len|clock/i);
      expect(t.description ?? "").not.toMatch(/set_day_len/i);
    }
  });
});

// =====================================================================
// NEAR_VAULT_AGENT_KEY_FILE, against the REAL entry point
// =====================================================================

/**
 * Drives the BUILT server with nothing injected, because the thing being
 * tested here is the WIRING.
 *
 * `resolveKeySource` has its own unit tests and they would stay green if
 * server.ts never called it — a correct module reached by nothing. The config
 * block is module-level code in a file that starts a stdio server, so the only
 * honest way to assert it runs is to run it.
 *
 * It also pins the one rule this file's startup logging can break: STDOUT IS
 * THE JSON-RPC TRANSPORT. There is no other `console.*` call in server.ts, so a
 * warning printed to stdout would be the first, and it would corrupt the stream
 * — the client would report a protocol error and say nothing about the
 * configuration problem the warning was describing.
 */
async function startWith(extraEnv: Record<string, string>) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NEAR_VAULT_CONTRACT: "vault.testnet",
      NEAR_VAULT_TOKEN: "usdc.testnet",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    }) + "\n",
  );

  // Long enough for startup logging and the handshake reply to arrive.
  await new Promise((r) => setTimeout(r, 2500));
  child.kill();
  return { stdout, stderr };
}

describe("a key file given to the real server", () => {
  const dirs: string[] = [];
  /** A throwaway keypair. Nothing here is read from the real config files. */
  const secretIn = (name: string, body: string) => {
    const d = mkdtempSync(join(tmpdir(), "float-smoke-"));
    dirs.push(d);
    const p = join(d, name);
    writeFileSync(p, body);
    return p;
  };
  afterAll(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it(
    "prefers the file, warns on STDERR, and leaves stdout pure JSON-RPC",
    async () => {
      const fileSecret = KeyPair.fromRandom("ed25519").toString();
      const inlineSecret = KeyPair.fromRandom("ed25519").toString();
      const path = secretIn(
        "agent.json",
        JSON.stringify({ account_id: "vault.testnet", private_key: fileSecret }),
      );

      const { stdout, stderr } = await startWith({
        NEAR_VAULT_AGENT_ID: "vault.testnet",
        NEAR_VAULT_AGENT_KEY: inlineSecret,
        NEAR_VAULT_AGENT_KEY_FILE: path,
      });

      // The warning reached the operator...
      expect(stderr).toContain("NEAR_VAULT_AGENT_KEY_FILE");
      expect(stderr).toMatch(/NEAR_VAULT_AGENT_KEY is ignored/);

      // ...on stderr, and NOT on the transport. Every stdout line must still
      // be a JSON-RPC message; one line of prose breaks the client.
      const lines = stdout.split("\n").filter((l) => l.trim());
      expect(lines.length, "server produced no stdout at all").toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line), `non-JSON on stdout: ${line.slice(0, 80)}`).not.toThrow();
      }

      // AND NEITHER STREAM CARRIES A KEY. This is the entire point of the
      // change: a startup line that echoed the value it had just loaded would
      // put a live private key in the client's log file forever.
      for (const [name, stream] of [["stdout", stdout], ["stderr", stderr]] as const) {
        expect(stream, `${name} leaked the file's key`).not.toContain(fileSecret);
        expect(stream, `${name} leaked the inline key`).not.toContain(inlineSecret);
        expect(stream).not.toContain(fileSecret.slice(8, 24));
        expect(stream).not.toContain(inlineSecret.slice(8, 24));
      }
    },
    20_000,
  );

  /**
   * WHAT THIS PINS, AND WHAT IT DOES NOT.
   *
   * It pins that an inline-only config — what `.mcp.json` has today — produces
   * NO warning and NO error. That is a regression in its own right if it
   * breaks: a client which surfaces stderr would start reporting a problem to
   * every existing user who has nothing wrong.
   *
   * It does NOT prove the inline key is actually loaded. Nothing this server
   * emits distinguishes "key loaded" from "no key", so replacing the inline
   * read with `undefined` leaves this test green — checked, not assumed. The
   * adapter's smoke test carries that half, where a credential that fails to
   * load produces an observable 400 from `selectAgent`.
   */
  it(
    "warns about nothing when the configuration is inline-only",
    async () => {
      const inlineSecret = KeyPair.fromRandom("ed25519").toString();
      const { stdout, stderr } = await startWith({
        NEAR_VAULT_AGENT_ID: "vault.testnet",
        NEAR_VAULT_AGENT_KEY: inlineSecret,
      });

      // Nothing to warn about, and nothing to report as broken.
      expect(stderr).not.toMatch(/NEAR_VAULT_AGENT_KEY_FILE/);
      expect(stderr).not.toMatch(/ignored|could not be read/i);
      expect(stdout + stderr).not.toContain(inlineSecret);

      // And it still started.
      const ids = stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { id?: number });
      expect(ids.some((m) => m.id === 1), "server never answered initialize").toBe(true);
    },
    20_000,
  );

  it(
    "still starts, and says why, when the key file is unreadable",
    async () => {
      // The server must stay usable with no key: reads, payload planning and
      // `vault_create` need none, and onboarding someone who has no vault yet
      // is why this server runs with nothing configured.
      const { stdout, stderr } = await startWith({
        NEAR_VAULT_AGENT_KEY_FILE: join(tmpdir(), "float-smoke-absent", "nope.json"),
      });

      expect(stderr).toContain("nope.json");
      expect(stderr).toMatch(/does not exist/i);
      // Started anyway: the handshake was answered.
      const ids = stdout
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { id?: number });
      expect(ids.some((m) => m.id === 1), "server never answered initialize").toBe(true);
    },
    20_000,
  );
});

/**
 * THE SERVER MUST ACTUALLY USE THE NETWORK-AWARE RESOLVER.
 *
 * `rpc.test.ts` proves `rpcForNetwork` returns the right endpoint. That test
 * stays GREEN if someone reverts `cfg.rpcUrl` to the old constant, because it
 * never looks at the wiring — and the wiring was the bug. Correctness of a
 * helper and reachability of a helper are different claims.
 *
 * A source assertion rather than a boot-and-read, because the resolved value
 * lives in a module-scope const inside a process that owns stdout for JSON-RPC.
 * Crude, and it pins the one line that broke every mainnet install.
 */
describe("cfg.rpcUrl is derived from the network, not hardcoded", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "server.ts"),
    "utf8",
  );

  it("does not fall back to a fixed DEFAULT_RPC_URL", () => {
    // The exact regressed form. `DEFAULT_RPC_URL` is the TESTNET endpoint, so
    // this line sent every mainnet read to the wrong chain and answered
    // "account does not exist" about a funded vault.
    expect(
      /rpcUrl:\s*process\.env\.NEAR_VAULT_RPC_URL\s*\?\?\s*DEFAULT_RPC_URL/.test(src),
      "cfg.rpcUrl is back to the hardcoded testnet default",
    ).toBe(false);
  });

  it("resolves through rpcForNetwork", () => {
    expect(/rpcUrl:\s*rpcForNetwork\(/.test(src)).toBe(true);
  });
});

/**
 * THE AGENT'S OWN HISTORY KEEPS THE MEMOS.
 *
 * The public dashboard redacts them (see float-adapter/src/map.ts): it is
 * keyless and multi-tenant, so anyone typing a vault name could read what a
 * company paid FOR. This server is different — it runs on the owner's own
 * machine, with their own config, for their own agent.
 *
 * The split holds for a STRUCTURAL reason worth pinning rather than trusting:
 * `vault_history` calls `list_requests` DIRECTLY against the chain and never
 * passes through the adapter, so there is no path by which the adapter's
 * redaction could reach it. If someone ever routes this tool through the
 * adapter for convenience, the agent silently loses context and nothing else
 * would notice.
 */
describe("vault_history reads the chain directly, so memos survive", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");
  const tool = src.slice(src.indexOf('"vault_history"'), src.indexOf('"vault_request"'));

  it("calls list_requests on the vault, not an adapter", () => {
    expect(tool).toMatch(/viewFunction[\s\S]{0,120}"list_requests"/);
    expect(tool).not.toMatch(/adapter|API_BASE_URL|localhost:8787/i);
  });

  it("maps the memo through to the caller", () => {
    // Present AND conditional: a payment without one must not carry an empty
    // `memo` key, which would read as "the memo was blank" rather than absent.
    expect(tool).toMatch(/r\.memo \? \{ memo: r\.memo \} : \{\}/);
  });
});
/**
 * THE TEARDOWN COMMAND MUST ACTUALLY RUN, and must carry the guard.
 *
 * `vault_teardown_report` is the first thing someone asks when closing a
 * vault, so every defect in what it emits lands on a person deleting an
 * account holding real money. It had three:
 *
 *   NO CONFIRM_MAINNET   teardown-vault.mjs exits 2 on mainnet without it, so
 *                        the emitted command could not work at all
 *   NO EXPECT_TOKENS     the script's own guard against its worst documented
 *                        failure — a WRONG token id reads as a zero balance,
 *                        prints "no tokens to withdraw", and the delete
 *                        strands the real USDC at an address nobody can ever
 *                        sign for
 *   BASH SYNTAX ONLY     `VAR=x node ...` silently sets nothing in PowerShell
 *
 * Asserted against the SOURCE because the command is assembled from live
 * chain reads; a runtime test would need a funded mainnet vault to be
 * meaningful, and the thing worth pinning is that the builder cannot omit
 * these.
 */
describe("the teardown command the report hands out", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");
  const builder = src.slice(
    // THE EMITTED EXPRESSION, not the doc comment above it. The first
    // version sliced from the comment and asserted the block does not
    // mention `teardown-vault.mjs` -- which it does, legitimately, because
    // the comment EXPLAINS why it stopped pointing there. A check that
    // cannot tell code from prose fails on an accurate sentence and
    // teaches you to delete documentation to keep it quiet.
    src.indexOf("command: signable", src.indexOf("POINT AT THE USER-FACING CLI")),
    // A marker with NO escapes in it. Generating a JS string escape through
    // another language is how this file failed to parse twice; the shortest
    // unique literal that needs no escaping is the safest slice point.
    src.indexOf("Read-only. This server holds at most"),
  );

  /**
   * IT MUST POINT AT THE PUBLISHED CLI, not the repo's internal script.
   *
   * It emitted `NETWORK=… VAULT=… OWNER=… TOKEN=… CONFIRM_MAINNET=1
   * EXPECT_TOKENS=1 node scripts/teardown-vault.mjs` — six env vars, a path
   * only someone who cloned the repo has, and no dry run, for the one action
   * a user takes when they are already nervous.
   *
   * `float-exit` ships for exactly this: two flags, `--dry-run`, numbered
   * steps, and an explicit irreversibility warning.
   */
  it("uses float-exit, not the internal teardown script", () => {
    expect(builder).toMatch(/float-exit/);
    expect(builder).not.toMatch(/teardown-vault\.mjs/);
    expect(builder).not.toMatch(/CONFIRM_MAINNET=|EXPECT_TOKENS=/);
  });

  it("leads with the DRY RUN, so copying the first thing cannot delete a vault", () => {
    const first = builder.indexOf("first_look");
    const real = builder.indexOf("then_for_real");
    expect(first).toBeGreaterThan(-1);
    expect(real).toBeGreaterThan(first);
    expect(builder).toMatch(/--dry-run/);
  });

  it("uses `npx -p <pkg> <bin>`, since the bare form 404s", () => {
    // float-exit is a BIN of create-float. `npx @floatonnear/float-exit` is
    // not a package and never resolves.
    expect(builder).toMatch(/npx -p @floatonnear\/create-float float-exit/);
  });

  it("passes --network only when it is not the CLI's default", () => {
    // float-exit defaults to mainnet, so passing it there is noise on the one
    // command a nervous user reads character by character.
    expect(builder).toMatch(/cfg\.network === "mainnet" \? "" :/);
  });
});

/**
 * `vault_await_create` MUST NOT CALL A FACTORY A LIVE VAULT.
 *
 * The factory exports `get_config` too, and it returns an `owner`. So pointing
 * the tool at `usefloat.near` with that factory's own owner returned **LIVE**,
 * and the nextSteps it printed told the user to
 * `Set NEAR_VAULT_CONTRACT=usefloat.near` — after which every read would ask a
 * factory for budgets it does not have. Measured on mainnet 2026-11-12.
 *
 * The discriminator is `vault_id`: a vault's config carries it, the factory's
 * does not. Pinned at source for the same reason as the block above — the
 * decision lives inside a tool handler in a process that owns stdout for
 * JSON-RPC, and the live check that found this needs the network.
 *
 * Two separate claims, because the ORDER matters: "not a vault" must be
 * answered before "not your vault", or a factory gets reported as somebody
 * else's vault and the user goes looking for a rival owner who does not exist.
 */
describe("vault_await_create distinguishes a vault from any other contract", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");

  it("requires vault_id before reporting LIVE", () => {
    expect(
      /typeof config\.vault_id !== "string"/.test(src),
      "the vault_id discriminator is gone — a factory will read as LIVE again",
    ).toBe(true);
  });

  it("checks not-a-vault BEFORE comparing the owner", () => {
    const vaultIdCheck = src.indexOf('typeof config.vault_id !== "string"');
    const ownerCheck = src.indexOf("config.owner !== owner");
    expect(vaultIdCheck).toBeGreaterThan(-1);
    expect(ownerCheck).toBeGreaterThan(-1);
    expect(
      vaultIdCheck < ownerCheck,
      "the owner comparison now runs first, so a factory is reported NOT_YOURS",
    ).toBe(true);
  });
});

/**
 * THE NO-VAULT ERROR MUST ROUTE TO `vault_create`, not just report a unset env var.
 *
 * It said "NEAR_VAULT_CONTRACT is not set" — true, and a dead end. Measured
 * 2026-11-12: an agent asked to pay someone hit that, concluded the NEAR rail
 * was unavailable, searched three unrelated wallets for something that could
 * reach a `.near` address, and ended by asking the user to paste a contract
 * id. It never offered to CREATE a vault, because the error did not say that
 * was possible without one.
 *
 * The WORKFLOW preamble already said "No vault yet? vault_create" and that was
 * not enough: at the moment of failure an agent reads the ERROR, not the
 * instructions it was given at startup. So the routing has to be in the
 * message.
 *
 * Source-pinned, like the rpcUrl block above: the string lives in a
 * module-scope helper inside a process that owns stdout for JSON-RPC.
 */
describe("the no-vault error is an onramp, not a dead end", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");
  const helper = src.slice(src.indexOf("function requireVault"), src.indexOf("function tokenFor"));

  it("names vault_create", () => {
    expect(helper).toMatch(/vault_create/);
  });

  it("says no key is needed, which is the part that unblocks a cold start", () => {
    expect(helper).toMatch(/no\s*key/i);
  });

  it("covers the other case too — a vault that exists but is not configured", () => {
    expect(helper).toMatch(/NEAR_VAULT_CONTRACT/);
  });

  it("is not the bare unset-variable message it used to be", () => {
    // The exact regressed form.
    expect(
      /throw new Error\("NEAR_VAULT_CONTRACT is not set"\)/.test(src),
      "the no-vault error is back to naming an env var and nothing else",
    ).toBe(false);
  });
});

/**
 * THE OPERATING GUIDE MUST BE DELIVERABLE TO A REAL USER.
 *
 * SKILL.md is ~34 KB: the refusal vocabulary, the teardown ORDER that decides
 * whether an agent's gas is recovered or burned, which flows need a human
 * signature. `instructions` cannot carry it — that field goes into the
 * client's system prompt and has a budget measured in paragraphs.
 *
 * The depth WAS reaching us and not them. On a developer machine SKILL.md can
 * be installed as a Claude Code skill and loads on demand; a real user has no
 * repo to install from and most MCP clients have no skill mechanism at all.
 * A resource is the mechanism MCP already has: listed, read on demand, no
 * system-prompt cost until then, and it ships inside the package so it cannot
 * drift from the server being run.
 *
 * Source-pinned like the blocks above — registration happens at module scope
 * in a process that owns stdout for JSON-RPC. The end-to-end read is exercised
 * by hand against the built server; these pin the parts that would rot.
 */
describe("the operating guide ships as an MCP resource", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  );

  it("registers a resource at float://skill", () => {
    expect(src).toMatch(/registerResource\(/);
    expect(src).toMatch(/float:\/\/skill/);
  });

  it("is SHIPPED in the package, not read from a developer's checkout", () => {
    expect(pkg.files, "SKILL.md is not in package.files, so a published install has no guide")
      .toContain("SKILL.md");
  });

  it("the BUILD copies it, not only prepack", () => {
    // If only prepack copied it, a fresh clone would build a server whose
    // guide resource is missing, and only `npm publish` would fix that.
    expect(pkg.scripts.build).toMatch(/copyFileSync/);
  });

  it("resolves the guide relative to the module, not the cwd", () => {
    // A client starts the server from wherever it happens to be.
    expect(src).toMatch(/fileURLToPath\(import\.meta\.url\)/);
  });

  it("THROWS when the guide is absent rather than returning nothing", () => {
    // An empty resource reads as "there is no guidance" and the agent
    // proceeds. An error stops it.
    const block = src.slice(src.indexOf("float-guide"), src.indexOf("// ---") + 1);
    expect(block).toMatch(/throw new Error/);
  });

  it("the instructions TELL the agent the resource exists", () => {
    // A resource nothing mentions is a resource nothing reads.
    const instr = src.slice(src.indexOf("Float gives an AI agent"), src.indexOf("new McpServer"));
    expect(instr).toMatch(/float:\/\/skill/);
  });
});

/**
 * AFTER CREATION, THE NEXT STEP IS FUNDING — AND THE USER NEEDS THE ADDRESS.
 *
 * `vault_await_create`'s LIVE branch used a FIXED list of next steps ending
 * "nothing can spend from it until an agent is bound — vault_add_role". For a
 * vault created with `bindAgent` that is false: the agent is already bound and
 * the real gate is that the vault holds no tokens. Measured 2026-11-13 — the
 * agent relaying it had to correct the tool in front of the owner.
 *
 * Nothing told the owner HOW to fund it either, or that funding is a plain
 * wallet send, or what address to send to. That is the moment they need it:
 * they have just signed and the only thing between them and a working vault is
 * money.
 *
 * Source-pinned, like the blocks above: this is inline in a tool handler in a
 * process that owns stdout for JSON-RPC. Behaviour was verified by driving the
 * built server against the real mainnet vault.
 */
describe("vault_await_create tells the owner how to fund the vault", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");
  const live = src.slice(src.indexOf("WHAT ACTUALLY STOPS THIS VAULT PAYING"), src.indexOf('status: "LIVE"'));

  it("no longer asserts an agent must be bound regardless of state", () => {
    // The exact regressed sentence.
    expect(
      /Nothing can spend from it until an agent is bound/.test(src),
      "the fixed 'bind an agent' step is back; it is wrong for a vault created with bindAgent",
    ).toBe(false);
  });

  it("names funding and gives the address to send to", () => {
    expect(live).toMatch(/FUND IT/);
    expect(live).toMatch(/sendTo/);
  });

  it("tells the agent to ASK how much, rather than picking a figure", () => {
    expect(live).toMatch(/ASK how much/);
  });

  it("reads the token from the TREE, not from the configured env", () => {
    // At creation time NEAR_VAULT_CONTRACT is typically unset, so cfg.token
    // can be empty while the vault plainly names one in its root limits.
    expect(live).toMatch(/get_tree/);
  });

  it("names UNREGISTERED first, because that one makes a transfer FAIL", () => {
    expect(live).toMatch(/REGISTER IT FIRST/);
    expect(live).toMatch(/storage_balance_of/);
  });

  it("says the server cannot fund it, and why", () => {
    expect(live).toMatch(/cannot touch a token contract/);
  });
});

/**
 * `vault_roles` MUST CROSS-CHECK THE CHAIN. It used to report the local file.
 *
 * It returned `listAgents(cfg)` verbatim — role, nodeId and all — straight out
 * of the keyring, without asking the vault whether it had ever heard of those
 * keys. So a keyring pointed at the wrong directory reported a healthy,
 * signable agent on node 1 that the vault did not know, and `vault_pay` then
 * signed with it and came back NOT_VIRTUAL_AGENT.
 *
 * Measured 2026-11-13: that cost a user a full session of forensics — reading
 * .claude.json by hand, diffing two keyring files, checking gas balances — to
 * find one wrong path. The tool whose whole job is "which agents can I sign
 * as" was the one producing the false positive, which is exactly why nothing
 * caught it sooner.
 *
 * Verified against mainnet both ways while writing it: a fresh unbound key
 * reports DEAD with the cause, and the real keyring reports usable: 1 with the
 * node read from the chain.
 */
describe("vault_roles answers from the chain, not from the keyring file", () => {
  const src = readFileSync(resolve(import.meta.dirname, "server.ts"), "utf8");
  const block = src.slice(src.indexOf('"vault_roles"'), src.indexOf('"vault_create"'));

  it("asks the chain which node each key is bound to", () => {
    expect(block).toMatch(/get_virtual_agent_node/);
  });

  it("does not return listAgents verbatim any more", () => {
    // The exact regressed shape: mapping straight from the file to the output.
    expect(
      /listAgents\(cfg\)\.map\(\(r\) => \(\{\s*role: r\.role,\s*nodeId: r\.nodeId/.test(src),
      "vault_roles is reporting the keyring verbatim again",
    ).toBe(false);
  });

  it("has a DEAD status that names NOT_VIRTUAL_AGENT", () => {
    // The point is to connect the symptom a user WILL see to the cause.
    expect(block).toMatch(/DEAD/);
    expect(block).toMatch(/NOT_VIRTUAL_AGENT/);
  });

  it("warns loudly when NO key is usable", () => {
    // Silence here is what let the vault be unspendable for hours unnoticed.
    expect(block).toMatch(/NO USABLE AGENT/);
    expect(block).toMatch(/NEAR_VAULT_AGENT_KEYS/);
  });

  it("reports keys the VAULT has that this client cannot sign as", () => {
    expect(block).toMatch(/ON_CHAIN_BUT_NO_LOCAL_KEY/);
  });

  it("reports keyring entries the loader refuses to read", () => {
    // Previously dropped in silence, so "I have a key but this shows nothing"
    // was unanswerable.
    expect(block).toMatch(/unreadableKeyringEntries/);
  });

  it("distinguishes bound-but-no-gas-key from usable", () => {
    // Authorised and unable to submit is a real state, and it fails at the
    // first payment rather than at setup.
    expect(block).toMatch(/BOUND_BUT_NO_GAS_KEY/);
  });
});

/**
 * Call ONE tool on a freshly spawned server and return its text content.
 *
 * Separate from `listTools` because these tests care about the ENV each server
 * starts with — the keyring path in particular — and a shared long-lived
 * server would resolve it once for all of them.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string>,
): Promise<string> {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });

  return await new Promise<string>((ok, bad) => {
    let buf = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      bad(new Error(`no answer to ${name} in 25s. stderr:\n${stderr}`));
    }, 25_000);
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdout.on("data", (d) => {
      buf += String(d);
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { content?: { text?: string }[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          ok((msg.result?.content ?? []).map((c) => c.text ?? "").join("\n"));
        }
      }
      buf = buf.slice(buf.lastIndexOf("\n") + 1);
    });
  });
}

/**
 * A FAILED vault_add_role MUST LEAVE NOTHING BEHIND.
 *
 * Measured 2026-11-13: the handler generated and WROTE the agent's keypair,
 * and only then built the payload — which validates the token and the caps and
 * can throw. A call that failed validation therefore filed a real key under
 * the role name, bound to nothing. The user's retry was then refused with
 * "this vault already has an agent with the role 'travel'", blocked by the
 * wreckage of the attempt that had failed seconds earlier.
 *
 * This drives the REAL tool over the REAL protocol, because that is the only
 * level at which the ordering is observable: both the write and the throw are
 * internal to the handler, and every unit test of the pieces passed throughout.
 */
describe("a vault_add_role that fails validation writes nothing", () => {
  it("refuses an unknown token without creating a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "float-smoke-ring-"));
    const ring = join(dir, "agent-keys.json");

    // NO token argument and NO NEAR_VAULT_TOKEN — which is the exact shape of
    // the failure reported: `tokenFor` throws only when a token is MISSING.
    // An arbitrary string like "not-a-token-xyz" is a legal account id and
    // does NOT throw, so a test built on one proves nothing; this test asserted
    // exactly that at first and passed for the wrong reason.
    const out = await callTool(
      "vault_add_role",
      { role: "travel", dailyCap: "10", perTxCap: "2" },
      {
        NEAR_VAULT_CONTRACT: "vault.testnet",
        NEAR_VAULT_NETWORK: "testnet",
        NEAR_VAULT_AGENT_KEYS: ring,
      },
    );

    // It must actually have refused — otherwise "no file" proves nothing.
    expect(out).toMatch(/token/i);
    // And it must SAY nothing was written, because the next thing the user
    // does is retry, and silence here is what sent one digging through files.
    expect(out).toMatch(/[Nn]othing was written/);

    expect(existsSync(ring)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);

  /**
   * THE CONTROL. If the same call with a VALID token also wrote nothing, the
   * assertion above would pass for the wrong reason — a tool that is simply
   * broken, or a role name the schema rejects before any of this is reached.
   */
  it("control: the same call with a valid token DOES write a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "float-smoke-ring-ok-"));
    const ring = join(dir, "agent-keys.json");

    const out = await callTool(
      "vault_add_role",
      { role: "travel", dailyCap: "10", perTxCap: "2" },
      {
        NEAR_VAULT_CONTRACT: "vault.testnet",
        NEAR_VAULT_NETWORK: "testnet",
        NEAR_VAULT_TOKEN: "usdc.testnet",
        NEAR_VAULT_AGENT_KEYS: ring,
      },
    );

    expect(out).not.toMatch(/[Nn]othing was written/);
    expect(existsSync(ring)).toBe(true);
    const entries = JSON.parse(readFileSync(ring, "utf8")) as { role: string }[];
    expect(entries.map((e) => e.role)).toContain("travel");
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);

  /**
   * The keyring must land where the SERVER was told, not where it was started.
   * `NEAR_VAULT_AGENT_KEYS` is unset in the real `~/.claude.json` entry on this
   * machine, which is how a key written from one project became invisible from
   * another; this pins that an explicit path is honoured exactly.
   */
  it("writes to the configured keyring, not the working directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "float-smoke-ring-path-"));
    const ring = join(dir, "pinned-keys.json");

    await callTool(
      "vault_add_role",
      { role: "research", dailyCap: "10", perTxCap: "2" },
      {
        NEAR_VAULT_CONTRACT: "vault.testnet",
        NEAR_VAULT_NETWORK: "testnet",
        NEAR_VAULT_TOKEN: "usdc.testnet",
        NEAR_VAULT_AGENT_KEYS: ring,
      },
    );

    expect(existsSync(ring)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 40_000);
});

/**
 * THE UX CONTRACT, asserted against the REAL tools over the REAL protocol.
 *
 * `vault_pay` returned `say`/`next_step`/`money_moved` and every other tool
 * returned raw technical keys, so agents narrated the machine — public keys,
 * gas keys, unsigned payloads — to people who had asked for a budget. A unit
 * test on the formatter cannot catch that: the formatter was fine, it just was
 * not WIRED to most of the tools.
 *
 * These two tools are chosen because they need no network and no live vault:
 * `vault_plan_add_node` with `parent: null` skips the node-existence check, and
 * `vault_add_role` builds its payload offline against an empty keyring.
 */
describe("user-facing tools return the plain-English UX fields", () => {
  /** Circle-native mainnet USDC. Its account id is 64 hex characters. */
  const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

  const BASE = {
    NEAR_VAULT_CONTRACT: "vault.testnet",
    NEAR_VAULT_NETWORK: "testnet",
    NEAR_VAULT_TOKEN: "usdc.testnet",
  };

  /**
   * A RAW TOKEN ACCOUNT ID IN PROSE.
   *
   * Caught by driving the tool and READING the sentence, not by the jargon
   * list — "usdc.testnet" is not jargon, it is an address, and the list had no
   * entry that could match it. On mainnet it would have rendered as
   * "1 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 a day",
   * because Circle-native USDC's id is 64 hex characters.
   *
   * The lesson is the general one: a forbidden-WORD list cannot catch a
   * forbidden SHAPE. This matches the shape.
   */
  const looksLikeATokenId = (say: string) =>
    /[0-9a-f]{40,}/.test(say) || /\w+\.(?:testnet|near)/.test(say.replace(/to \S+\.(?:testnet|near)/g, ""));

  /** Every term SKILL.md forbids in user-facing text. */
  const JARGON = [
    "yocto",
    "reason_code",
    "NEP-611",
    "ed25519",
    "keyring",
    "NEAR_VAULT",
    "unsigned_payload",
    "RPC",
    "wasm",
  ];

  it("a plan tool leads with say / next_step / money_moved", async () => {
    const out = await callTool(
      "vault_plan_add_node",
      {
        parent: null,
        label: "news",
        // MAINNET USDC's real id: 64 hex characters. The original version of
        // this test used "usdc.testnet", which is short enough to look
        // harmless in a sentence — so it passed while the published tool was
        // printing a 64-character hash at users. Test the shape that bites.
        limits: [{ token: MAINNET_USDC, dailyCap: "1", perTxCap: "0.10" }],
      },
      { ...BASE, NEAR_VAULT_NETWORK: "mainnet", NEAR_VAULT_TOKEN: MAINNET_USDC },
    );
    const r = JSON.parse(out) as Record<string, unknown>;

    expect(typeof r.say).toBe("string");
    expect((r.say as string).length).toBeGreaterThan(20);
    expect(r.money_moved).toBe(false);
    expect(typeof r.next_step).toBe("string");
    expect(r.next_step as string).toMatch(/wallet/i);

    // A plan is a PROPOSAL. Saying otherwise is the specific lie to prevent.
    expect(r.say as string).toMatch(/Nothing has changed yet/i);

    // The technical detail still exists — moved, not deleted.
    expect(r.technical).toBeTruthy();
    expect(r.unsigned_payload).toBeTruthy();

    for (const bad of JARGON) {
      expect(r.say as string, `say leaked "${bad}"`).not.toContain(bad);
    }
    // THE GAP THAT LET A LEAK SHIP: this shape check was applied to
    // vault_add_role and not here, so the plan tools went unchecked.
    expect(r.say as string).not.toContain(MAINNET_USDC);
    expect(
      looksLikeATokenId(r.say as string),
      `say contains a raw token id: ${r.say as string}`,
    ).toBe(false);
    expect(r.say as string).toMatch(/USDC/);

    /**
     * NO TREE VOCABULARY IN THE SENTENCE.
     *
     * "node 1" is the contract's primary key. It is correct in `args`, in
     * `technical`, and in the payload a wallet signs, and it means nothing to
     * someone who called the budget "news". This is the assertion that stops
     * it coming back the next time a summary is edited in `payloads.ts`.
     */
    expect(
      r.say as string,
      `say contains tree vocabulary: ${r.say as string}`,
    ).not.toMatch(/node\s*\d+/i);

    // The id is still exact where it is USEFUL, rather than deleted.
    expect(JSON.stringify(r.technical)).toContain(MAINNET_USDC);
  }, 40_000);

  it("vault_add_role describes the BUDGET, not the keypair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "float-ux-ring-"));
    const out = await callTool(
      "vault_add_role",
      { role: "news", dailyCap: "1", perTxCap: "0.10" },
      { ...BASE, NEAR_VAULT_AGENT_KEYS: join(dir, "agent-keys.json") },
    );
    const r = JSON.parse(out) as Record<string, unknown>;
    const say = r.say as string;

    // The caps the caller named, in the units they used.
    expect(say).toContain("1");
    expect(say).toContain("0.10");
    expect(say).toMatch(/news/);
    expect(say).toMatch(/approve/i);
    expect(r.money_moved).toBe(false);

    // The public key and keyring path are still returned for the agent...
    expect((r.agent as Record<string, unknown>).publicKey).toBeTruthy();
    // ...but must not be in what the user hears.
    for (const bad of JARGON) {
      expect(say, `say leaked "${bad}"`).not.toContain(bad);
    }
    expect(say).not.toContain("ed25519:");
    // The SHAPE check: no contract address standing in for a token symbol.
    expect(looksLikeATokenId(say), `say contains a raw token id: ${say}`).toBe(false);
    // And it must name the token in words a person recognises.
    expect(say).toMatch(/USDC|tokens/);

    rmSync(dir, { recursive: true, force: true });
  }, 40_000);

  /**
   * THE SKILL ASSERTION the UX lock asked for: the agent-facing instructions
   * must tell an agent to use `say` on a refusal, and must say the code is not
   * for the user. Without this the rule lives only in a doc the client may
   * never fetch — `instructions` is injected into the system prompt, so it is
   * the one place guaranteed to be read.
   */
  it("the server instructions require say on a BLOCKED outcome", () => {
    expect(instructions).toMatch(/say/);
    expect(instructions).toMatch(/money_moved/);
    expect(instructions).toMatch(/next_step/);
    // It must name the refusal case explicitly, not just the happy path.
    expect(instructions).toMatch(/BLOCKED|refus/i);
    // And it must forbid showing the code.
    expect(instructions).toMatch(/NEVER SHOW A REASON CODE|reason code/i);
  });
});

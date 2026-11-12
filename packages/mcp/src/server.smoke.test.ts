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

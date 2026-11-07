import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Drives the BUILT adapter with nothing injected.
 *
 * `resolveKeySource` and `loadKeyring` both have thorough unit tests, and every
 * one of them would stay green if server.ts never connected the two — a pair of
 * correct modules with nothing between them. The config block is top-level code
 * in a file that binds a socket, so the only honest way to assert it runs is to
 * run it.
 *
 * What this pins that no unit test can:
 *
 *   1. NEAR_VAULT_AGENT_KEY_FILE is read at all.
 *   2. A file that cannot be read does NOT fall back to the inline
 *      NEAR_VAULT_AGENT_KEY. Falling back is the dangerous outcome: the
 *      operator would believe the secret had moved out of their config while
 *      the config was silently still the thing being used.
 *   3. The refusal names the FILE, not "set NEAR_VAULT_AGENT_ID and
 *      NEAR_VAULT_AGENT_KEY" — which would read as advice to paste the key
 *      back inline.
 *   4. No startup line carries a key.
 *
 * No network: `selectAgent` runs before any RPC on this route, and the chain
 * follower is switched off with BLOCKED_FOLLOW=0.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, "../dist/server.js");

/** A throwaway ed25519-shaped secret. Never read from the real config. */
function throwawaySecret(): string {
  // Shape only — this is never used to sign. Generated so the leak assertions
  // below are testing against a value that is genuinely unique to this run.
  const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 64; i++) s += b58[Math.floor(Math.random() * b58.length)];
  return `ed25519:${s}`;
}

const dirs: string[] = [];
const kids: ChildProcess[] = [];

afterAll(() => {
  for (const k of kids) k.kill();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Started {
  port: number;
  stdout: () => string;
  stderr: () => string;
}

async function startAdapter(extraEnv: Record<string, string>): Promise<Started> {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NEAR_VAULT_CONTRACT: "vault.testnet",
      NEAR_VAULT_TOKEN: "usdc.testnet",
      FLOAT_API_TOKEN: "smoke-token",
      // Ephemeral port: the real address is read back out of the startup log,
      // so this cannot collide with a developer's running adapter.
      PORT: "0",
      HOST: "127.0.0.1",
      // The chain follower would otherwise make real RPC calls.
      BLOCKED_FOLLOW: "0",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  kids.push(child);

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));

  const port = await new Promise<number>((ok, bad) => {
    const timer = setTimeout(
      () => bad(new Error(`adapter never reported a port.\nstdout:\n${out}\nstderr:\n${err}`)),
      15_000,
    );
    const check = setInterval(() => {
      const m = /listening on http:\/\/[^\s:]+:(\d+)/.exec(out);
      if (m) {
        clearInterval(check);
        clearTimeout(timer);
        ok(Number(m[1]));
      }
    }, 50);
    child.on("exit", (code) => {
      clearInterval(check);
      clearTimeout(timer);
      bad(new Error(`adapter exited (${code}) before listening.\nstderr:\n${err}`));
    });
  });

  return { port, stdout: () => out, stderr: () => err };
}

async function pay(port: number, body: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/pay`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer smoke-token" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as { error?: string } };
}

describe("the adapter reads NEAR_VAULT_AGENT_KEY_FILE", () => {
  it(
    "refuses to pay with the inline key when the named file is unreadable",
    async () => {
      if (!existsSync(SERVER)) throw new Error(`run \`npm run build\` first — ${SERVER} is missing`);

      const inlineSecret = throwawaySecret();
      const missing = join(tmpdir(), "float-adapter-smoke-absent", "agent.json");

      const s = await startAdapter({
        NEAR_VAULT_AGENT_ID: "vault.testnet",
        NEAR_VAULT_AGENT_KEY: inlineSecret,
        NEAR_VAULT_AGENT_KEY_FILE: missing,
      });

      const { status, json } = await pay(s.port, { amount: "1", recipient: "bob.testnet" });

      expect(status).toBe(400);
      // Names the real cause...
      expect(json.error).toContain("agent.json");
      expect(json.error).toMatch(/NEAR_VAULT_AGENT_KEY_FILE/);
      // ...and NOT the message that tells the operator to paste the key inline.
      expect(json.error, "degraded into the generic message").not.toMatch(
        /no agent credentials are configured/i,
      );
      // THE LOAD-BEARING ASSERTION: a 400 proves the inline key was not used
      // as a silent fallback. Had it been, this request would have gone to
      // chain instead.
      expect(s.stdout() + s.stderr()).not.toContain(inlineSecret);
    },
    30_000,
  );

  /**
   * THE NO-BREAKING-CHANGE CLAIM, at the boundary where it is observable.
   *
   * `.float/adapter.env` sets NEAR_VAULT_AGENT_KEY inline today. The MCP
   * server's equivalent test can only assert that nothing WARNS — it has no
   * way to see whether the key was loaded — whereas here a credential that
   * failed to load produces a 400 from `selectAgent` before any network call.
   * So this is the one place "the inline variable still works" is a measured
   * statement rather than an inference.
   */
  it(
    "still loads an inline-only key, with no file variable set",
    async () => {
      const inlineSecret = throwawaySecret();
      const s = await startAdapter({
        NEAR_VAULT_AGENT_ID: "vault.testnet",
        NEAR_VAULT_AGENT_KEY: inlineSecret,
      });

      const { status, json } = await pay(s.port, { amount: "1", recipient: "bob.testnet" });

      // Got PAST selection, so the credential loaded. What the chain then says
      // about a vault that does not exist is not this test's business.
      expect(status, `selection refused an inline key: ${json.error}`).not.toBe(400);
      expect(json.error ?? "").not.toMatch(/no agent credentials/i);
      expect(s.stdout() + s.stderr()).not.toContain(inlineSecret);
    },
    30_000,
  );

  it(
    "pays from the file's key, and logs no part of it",
    async () => {
      const fileSecret = throwawaySecret();
      const d = mkdtempSync(join(tmpdir(), "float-adapter-smoke-"));
      dirs.push(d);
      const path = join(d, "agent.json");
      writeFileSync(
        path,
        JSON.stringify({ account_id: "vault.testnet", private_key: fileSecret }),
      );

      // NO NEAR_VAULT_AGENT_ID and no inline key: the file supplies both
      // halves, which is the point of accepting the ~/.near-credentials shape.
      const s = await startAdapter({ NEAR_VAULT_AGENT_KEY_FILE: path });

      const { status, json } = await pay(s.port, { amount: "1", recipient: "bob.testnet" });

      // It got PAST selection — the credential loaded. What happens next is a
      // chain call against a vault that does not exist, which is not this
      // test's business; the refusals it must not be are the local ones.
      expect(json.error ?? "").not.toMatch(/no agent credentials|NEAR_VAULT_AGENT_KEY_FILE/i);
      expect(status).not.toBe(400);

      const logs = s.stdout() + s.stderr();
      expect(logs, "a startup line echoed the key it had just loaded").not.toContain(fileSecret);
      expect(logs).not.toContain(fileSecret.slice(8, 32));
    },
    30_000,
  );
});

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";

import { KeyFileError, readKeyFile, resolveKeySource } from "./key-file.js";

/**
 * Reading a secret from a FILE instead of an env value.
 *
 * Every key this repo handles currently lives as a plaintext env value — in
 * `.mcp.json` and in `.float/adapter.env`. Both are gitignored and neither has
 * ever been committed, so this is not a leak; the exposure is ORDINARY WORK.
 * Checking which vault an adapter is pointed at means reading its config, and
 * reading its config prints a live private key into a terminal scrollback and
 * into the transcript of whatever agent is driving. That is how the session
 * that filed this task acquired one.
 *
 * The repo already prefers the safer shape elsewhere: NEAR CLI signing uses
 * `sign-with-access-key-file` — a PATH — rather than
 * `sign-with-plaintext-private-key`, chosen after a key was echoed into a
 * terminal. This brings the MCP server and the adapter to the same footing.
 *
 * EVERY FIXTURE BELOW IS A FRESHLY GENERATED THROWAWAY KEYPAIR. Nothing here is
 * read from the real config files, and no assertion prints a secret — the
 * "never names the secret" block exists to keep it that way.
 */

const dirs: string[] = [];

/** A throwaway ed25519 secret. Generated, never borrowed from real config. */
function throwawaySecret(): string {
  return KeyPair.fromRandom("ed25519").toString();
}

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "float-keyfile-"));
  dirs.push(d);
  return d;
}

/** Write `contents` to a file and return its path. */
function file(contents: string, name = "key.json"): string {
  const p = join(tmp(), name);
  writeFileSync(p, contents);
  return p;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The message of whatever `fn` threw, or "" if it did not throw. */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Every 8-character window of the key's BODY.
 *
 * `not.toContain(secret)` is far too weak to police a leak, because the
 * realistic leak is PARTIAL. V8's `JSON.parse` errors quote a short run of the
 * input — `Unexpected token 'e', ..."ate_key": ed25519:3D"... is not valid
 * JSON` — so passing the parser's message through exposes the first few
 * characters of the key while a whole-string comparison stays happy. Measured
 * on node 24.14: a credentials file whose private_key was hand-edited and left
 * unquoted produced exactly that.
 *
 * Windowing the body instead means a message has to contain NO recognisable run
 * of the secret at all. The `ed25519:` prefix is stripped first — it is a
 * format marker, not secret, and quoting it is fine.
 */
function bodyWindows(secret: string): string[] {
  const body = secret.replace(/^ed25519:/, "");
  const out: string[] = [];
  for (let i = 0; i + 8 <= body.length; i++) out.push(body.slice(i, i + 8));
  return out;
}

/**
 * Whatever run of `secret` appears in `text`, if any.
 *
 * TWO CHECKS, because a leak can come off either end and one window size
 * cannot see both.
 *
 *   - An 8-character body window catches a TAIL leak, where V8's quoted run
 *     lands after the key and carries its last characters.
 *   - The `ed25519:` token followed by any body character catches a HEAD leak,
 *     which is the realistic one and is SHORT: the measured case echoed just
 *     `: ed25519:3D`, two characters of body. An 8-char window sails straight
 *     past it — this function was written with only the window check and
 *     reported the live leak as clean.
 *
 * The token test cannot false-positive on an honest message: nothing this
 * module writes mentions `ed25519` at all, so its presence means the input was
 * echoed. A shorter body window was rejected as the alternative because the
 * temp paths in these messages contain random characters, which would make a
 * 4-character window flake.
 */
function leakedRun(text: string, secret: string): string | undefined {
  const window = bodyWindows(secret).find((w) => text.includes(w));
  if (window) return window;
  // Base58 excludes 0, O, I and l — this is the real alphabet, not \w.
  const head = /ed25519:[1-9A-HJ-NP-Za-km-z]+/.exec(text);
  return head ? head[0] : undefined;
}

// =====================================================================
// readKeyFile — the two shapes an operator will actually point us at
// =====================================================================

describe("readKeyFile", () => {
  it("reads the ~/.near-credentials shape, account id included", () => {
    // The shape `near account import-account` and every near-cli-rs keychain
    // write. Taking `account_id` from it is the point: one path then carries
    // both halves of the credential, so there is no second variable to get
    // out of step with the first.
    const secret = throwawaySecret();
    const pub = KeyPair.fromString(secret as never).getPublicKey().toString();
    const p = file(
      JSON.stringify({ account_id: "v.fac.testnet", public_key: pub, private_key: secret }),
    );

    const got = readKeyFile(p);
    expect(got.secret).toBe(secret);
    expect(got.accountId).toBe("v.fac.testnet");
    expect(got.publicKey).toBe(pub);
  });

  it("reads a bare key file and strips the trailing newline", () => {
    // THE CLASSIC. `echo ed25519:... > key` leaves a newline, and a secret
    // with a newline welded on fails to parse at signing time — several
    // frames away from the file that caused it.
    const secret = throwawaySecret();
    expect(readKeyFile(file(`${secret}\n`, "key")).secret).toBe(secret);
  });

  it("tolerates CRLF and a BOM, because the file may have been written on Windows", () => {
    // Same BOM problem this repo already hit with its MCP configs: PowerShell's
    // Set-Content writes one by default, and it would otherwise become part of
    // the secret — or of the FIRST JSON key's name.
    const secret = throwawaySecret();
    expect(readKeyFile(file(`﻿${secret}\r\n`, "key")).secret).toBe(secret);
    expect(
      readKeyFile(file(`﻿${JSON.stringify({ private_key: secret })}\r\n`)).secret,
    ).toBe(secret);
  });

  it("ignores comments and blank lines in a bare file", () => {
    // So an operator can label a key file without breaking it.
    const secret = throwawaySecret();
    const p = file(`# agent key for v.fac.testnet\n\n${secret}\n`, "key");
    expect(readKeyFile(p).secret).toBe(secret);
  });

  it("accepts a key file with no account id — only the secret is required", () => {
    const secret = throwawaySecret();
    const got = readKeyFile(file(JSON.stringify({ private_key: secret })));
    expect(got.secret).toBe(secret);
    expect(got.accountId).toBeUndefined();
  });
});

// =====================================================================
// Refusals. Each of these is a case that must NOT read as "no key".
// =====================================================================

describe("readKeyFile refuses rather than guessing", () => {
  it("names the path when the file does not exist", () => {
    const msg = thrown(() => readKeyFile(join(tmp(), "absent.json")));
    expect(msg).toMatch(/absent\.json/);
    expect(msg).toMatch(/does not exist/i);
  });

  it("refuses an empty file — EMPTY IS NOT ABSENT", () => {
    // The dangerous reading. A zero-byte key file that resolved to "no key
    // configured" would send the operator to set a variable they have already
    // set, while the real fault is the file they are pointing at.
    expect(() => readKeyFile(file("", "key"))).toThrow(KeyFileError);
    expect(thrown(() => readKeyFile(file("   \n\n", "key")))).toMatch(/empty|no key/i);
  });

  it("refuses a directory instead of dying with a bare EISDIR", () => {
    const d = join(tmp(), "nested");
    mkdirSync(d);
    const msg = thrown(() => readKeyFile(d));
    expect(msg).toMatch(/nested/);
    expect(msg).toMatch(/director/i);
  });

  it("refuses a bare file with more than one content line", () => {
    // Ambiguous: picking the first would silently use one of two keys. Which
    // key signs IS which budget is charged, so a silent pick is a wrong
    // payment that SUCCEEDS.
    const msg = thrown(() => readKeyFile(file(`${throwawaySecret()}\n${throwawaySecret()}\n`, "key")));
    expect(msg).toMatch(/one key|single|2 /i);
  });

  it("refuses an env-file line and says which variable to use instead", () => {
    // A plausible mistake: pointing NEAR_VAULT_AGENT_KEY_FILE at
    // .float/adapter.env. Accepting it would hand the signer the string
    // "NEAR_VAULT_AGENT_KEY=ed25519:..." — a key that fails on chain for a
    // reason nothing in the error would explain. FLOAT_ENV_FILE is the
    // variable that reads a whole env file.
    const msg = thrown(() =>
      readKeyFile(file(`NEAR_VAULT_AGENT_KEY=${throwawaySecret()}\n`, "adapter.env")),
    );
    expect(msg).toMatch(/FLOAT_ENV_FILE/);
    expect(msg).toMatch(/env file/i);
  });

  it("refuses malformed JSON as its own failure, not as a missing key", () => {
    const msg = thrown(() => readKeyFile(file('{ "private_key": ', "key.json")));
    expect(msg).toMatch(/JSON/i);
  });

  it("lists the field names present when private_key is absent", () => {
    // Field NAMES are not secret and they are the whole diagnosis — a
    // credentials file written by a tool that calls it `secret` or
    // `privateKey` is otherwise indistinguishable from a corrupt one.
    const msg = thrown(() =>
      readKeyFile(file(JSON.stringify({ account_id: "v.testnet", secret: throwawaySecret() }))),
    );
    expect(msg).toMatch(/private_key/);
    expect(msg).toMatch(/account_id/);
    expect(msg).toMatch(/\bsecret\b/);
  });

  it("refuses a JSON private_key that is present but empty", () => {
    expect(() => readKeyFile(file(JSON.stringify({ private_key: "   " })))).toThrow(KeyFileError);
  });

  it("refuses JSON that is not an object", () => {
    expect(() => readKeyFile(file('["ed25519:nope"]'))).toThrow(KeyFileError);
  });
});

// =====================================================================
// THE RULE THAT MATTERS MOST: no error ever carries the secret.
// =====================================================================

describe("no refusal ever names the secret", () => {
  /**
   * The point of this whole change is that a key stops appearing in terminal
   * scrollback and agent transcripts. An error message is the easiest place to
   * undo that, because every one of these cases has the real secret IN HAND
   * when it decides to refuse — so quoting "the file" is quoting the key.
   *
   * The cases below are chosen for exactly that: each one holds a usable
   * secret and rejects it for some OTHER reason. A test built from an empty
   * file would pass trivially and prove nothing.
   */
  it("keeps the secret out of every message that had one to leak", () => {
    const secret = throwawaySecret();
    const cases: Array<[string, () => unknown]> = [
      ["env-file shape", () => readKeyFile(file(`NEAR_VAULT_AGENT_KEY=${secret}\n`, "adapter.env"))],
      ["two content lines", () => readKeyFile(file(`${secret}\n${throwawaySecret()}\n`, "key"))],
      ["wrong JSON field", () => readKeyFile(file(JSON.stringify({ privateKey: secret })))],
      ["JSON not an object", () => readKeyFile(file(JSON.stringify([secret])))],
      ["truncated JSON", () => readKeyFile(file(`{"private_key":"${secret}"`))],
      /**
       * THE CASE THAT CAUGHT A REAL LEAK, and the reason `leakedWindow` exists
       * rather than a whole-string comparison.
       *
       * A hand-edited credentials file that lost the quotes around its
       * private_key. V8 answers `Unexpected token 'e', ..."ate_key":
       * ed25519:3D"... is not valid JSON` — the parser quotes a run of the
       * input, so forwarding its message publishes the head of the key. Dropping
       * the parser's message is therefore load-bearing, not tidiness.
       */
      [
        "unquoted JSON value",
        () => readKeyFile(file(`{"account_id":"v.testnet","private_key": ${secret}}`)),
      ],
    ];

    for (const [label, fn] of cases) {
      const msg = thrown(fn);
      expect(msg, `${label} did not refuse at all`).not.toBe("");
      expect(msg, `${label} leaked the secret`).not.toContain(secret);
      // Not even a recognisable RUN of it — the realistic leak is partial.
      expect(
        leakedRun(msg, secret),
        `${label} leaked part of the secret into: ${msg.slice(0, 120)}`,
      ).toBeUndefined();
    }
  });

  it("keeps the secret out of a resolved key's warnings and error", () => {
    const secret = throwawaySecret();
    const r = resolveKeySource({
      inline: secret,
      file: file(`NEAR_VAULT_AGENT_KEY=${secret}\n`, "adapter.env"),
      inlineVar: "NEAR_VAULT_AGENT_KEY",
      fileVar: "NEAR_VAULT_AGENT_KEY_FILE",
    });
    const text = JSON.stringify({ warnings: r.warnings, error: r.error });
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(8, 24));
  });
});

// =====================================================================
// resolveKeySource — precedence, and the failure that must not degrade
// =====================================================================

describe("resolveKeySource", () => {
  const VARS = { inlineVar: "NEAR_VAULT_AGENT_KEY", fileVar: "NEAR_VAULT_AGENT_KEY_FILE" };

  it("keeps the inline value working, with nothing to warn about", () => {
    // NOT A BREAKING CHANGE is the requirement. The inline variable is in use
    // in .mcp.json and .float/adapter.env right now.
    const secret = throwawaySecret();
    const r = resolveKeySource({ inline: secret, ...VARS });
    expect(r.secret).toBe(secret);
    expect(r.source).toBe("inline");
    expect(r.warnings).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it("reports nothing configured as nothing configured", () => {
    const r = resolveKeySource({ ...VARS });
    expect(r.secret).toBeUndefined();
    expect(r.source).toBe("none");
    expect(r.error).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("prefers the file and warns about the inline value when both are set", () => {
    const fileSecret = throwawaySecret();
    const inlineSecret = throwawaySecret();
    const r = resolveKeySource({
      inline: inlineSecret,
      file: file(`${fileSecret}\n`, "key"),
      ...VARS,
    });
    expect(r.secret).toBe(fileSecret);
    expect(r.source).toBe("file");
    expect(r.warnings.join(" ")).toMatch(/NEAR_VAULT_AGENT_KEY\b/);
    expect(r.warnings.join(" ")).toMatch(/ignored|takes precedence|remove/i);
  });

  it("carries the account id up from a credentials file", () => {
    const secret = throwawaySecret();
    const r = resolveKeySource({
      file: file(JSON.stringify({ account_id: "v.fac.testnet", private_key: secret })),
      ...VARS,
    });
    expect(r.accountId).toBe("v.fac.testnet");
  });

  /**
   * THE LOAD-BEARING GUARD.
   *
   * A named-but-unreadable key file must never collapse into "no key set". The
   * two are different problems with different fixes, and this repo has already
   * paid for confusing them twice — `loadKeyring` carries `skippedOtherVault`
   * for precisely this reason ("nothing configured" and "nothing for this
   * vault" look identical from an empty ring).
   *
   * Falling back to the inline value would be worse still: the operator would
   * believe they had moved the secret out of their config while the config was
   * silently still the thing being used.
   */
  it("does NOT fall back to the inline value when the file cannot be read", () => {
    const inlineSecret = throwawaySecret();
    const missing = join(tmp(), "gone.json");
    const r = resolveKeySource({ inline: inlineSecret, file: missing, ...VARS });

    expect(r.secret, "fell back to the inline value").toBeUndefined();
    expect(r.source).toBe("file");
    expect(r.error).toMatch(/gone\.json/);
    expect(r.error).toMatch(/does not exist/i);
  });

  it("reports the file's own failure rather than a generic absence", () => {
    const r = resolveKeySource({ file: file("", "key"), ...VARS });
    expect(r.secret).toBeUndefined();
    expect(r.error).toBeTruthy();
    // The variable name is what the operator has to go and fix.
    expect(r.error).toMatch(/NEAR_VAULT_AGENT_KEY_FILE/);
  });

  it("treats a blank inline value as absent, not as a key made of spaces", () => {
    // `NEAR_VAULT_AGENT_KEY=` in an env file parses to "". Passing that to a
    // signer fails several frames away from the cause.
    expect(resolveKeySource({ inline: "", ...VARS }).source).toBe("none");
    expect(resolveKeySource({ inline: "   ", ...VARS }).source).toBe("none");
  });

  it("trims a stray newline off an inline value", () => {
    // Can only rescue a config that was already broken: no valid key has
    // surrounding whitespace.
    const secret = throwawaySecret();
    expect(resolveKeySource({ inline: `${secret}\n`, ...VARS }).secret).toBe(secret);
  });

  it("treats a blank file path as absent rather than reading the cwd", () => {
    expect(resolveKeySource({ file: "  ", ...VARS }).source).toBe("none");
  });
});

/**
 * THE FLEET KEYRING AS A KEY FILE.
 *
 * `.float/agent-keys.json` is the durable record of every agent. Until now a
 * JSON array was refused as "the wrong shape", so the ONLY way to configure an
 * agent was the inline secret in `.mcp.json` and `.float/adapter.env` — where
 * reading a config to answer "which vault is this?" prints a live private key
 * into scrollback and into the driving agent's transcript.
 *
 * Accepting the keyring is what lets the provisioning path write a PATH
 * instead. The alternative — a third file in the credentials shape — would
 * duplicate the secret into one more place, which is more exposure, not less.
 */
describe("the fleet keyring shape", () => {
  const keyring = (entries: unknown[]) => JSON.stringify(entries);

  it("reads a single-agent keyring and reports the vault as the account", () => {
    const f = file(
      keyring([{ nodeId: 1, agentId: "v.testnet", secret: "ed25519:SECRET" }]),
    );
    const out = readKeyFile(f);
    expect(out.secret).toBe("ed25519:SECRET");
    expect(out.accountId).toBe("v.testnet");
  });

  it("REFUSES a multi-agent keyring rather than picking one", () => {
    // Guessing would sign as an agent the operator did not choose — from the
    // wrong node, against the wrong budget.
    const f = file(
      keyring([
        { agentId: "v.testnet", nodeId: 1, secret: "ed25519:A" },
        { agentId: "v.testnet", nodeId: 2, secret: "ed25519:B" },
      ]),
    );
    expect(() => readKeyFile(f)).toThrow(/ambiguous|2 agent keys/i);
  });

  it("names the agents in the refusal but NEVER a key", () => {
    const f = file(
      keyring([
        { agentId: "v.testnet", nodeId: 1, secret: "ed25519:LEAKME" },
        { agentId: "v.testnet", nodeId: 7, secret: "ed25519:ALSOLEAK" },
      ]),
    );
    let msg = "";
    try { readKeyFile(f); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/v\.testnet#1/);
    expect(msg).toMatch(/v\.testnet#7/);
    expect(msg).not.toMatch(/LEAKME|ALSOLEAK/);
  });

  it("refuses an array with no privateKey, naming the expected shapes", () => {
    const f = file(keyring([{ agentId: "v.testnet", nodeId: 1, publicKey: "ed25519:pub" }]));
    expect(() => readKeyFile(f)).toThrow(/secret/);
  });

  it("still refuses a bare JSON array of strings", () => {
    // The original reason arrays were rejected: `["ed25519:..."]` must not be
    // fed to the bare-key reader, which would accept the literal text.
    const f = file(JSON.stringify(["ed25519:NOTAKEY"]));
    expect(() => readKeyFile(f)).toThrow();
  });

  it("also reads the older {vault, privateKey} spelling, which exists in the wild", () => {
    // A keyring on the author's machine uses these names. Supporting only the
    // canonical pair would refuse a real file as "the wrong shape".
    const f = file(keyring([{ kind: "virtual", vault: "v.testnet", node: 2, privateKey: "ed25519:OLD" }]));
    const out = readKeyFile(f);
    expect(out.secret).toBe("ed25519:OLD");
    expect(out.accountId).toBe("v.testnet");
  });
});

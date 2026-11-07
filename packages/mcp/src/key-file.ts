/**
 * Read a secret from a FILE PATH instead of a plaintext env value.
 *
 * This is the same reasoning as `env-file.ts` in the adapter, taken one step
 * further, so it is worth saying what the two have in common and where they
 * part.
 *
 * `env-file.ts` exists because a secrets file must be DATA, never something a
 * shell executes: `set -a && . .float/adapter.env` makes the shell run `$(...)`
 * and backticks found in a value, and it has already died for real on one
 * unquoted value containing a space. That argument is about how a file is
 * LOADED.
 *
 * This module is about where the secret LIVES. Right now the agent key is a
 * plaintext env value in two places — `.mcp.json` (`mcpServers.float-near.env`)
 * and `.float/adapter.env`. Both are gitignored and neither has ever been
 * committed, so nothing has leaked. The exposure is ORDINARY WORK: checking
 * which vault an adapter is pointed at means reading its config, and reading
 * its config prints a live private key into a terminal scrollback and into the
 * transcript of whatever agent is driving. That is routine, it is not a
 * mistake anyone would flag in review, and it is how the session that filed
 * this acquired one.
 *
 * A PATH is not a secret, so the same `cat` becomes harmless. This repo already
 * prefers that shape for the one credential it handles most carefully: NEAR CLI
 * signing uses `sign-with-access-key-file` rather than
 * `sign-with-plaintext-private-key`, chosen after a key was echoed into a
 * terminal. This brings the MCP server and the adapter to the same footing.
 *
 * THE INLINE VARIABLES KEEP WORKING. They are in use; a file is an
 * alternative, not a replacement. When both are set the file wins and the
 * inline one is reported as ignored — the other way round would let an operator
 * believe they had moved a secret out of their config while the config was
 * still silently the thing being read.
 *
 * ---- WHAT NO MESSAGE IN HERE MAY CONTAIN
 *
 * The secret. Every refusal below is reached while holding a usable key, so
 * quoting "what the file contained" would undo the entire point of the change
 * at the one moment an operator is most likely to paste the output somewhere.
 * Field NAMES are safe and are the actual diagnosis; values are not. This is
 * pinned by `no refusal ever names the secret` in key-file.test.ts, which drives
 * only cases that have a real secret in hand.
 *
 * That rule is also why a JSON parse failure is reported as "not valid JSON"
 * with the parser's own message DISCARDED: V8's `JSON.parse` errors quote a
 * fragment of the input, so passing one through would print part of the key.
 */
import { readFileSync, existsSync, statSync } from "node:fs";

export class KeyFileError extends Error {}

export interface KeyFileContents {
  secret: string;
  /** From a `~/.near-credentials`-shaped file. Absent for a bare key file. */
  accountId?: string;
  publicKey?: string;
}

/** The shape to quote in a refusal, so the fix is in the message. */
const CRED_SHAPE = '{"account_id", "public_key", "private_key"}';

/**
 * An env-file assignment, which is a FILE POINTED AT THE WRONG VARIABLE
 * rather than a key.
 *
 * Why the name must contain an underscore and the value must be non-empty
 * after stripping '=': a base64url secret can legitimately end in '=' padding
 * and base64url's alphabet includes '_', so `ABC_DEF=` is a possible SECRET,
 * not necessarily an assignment. Padding is always trailing, so requiring
 * something other than '=' after the first one tells the two apart. Neither of
 * the keys this actually carries can collide anyway — an `ed25519:` key is
 * base58 (no '=', no '_') and a quote signer is hex — but this reader is
 * generic and the wrong answer here is the silent kind.
 */
const ENV_LINE = /^(?:export\s+)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*=(.*)$/;

/**
 * Read a key out of `path`.
 *
 * Accepts either the `~/.near-credentials` JSON shape or a bare key on one
 * line. Throws `KeyFileError` for anything else — never returns an empty or
 * partial credential, because "I could not read it" collapsing into "there
 * isn't one" is the failure this is built to avoid.
 */
export function readKeyFile(path: string): KeyFileContents {
  if (!existsSync(path)) {
    throw new KeyFileError(
      `key file ${path} does not exist. It should hold either the ` +
        `~/.near-credentials shape ${CRED_SHAPE} or the bare key on one line.`,
    );
  }

  let raw: string;
  try {
    // Checked explicitly: readFileSync on a directory throws EISDIR, and an
    // errno in an error message is not a diagnosis.
    if (statSync(path).isDirectory()) {
      throw new KeyFileError(`key file ${path} is a directory, not a file.`);
    }
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof KeyFileError) throw e;
    const code = (e as { code?: string }).code;
    throw new KeyFileError(`key file ${path} could not be read${code ? ` (${code})` : ""}.`);
  }

  /**
   * A BOM IS ALREADY HANDLED, by `trim()`, and that is worth a sentence
   * because it does not look handled.
   *
   * PowerShell's Set-Content and Out-File write a U+FEFF by default, so any
   * file the operator has touched from a one-liner carries one, and left in
   * place it becomes part of the secret or of the first JSON key's name — a
   * failure whose cause is invisible. env-file.ts strips it explicitly, so the
   * obvious thing here was to copy that.
   *
   * It is not needed. U+FEFF satisfies the spec's WhiteSpace production, so
   * `String.prototype.trim` removes it (verified on node 24.14:
   * `/^\s$/.test("﻿")` is true). An explicit `startsWith("﻿") ?
   * slice(1)` ahead of this line is therefore dead code — it was written, and
   * mutation testing exposed it: deleting it killed no test, because it could
   * not change any outcome.
   *
   * The `tolerates CRLF and a BOM` test stays, pinning the real behaviour
   * rather than the redundant guard.
   */
  const trimmed = raw.trim();

  // EMPTY IS NOT ABSENT. A zero-byte key file resolving to "no key configured"
  // would send the operator to set a variable they have already set, while the
  // real fault is the file they are pointing at.
  if (!trimmed) {
    throw new KeyFileError(`key file ${path} is empty — there is no key in it.`);
  }

  // `[` as well as `{`: a JSON array must be named as the wrong shape, not fed
  // to the bare-key reader, which would otherwise accept the literal text
  // `["ed25519:..."]` as a secret.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fromJson(trimmed, path);
  return { secret: fromBare(trimmed, path) };
}

function fromJson(text: string, path: string): KeyFileContents {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    /**
     * THE PARSER'S MESSAGE IS DELIBERATELY DROPPED, and this is load-bearing
     * rather than tidiness.
     *
     * V8 quotes a run of the input in its `is not valid JSON` form. Measured on
     * node 24.14 against a credentials file whose private_key had been
     * hand-edited and left unquoted:
     *
     *   Unexpected token 'e', ..."ate_key": ed25519:3D"... is not valid JSON
     *
     * Forwarding that publishes the head of the key — into a terminal, a pm2
     * log, or an agent transcript, which is the exact exposure this module
     * exists to close. Pinned by `unquoted JSON value` in the leak test.
     */
    throw new KeyFileError(
      `key file ${path} is not valid JSON. Expected the ~/.near-credentials shape ` +
        `${CRED_SHAPE}, or a bare key on one line.`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KeyFileError(
      `key file ${path} is JSON but not an object. Expected the ~/.near-credentials ` +
        `shape ${CRED_SHAPE}.`,
    );
  }

  const o = parsed as Record<string, unknown>;
  const secret = typeof o.private_key === "string" ? o.private_key.trim() : "";
  if (!secret) {
    // FIELD NAMES, NEVER VALUES. The names are the whole diagnosis: a file
    // written by a tool that calls it `secret` or `privateKey` is otherwise
    // indistinguishable from a corrupt one.
    const names = Object.keys(o);
    throw new KeyFileError(
      `key file ${path} has no usable "private_key". Fields present: ` +
        `${names.length ? names.join(", ") : "none"}. Expected the ~/.near-credentials ` +
        `shape ${CRED_SHAPE}.`,
    );
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { secret, accountId: str(o.account_id), publicKey: str(o.public_key) };
}

function fromBare(text: string, path: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  // Reachable: a file holding nothing but comments trims to something, then
  // filters to nothing.
  if (lines.length === 0) {
    throw new KeyFileError(`key file ${path} is empty — there is no key in it.`);
  }

  // BEFORE the line count, because an env file has many lines and "expected
  // one key" would be a true statement that hides the actual mistake.
  for (const line of lines) {
    const m = ENV_LINE.exec(line);
    if (m && m[2]!.replace(/=/g, "").trim()) {
      throw new KeyFileError(
        `key file ${path} looks like an env file: it contains an assignment to ` +
          `${m[1]}. This variable wants a file holding ONLY the key — either the ` +
          `~/.near-credentials shape ${CRED_SHAPE} or the bare key on one line. ` +
          `To load a whole env file instead, use FLOAT_ENV_FILE.`,
      );
    }
  }

  if (lines.length > 1) {
    throw new KeyFileError(
      `key file ${path} has ${lines.length} content lines; expected exactly one key. ` +
        `Which key signs is which budget is charged, so this is not guessed.`,
    );
  }

  return lines[0]!;
}

export type KeySource = "file" | "inline" | "none";

export interface ResolvedKey {
  /** Absent when nothing is configured OR when the named file failed to read. */
  secret?: string;
  source: KeySource;
  /** The path that was tried, when one was named. */
  path?: string;
  accountId?: string;
  publicKey?: string;
  /**
   * Set when a file was NAMED but could not be read.
   *
   * Distinct from `source === "none"` on purpose, and the caller must keep it
   * that way: "no key is configured" and "the key file you named is broken"
   * are different problems with different fixes, and reporting the second as
   * the first sends the reader to set a variable that is already set. The
   * adapter's `loadKeyring` carries `skippedOtherVault` for exactly this
   * reason.
   */
  error?: string;
  /** Operator-facing notes. NAMES ONLY — these get logged. */
  warnings: string[];
}

/**
 * Decide which of the two variables supplies a secret.
 *
 * The file wins. A failed file read does NOT fall back to the inline value:
 * silently using the config an operator believes they have stopped using is
 * worse than not starting.
 */
export function resolveKeySource(opts: {
  inline?: string;
  file?: string;
  /** e.g. "NEAR_VAULT_AGENT_KEY" — named so messages can be acted on. */
  inlineVar: string;
  /** e.g. "NEAR_VAULT_AGENT_KEY_FILE" */
  fileVar: string;
}): ResolvedKey {
  const warnings: string[] = [];

  // Trimmed, and blank treated as absent. `NEAR_VAULT_AGENT_KEY=` in an env
  // file parses to "", and a key made of spaces fails at the signer several
  // frames from its cause. No valid key has surrounding whitespace, so this
  // can only rescue a config that was already broken.
  const inline = (opts.inline ?? "").trim() || undefined;
  const path = (opts.file ?? "").trim() || undefined;

  if (!path) {
    return inline ? { secret: inline, source: "inline", warnings } : { source: "none", warnings };
  }

  if (inline) {
    warnings.push(
      `${opts.fileVar} is set, so ${opts.inlineVar} is ignored. Remove the inline ` +
        `value: a key held in an env value is printed by any read of the config, ` +
        `which is routine, whereas a path is not a secret.`,
    );
  }

  try {
    const got = readKeyFile(path);
    return {
      secret: got.secret,
      source: "file",
      path,
      accountId: got.accountId,
      publicKey: got.publicKey,
      warnings,
    };
  } catch (e) {
    // `source` stays "file" with no secret. A caller that reports this as
    // "nothing configured" has lost the only useful part of the message.
    return { source: "file", path, error: `${opts.fileVar}: ${(e as Error).message}`, warnings };
  }
}

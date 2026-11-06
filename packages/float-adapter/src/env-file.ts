/**
 * Read an env file without involving a shell.
 *
 * Every doc in this repo tells the operator to run:
 *
 *   set -a && . .float/adapter.env && set +a && npx @floatonnear/float-adapter
 *
 * That idiom has already failed on a real box. From this project's memory
 * (prod-env-file-cannot-be-sourced-by-bash): one unquoted value containing a
 * space made `set -a; . .env; set +a` die with `Scan: command not found`, and
 * every script opening with that line failed before it ran.
 *
 * Two reasons that is the wrong mechanism HERE specifically, rather than merely
 * fragile:
 *
 *   1. The file is written by create-float and carries NEAR_VAULT_AGENT_KEY,
 *      FLOAT_QUOTE_SIGNER_KEY and FLOAT_API_TOKEN. Sourcing it means the shell
 *      EXECUTES its contents: `$(...)` and backticks in a value run as
 *      commands. A secrets file should be data.
 *   2. It has to work the same way on Windows and on a VPS. `set -a` is not
 *      available in PowerShell at all, which is why this repo's memory carries
 *      a bespoke `Get-Content | ForEach-Object { Set-Item Env: }` incantation
 *      just to start the adapter locally.
 *
 * One parser, tested, used by both.
 */

/**
 * Parse `KEY=value` lines into a plain object.
 *
 * Deliberately NOT a dotenv clone: no variable interpolation, no escape
 * sequences, no multi-line values. Each of those is a way for the contents of a
 * secrets file to change meaning, and none is needed by the file create-float
 * writes.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  // Strip a BOM. PowerShell's Out-File and Set-Content write one by default, so
  // any file the operator has touched from a one-liner has it, and it would
  // otherwise become part of the FIRST key's name — producing a missing-variable
  // failure whose cause is invisible.
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Split on the FIRST '=' only. Base64url tokens and ed25519 keys contain
    // '=' as padding, and splitting on each one silently truncates a secret —
    // which surfaces as a 401 that nobody can account for.
    const eq = line.indexOf("=");
    if (eq < 0) continue; // not an assignment; not our business

    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Strip ONE layer of matching surrounding quotes, so both `A="x y"` and the
    // bare `A=x y` that broke the shell mean the same thing here.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  return out;
}

/**
 * Apply a parsed env file WITHOUT overriding anything already set.
 *
 * A real environment variable must outrank the file, so a deploy can point one
 * service at a different port or contract without editing shared secrets. That
 * precedence is the same one the pythscan sandbox relied on to keep a verify run
 * aimed at a database COPY while every credential still came from the
 * production file.
 */
export function applyEnvFile(
  parsed: Record<string, string>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] !== undefined) continue;
    env[k] = v;
    applied.push(k);
  }
  return applied;
}

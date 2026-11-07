/**
 * Mutation check for the guards that decide whether a key is USABLE.
 *
 * Three modules share one job here, so they share one suite:
 *
 *   packages/mcp/src/key-file.ts        reads a secret out of a file
 *   packages/mcp/src/rpc.ts             requireAgentKey — may this key pay?
 *   packages/float-adapter/src/keyring.ts  which agent signs, and why none can
 *
 * TWO FAILURE DIRECTIONS, and both are silent, which is why mutation testing
 * earns its keep on this change rather than just coverage:
 *
 *   1. A refusal that LEAKS. Every refusal in key-file.ts is reached while
 *      holding a usable secret, so a message that quotes "what was in the file"
 *      publishes the key — into a terminal, a pm2 log, or an agent transcript.
 *      That is the exact exposure the whole change exists to close, so a
 *      mutant that re-opens it must die. See K2 and K6.
 *
 *   2. A failure that READS AS ABSENCE. "The key file you named is broken" and
 *      "no key is configured" are different problems, and reporting the second
 *      when the first applies tells the operator to paste the secret back
 *      inline — undoing the change while looking like helpful advice. See K7,
 *      R1, G1 and G2.
 *
 * Unlike the other mutate-* scripts in here this one spans several files with
 * different test commands, so each mutant names its own.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const MCP = "packages/mcp/src/key-file.ts";
const RPC = "packages/mcp/src/rpc.ts";
const RING = "packages/float-adapter/src/keyring.ts";

/** Where each file's pinning suite lives. */
const SUITE = {
  [MCP]: { cwd: "packages/mcp", cmd: "npx vitest run src/key-file.test.ts" },
  [RPC]: { cwd: "packages/mcp", cmd: "npx vitest run src/rpc.test.ts" },
  [RING]: { cwd: "packages/float-adapter", cmd: "npx vitest run src/keyring.test.ts" },
};

/**
 * LINE ENDINGS ARE NOT PART OF THE PATTERN — the same trap mutate-teardown.mjs
 * documents. A multi-line `from` written with an LF escape matches NOTHING in a
 * CRLF file, and a mutant whose pattern is absent is reported as SKIP, which
 * verify-all.mjs treats as a failure. These three files are LF today, but that
 * is a fact about a checkout and not about the repo.
 */
const CR = String.fromCharCode(13);
const NL = String.fromCharCode(10);
const CRLF = CR + NL;

/**
 * Every mutant is a plausible SIMPLIFICATION — the kind of edit that reads as
 * tidying in review.
 *
 * NOTE ON WHAT IS DELIBERATELY ABSENT. `readKeyFile`'s `if (!trimmed)` empty
 * check has no mutant, because removing it changes no behaviour: an empty or
 * whitespace-only file falls through to `fromBare`, whose own empty check
 * throws the same error. It is reachable-but-redundant, kept for the branch
 * ordering it makes obvious, and a mutant for it would be an EQUIVALENT MUTANT
 * that no test could kill — the same reasoning mutate-teardown.mjs records for
 * its deleted M5.
 */
const MUTANTS = [
  // ---- key-file.ts: reading the file
  {
    file: MCP,
    name: "K1 the JSON sniff loses '[', so a JSON array is accepted as a bare key",
    from: 'if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fromJson(trimmed, path);',
    to: 'if (trimmed.startsWith("{")) return fromJson(trimmed, path);',
  },
  {
    /**
     * THE LEAK MUTANT, and the one that justified strengthening the test.
     *
     * V8 quotes a run of the input in its `is not valid JSON` message.
     * Measured on node 24.14 against a credentials file whose private_key was
     * hand-edited and left unquoted:
     *
     *   Unexpected token 'e', ..."ate_key": ed25519:3D"... is not valid JSON
     *
     * Only TWO characters of the key body escape there, so the leak test's
     * 8-character body window walked straight past it and reported the live
     * leak as clean. It now also matches the `ed25519:` token followed by any
     * base58 character, which is what kills this.
     */
    file: MCP,
    name: "K2 the JSON parser's own message is forwarded, publishing the head of the key",
    from: "  } catch {",
    to: '  } catch (e) {\n    throw new KeyFileError("bad JSON in " + path + ": " + (e as Error).message);',
  },
  {
    file: MCP,
    name: "K3 the env-file guard goes, so NEAR_VAULT_AGENT_KEY=<key> becomes the key",
    from: '    if (m && m[2]!.replace(/=/g, "").trim()) {',
    to: "    if (false) {",
  },
  {
    file: MCP,
    name: "K4 a two-key file silently yields the first — the wrong budget, charged successfully",
    from: "  if (lines.length > 1) {",
    to: "  if (false) {",
  },
  {
    file: MCP,
    name: "K5 private_key is no longer trimmed, so a whitespace value passes as a secret",
    from: '  const secret = typeof o.private_key === "string" ? o.private_key.trim() : "";',
    to: '  const secret = typeof o.private_key === "string" ? o.private_key : "";',
  },
  {
    file: MCP,
    name: "K6 the refusal quotes the file's contents — a whole key into the log",
    from: "      `key file ${path} has ${lines.length} content lines; expected exactly one key. ` +",
    to: "      `key file ${path} has ${lines.length} content lines (${text}); expected one. ` +",
  },
  /**
   * K10 WAS HERE AND IS DELIBERATELY GONE — it found dead code.
   *
   * It deleted an explicit BOM strip (`raw.startsWith("﻿") ? raw.slice(1)
   * : raw`) copied from env-file.ts, and it SURVIVED. The first instinct was
   * that the BOM test was weak.
   *
   * It is not. U+FEFF satisfies the spec's WhiteSpace production, so the
   * `trim()` on the next line already removes it (verified on node 24.14:
   * `/^\s$/.test("﻿")` is true). No input could distinguish the two
   * versions, so no test could ever kill this mutant — an EQUIVALENT MUTANT,
   * same category as the deleted M5 in mutate-teardown.mjs.
   *
   * The resolution was to delete the redundant line rather than the mutant's
   * subject: dead code that reads as load-bearing is worse than no code. The
   * reason `trim()` suffices is now a comment at that spot, and the
   * `tolerates CRLF and a BOM` test still pins the behaviour.
   */
  {
    file: MCP,
    name: "K11 the directory check goes, leaving a bare EISDIR instead of a diagnosis",
    from: "    if (statSync(path).isDirectory()) {",
    to: "    if (false) {",
  },

  // ---- key-file.ts: which variable wins
  {
    /**
     * THE WORST ONE. The operator believes the secret has moved out of their
     * config; a mistyped path means the config is silently still the thing
     * being used, and nothing says so.
     */
    file: MCP,
    name: "K7 an unreadable key file falls back to the inline value",
    from: '    return { source: "file", path, error: `${opts.fileVar}: ${(e as Error).message}`, warnings };',
    to: '    return { secret: inline, source: "file", path, error: `${opts.fileVar}: ${(e as Error).message}`, warnings };',
  },
  {
    file: MCP,
    name: "K8 the inline value wins over the file, so moving the key to a file does nothing",
    from: "  if (!path) {",
    to: "  if (!path || inline) {",
  },
  {
    file: MCP,
    name: "K9 the both-are-set warning is dropped, so the ignored inline key is never mentioned",
    from: "  if (inline) {\n    warnings.push(",
    to: "  if (false) {\n    warnings.push(",
  },

  // ---- rpc.ts: may this key pay?
  {
    file: RPC,
    name: "R1 a broken key file is reported as a missing variable",
    from: "  if (!env.agentKey && env.agentKeyError) {",
    to: "  if (false) {",
  },
  {
    file: RPC,
    name: "R2 the key-file/agent-id mismatch check goes — signs as the wrong account",
    from: "  if (env.agentKeyAccountId && env.agentKeyAccountId !== env.agentId) {",
    to: "  if (false) {",
  },
  {
    /**
     * R3 EXISTS TO INTERROGATE A PASSING NEGATIVE TEST.
     *
     * "accepts a key whose file names the same account" passed before the
     * guard was written and would pass again if someone deleted it, so on its
     * own it pins nothing. Inverting the comparator is what proves that test
     * is carried by the matching clause rather than by something upstream.
     */
    file: RPC,
    name: "R3 the mismatch comparator is inverted — a MATCHING pair is refused",
    from: "  if (env.agentKeyAccountId && env.agentKeyAccountId !== env.agentId) {",
    to: "  if (env.agentKeyAccountId && env.agentKeyAccountId === env.agentId) {",
  },

  // ---- keyring.ts: why no agent can sign
  {
    file: RING,
    name: "G1 the key-file error is never carried onto the ring, so nothing can report it",
    from: "  ring.agentKeyError = env.agentKeyError;",
    to: "",
  },
  {
    file: RING,
    name: "G2 the dedicated refusal goes — back to 'set NEAR_VAULT_AGENT_KEY', i.e. paste it inline",
    from: "  if (ring.agentKeyError) {",
    to: "  if (false) {",
  },
  {
    file: RING,
    name: "G3 the ambiguity error drops the note, hiding why the default vanished",
    from: '        `safe default. Pass "role", "agent" or "nodeId". Loaded agents: ${known()}.` +\n        keyFileNote,',
    to: '        `safe default. Pass "role", "agent" or "nodeId". Loaded agents: ${known()}.`,',
  },
];

// Snapshot every file ONCE, up front, so a revert is byte-identical even if a
// later mutant throws.
const ORIG = new Map();
for (const f of new Set(MUTANTS.map((m) => m.file))) ORIG.set(f, readFileSync(f, "utf8"));

const restoreAll = () => {
  for (const [f, text] of ORIG) writeFileSync(f, text);
};

let survived = 0;
try {
  for (const m of MUTANTS) {
    const orig = ORIG.get(m.file);
    const usesCrlf = orig.includes(CRLF);
    const origLf = orig.split(CRLF).join(NL);

    if (!origLf.includes(m.from)) {
      console.log(`  SKIP (pattern absent)  ${m.name}`);
      survived++;
      continue;
    }

    const mutatedLf = origLf.replace(m.from, m.to);
    writeFileSync(m.file, usesCrlf ? mutatedLf.split(NL).join(CRLF) : mutatedLf);

    const { cwd, cmd } = SUITE[m.file];
    let verdict;
    try {
      execSync(cmd, { cwd, stdio: "pipe" });
      verdict = "SURVIVED";
      survived++;
    } catch {
      verdict = "killed";
    }

    // Revert THIS file immediately, so the next mutant starts from clean source.
    writeFileSync(m.file, orig);
    console.log(`  ${verdict.padEnd(21)}${m.name}`);
  }
} finally {
  restoreAll();
}

let restored = true;
for (const [f, text] of ORIG) {
  if (readFileSync(f, "utf8") !== text) {
    restored = false;
    console.error(`FATAL: ${f} was not restored.`);
  }
}
console.log(`  reverted byte-identical: ${restored}`);

if (!restored) process.exit(1);
if (survived) {
  console.error(`\n${survived} mutant(s) survived — the suite does not pin this behaviour.`);
  process.exit(1);
}

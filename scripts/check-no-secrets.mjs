#!/usr/bin/env node
/**
 * No private key may be TRACKED by git.
 *
 * WHY THIS EXISTS, and it is not hypothetical. On 2026-11-12 a script wrote
 * `.mcp.json.bak` as a safety backup before editing the MCP config. `.mcp.json`
 * was untracked but the `.bak` matched no ignore rule, a `git add -A` swept it
 * up, and an ed25519 PRIVATE KEY was committed and pushed. The key was for a
 * testnet vault that does not exist, so it controlled nothing — but the
 * mechanism would have taken a mainnet key just as readily, and nothing in the
 * repo would have noticed.
 *
 * The backup was the safe-looking half of the operation. That is the shape to
 * guard: not careless commits, but a prudent step whose output nobody classified.
 *
 * TRACKED FILES ONLY, deliberately. `.float/` legitimately holds live keys and
 * is ignored; scanning the working tree would flag those forever and teach
 * everyone to ignore this check. What matters is what git is carrying.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LF = String.fromCharCode(10);

const files = execSync("git ls-files", { encoding: "utf8" }).split(LF).filter(Boolean);

/**
 * Patterns for SECRET material, not for the word "key".
 *
 * An ed25519 PUBLIC key is 43-44 base58 chars after the prefix; a SECRET is 86+
 * because it encodes both halves. Keying on length is what lets the repo keep
 * printing public keys in docs and demos — which it does, a lot — without this
 * going off. A rule that fired on every `ed25519:` would be turned off in a day.
 */
const PATTERNS = [
  { name: "ed25519 private key", re: /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/ },
  {
    name: "NEAR credential private_key field",
    re: /"private_key"\s*:\s*"ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/,
  },
  /**
   * LENGTH IS LOAD-BEARING HERE TOO. The first version matched any
   * `NEAR_VAULT_AGENT_KEY = "ed25519:..."` and flagged five tracked files —
   * every one a placeholder: `...`, `secret`, a backtick, `<redacted`. A check
   * that is red on a clean repo gets switched off, and then it is not guarding
   * the publish. Requiring secret length keeps the docs and tests free to show
   * the shape of the variable.
   */
  {
    name: "inline agent key env assignment",
    re: /NEAR_VAULT_AGENT_KEY\s*[:=]\s*"?ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/,
  },
  { name: "64-hex secret assigned to a QUOTE_SIGNER var", re: /QUOTE_SIGNER_KEY\s*[:=]\s*"?[0-9a-f]{64}/ },
];

/**
 * Files that may legitimately contain a pattern because they DEFINE or TEST it.
 *
 * Named exactly. A directory-wide exemption is how the next real leak hides.
 */
const ALLOWED = new Set([
  "scripts/check-no-secrets.mjs", // this file names the patterns
]);

const findings = [];
for (const f of files) {
  if (ALLOWED.has(f.replace(/\\/g, "/"))) continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue; // binary or unreadable
  }
  for (const p of PATTERNS) {
    if (p.re.test(text)) findings.push({ file: f, what: p.name });
  }
}

/**
 * POSITIVE CONTROL. A scanner that cannot match reports a clean repo, which is
 * the failure this repo keeps meeting. Prove each pattern fires on a synthetic
 * sample before believing a zero.
 */
const SAMPLES = {
  "ed25519 private key": `ed25519:${"3".repeat(88)}`,
  "NEAR credential private_key field": '"private_key": "ed25519:' + "3".repeat(88) + '"',
  "inline agent key env assignment": 'NEAR_VAULT_AGENT_KEY: "ed25519:' + "3".repeat(88) + '"',
  "64-hex secret assigned to a QUOTE_SIGNER var": `FLOAT_QUOTE_SIGNER_KEY=${"a".repeat(64)}`,
};
for (const p of PATTERNS) {
  if (!p.re.test(SAMPLES[p.name])) {
    console.error(
      `BROKEN: the "${p.name}" pattern does not match its own sample, so a zero from it means ` +
        `nothing. Fix the pattern before trusting this scan.`,
    );
    process.exit(1);
  }
}
// And a negative control: a PUBLIC key must not trip the private-key rule.
const PUBLIC_SAMPLE = "ed25519:E2PGijm4YqU445iVfr4iW4LF2PYdMvfAvwiw5L8iYfj4";
if (PATTERNS[0].re.test(PUBLIC_SAMPLE)) {
  console.error(
    "BROKEN: a 44-char PUBLIC key trips the private-key rule. This repo prints public keys in " +
      "docs and demos, so that would make the check noise and then it gets ignored.",
  );
  process.exit(1);
}

if (findings.length) {
  console.error(
    `BROKEN: ${findings.length} tracked file(s) contain key material.${LF}` +
      findings.map((f) => `  ${f.file} — ${f.what}`).join(LF) +
      `${LF}${LF}  Untrack it, purge it from history, and add an ignore rule. A pushed secret is` +
      `${LF}  not fixed by deleting it in a later commit.`,
  );
  process.exit(1);
}

console.log(
  `no secrets: ${files.length} tracked files scanned, ${PATTERNS.length} patterns, controls pass`,
);

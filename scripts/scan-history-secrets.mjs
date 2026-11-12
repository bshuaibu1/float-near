#!/usr/bin/env node
/**
 * Scan EVERY BLOB IN GIT HISTORY for key material, not just the current tree.
 *
 * WHY THIS IS A DIFFERENT JOB FROM check-no-secrets.mjs. That one scans tracked
 * files at HEAD, which is the right guard for "do not commit a secret today".
 * It says nothing about whether one was committed in March and deleted in
 * April — and the moment a private repo is made PUBLIC, every blob that ever
 * existed becomes readable by anyone who can walk the object graph. Deleting a
 * file in a later commit does not remove it.
 *
 * So this is the pre-flight for going public, and going public is ONE-WAY.
 *
 * PROVEN, not assumed. A planted secret was committed and then deleted in a
 * later commit: `check-no-secrets.mjs` passed (HEAD is clean) while this script
 * found the blob. That pair is the entire argument for having both.
 *
 * NUL IS BUILT, NOT TYPED. The first draft had a literal NUL byte in the
 * source, which made git and grep treat this very file as binary — a security
 * script nobody can grep is a bad trade for one character.
 */
import { execFileSync } from "node:child_process";

const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

const PATTERNS = [
  { name: "ed25519 private key", re: /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/ },
  {
    name: "NEAR credential private_key",
    re: /"private_key"\s*:\s*"ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/,
  },
  { name: "64-hex quote-signer secret", re: /QUOTE_SIGNER_KEY\s*[:=]\s*"?[0-9a-f]{64}/ },
  { name: "AWS access key id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "FLOAT_API_TOKEN assignment", re: /FLOAT_API_TOKEN\s*[:=]\s*"?[A-Za-z0-9_-]{24,}/ },
];

/**
 * Paths exempt because they DEFINE or TEST the patterns.
 *
 * Matched on the path git reports, and named exactly — a directory-wide
 * exemption is how the next real leak hides. `check-no-secrets.mjs` carries the
 * same self-exemption for the same reason.
 */
const ALLOWED_PATHS = new Set([
  "scripts/scan-history-secrets.mjs",
  "scripts/check-no-secrets.mjs",
]);

/** POSITIVE CONTROL per pattern — a zero from a broken matcher is worthless. */
const SAMPLES = {
  "ed25519 private key": `ed25519:${"3".repeat(88)}`,
  "NEAR credential private_key": `"private_key": "ed25519:${"3".repeat(88)}"`,
  "64-hex quote-signer secret": `FLOAT_QUOTE_SIGNER_KEY=${"a".repeat(64)}`,
  "AWS access key id": "AKIAIOSFODNN7EXAMPLE",
  "FLOAT_API_TOKEN assignment": `FLOAT_API_TOKEN=${"x".repeat(32)}`,
};
for (const p of PATTERNS) {
  if (!p.re.test(SAMPLES[p.name])) {
    console.error(`BROKEN: pattern "${p.name}" fails its own sample. A zero means nothing.`);
    process.exit(1);
  }
}
// Negative control: a 44-char PUBLIC key must not look like a secret.
if (PATTERNS[0].re.test("ed25519:E2PGijm4YqU445iVfr4iW4LF2PYdMvfAvwiw5L8iYfj4")) {
  console.error("BROKEN: a public key trips the private-key rule; this scan would be noise.");
  process.exit(1);
}

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });

// Every blob ever reachable, with the path it was last seen at.
const lines = git(["rev-list", "--all", "--objects"]).split(LF).filter(Boolean);

/** Only blobs, and only ones worth reading as text. */
const SKIP_EXT = /\.(wasm|png|jpg|jpeg|gif|woff2?|ttf|ico|pdf|zip|gz|tgz|mp4|webm)$/i;
const candidates = [];
for (const line of lines) {
  const sp = line.indexOf(" ");
  if (sp === -1) continue; // a commit/tree entry, no path
  const sha = line.slice(0, sp);
  const path = line.slice(sp + 1);
  if (SKIP_EXT.test(path)) continue;
  candidates.push({ sha, path: path.replace(/\\/g, "/") });
}

console.log(`scanning ${candidates.length} historical blob(s) across all refs…`);

const findings = [];
let scanned = 0;
let skippedBinary = 0;
let skippedAllowed = 0;
for (const { sha, path } of candidates) {
  if (ALLOWED_PATHS.has(path)) {
    skippedAllowed += 1;
    continue;
  }
  let text;
  try {
    text = git(["cat-file", "-p", sha]);
  } catch {
    continue;
  }
  // A NUL byte means it is not source. COUNTED, so "scanned" cannot quietly
  // mean "read but never examined" — that distinction is the whole game here.
  if (text.includes(NUL)) {
    skippedBinary += 1;
    continue;
  }
  scanned += 1;
  for (const p of PATTERNS) {
    if (p.re.test(text)) findings.push({ sha, path, what: p.name });
  }
}

if (findings.length) {
  console.error(`${LF}FOUND ${findings.length} secret(s) in history:${LF}`);
  for (const f of findings) {
    console.error(`  ${f.what}${LF}    blob ${f.sha}  path ${f.path}`);
    try {
      const where = git(["log", "--all", "--oneline", "--find-object", f.sha]).trim();
      if (where) console.error(`    in: ${where.split(LF).slice(0, 5).join(`${LF}        `)}`);
    } catch {
      /* best effort */
    }
  }
  console.error(
    `${LF}DO NOT MAKE THE REPO PUBLIC. Deleting these in a later commit does not help —` +
      `${LF}every blob above stays readable. Rewrite history (git filter-repo) and rotate` +
      `${LF}the exposed credentials, in that order.`,
  );
  process.exit(1);
}

console.log(
  `${LF}history clean: ${scanned} text blob(s) examined` +
    ` (${skippedBinary} binary, ${skippedAllowed} self-exempt skipped),` +
    ` ${PATTERNS.length} patterns, controls pass.` +
    `${LF}No key material found in any commit reachable from any ref.`,
);

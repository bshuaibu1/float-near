/**
 * Mutation check for the signing link.
 *
 * M1/M2 are the exact corruption this repo already shipped once - the user
 * saw "the payload is not valid base64url JSON" from a link that looked fine.
 * M4 is the dangerous one: a dropped deposit produces a transaction the
 * contract rejects at `assert_one_yocto`, after the owner has approved it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/sign-link.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 padding kept (=) - breaks on paste",
    from: '.replace(/=+$/, "")',
    to: "",
  },
  {
    name: "M2 '/' left in the output - query value mangled",
    from: ', "_")',
    to: ', "/")',
  },
  {
    name: "M3 decoder does not reverse the substitution",
    from: 'const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");',
    to: "const b64 = b64url;",
  },
  {
    name: "M4 deposit default dropped (assert_one_yocto would reject)",
    from: "depositYocto: payload.depositYocto ?? ONE_YOCTO,",
    to: "depositYocto: payload.depositYocto,",
  },
  {
    name: "M5 gas default dropped",
    from: "gasTgas: payload.gasTgas ?? DEFAULT_GAS_TGAS,",
    to: "gasTgas: payload.gasTgas,",
  },
  {
    name: "M6 network not encoded",
    from: "network=${encodeURIComponent(network)}",
    to: "network=${network}",
  },
  {
    name: "M7 UTF-8 encode dropped (btoa throws on the branch glyph)",
    from: "const bytes = new TextEncoder().encode(json);",
    to: "const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));",
  },
  {
    name: "M8 UTF-8 decode dropped (mojibake, silent)",
    from: "return new TextDecoder().decode(bytes);",
    to: "return binary;",
  },
];

for (const m of MUTANTS) {
  if (!orig.includes(m.from)) {
    console.log(`  SKIP (pattern absent)  ${m.name}`);
    continue;
  }
  writeFileSync(p, orig.replace(m.from, m.to));
  let verdict;
  try {
    execSync("npx vitest run lib/sign-link.test.ts", { cwd: "apps/dashboard", stdio: "pipe" });
    verdict = "SURVIVED <-- NOT COVERED";
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
console.log(`  reverted byte-identical: ${readFileSync(p, "utf8") === orig}`);

#!/usr/bin/env node
/**
 * After a deploy, confirm the live create page is the one this repo ships.
 *
 * THE WASM COMPARISON IS THE POINT, and it is not cosmetic. ARCHITECTURE.md §4
 * records that NOTHING ON-CHAIN PINS THE VAULT BUILD: `create_vault_with_code`
 * takes the contract as an ARGUMENT and never reads the factory's `code_hash`,
 * which is consulted only by the unused global-contract path. So the code a
 * user's vault runs is whatever this page serves at that moment, and the only
 * thing standing between that and a wrong build is a comparison somebody
 * remembers to make. This is that comparison, as a command.
 *
 * The pull that fixed skill.md also replaced web/index.html on a live site
 * (the mainnet-default flip). `serve.mjs` reads per request, so the change was
 * instant — which is convenient and also means nothing staged it for review.
 *
 * In a FILE rather than `node -e`, because the checks need both quote styles
 * and nested parentheses, and this session has already lost two one-liners to
 * shell quoting.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const b58 = (buf) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${buf.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = A[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const x of buf) {
    if (x === 0) out = `1${out}`;
    else break;
  }
  return out;
};

const page = await fetch("https://usefloat.xyz/", { signal: AbortSignal.timeout(20000) });
const html = await page.text();
console.log(`create page   ${page.status}  ${html.length} bytes`);

const CHECKS = [
  ["connect screen present", "Connect wallet"],
  ["mainnet is now the default", 'q.get("network") === "testnet"'],
  ["fetches the contract", "./vault.wasm"],
  ["agent-key consent gate", "The key matches"],
];
for (const [label, needle] of CHECKS) {
  console.log(`  ${html.includes(needle) ? "ok  " : "MISS"} ${label}`);
}

const w = await fetch("https://usefloat.xyz/vault.wasm", { signal: AbortSignal.timeout(30000) });
const bytes = Buffer.from(await w.arrayBuffer());
const live = b58(createHash("sha256").update(bytes).digest());
const repo = b58(
  createHash("sha256").update(readFileSync("packages/create-float/res/vault.wasm")).digest(),
);

console.log("");
console.log(`vault.wasm    ${w.status}  ${bytes.length} bytes`);
console.log(`  live  ${live}`);
console.log(`  repo  ${repo}`);
console.log(
  live === repo
    ? "  IDENTICAL — the page deploys the artifact this repo ships"
    : "  *** DIFFERENT — the page would deploy code this repo did not build ***",
);

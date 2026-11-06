/**
 * Add `network` to the /agents VaultInfo type.
 *
 * The adapter has always returned it - confirmed against the live endpoint,
 * whose keys are vaultId, tokenId, tokenDecimals, network, explorerBase,
 * owner, paused, clockMode, strictAllocation, vaultTokenBalance - the page's
 * local type just never declared it, because nothing on the page had needed
 * it until the signing link did.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

const p = "apps/dashboard/app/agents/page.tsx";
const raw = readFileSync(p, "utf8");
const WAS_CRLF = raw.includes(CRLF);
let s = raw.split(CRLF).join(LF);

const from = [
  "type VaultInfo = {",
  "  vaultId: string;",
  "  explorerBase: string;",
].join(LF);

const to = [
  "type VaultInfo = {",
  "  vaultId: string;",
  "  /** Declared because the signing link needs it; the adapter always sent it. */",
  "  network: string;",
  "  explorerBase: string;",
].join(LF);

if (!s.includes(from)) throw new Error("VaultInfo not found in the expected shape");
s = s.replace(from, to);

writeFileSync(p, WAS_CRLF ? s.split(LF).join(CRLF) : s);
console.log(`  network added to VaultInfo (CRLF preserved: ${WAS_CRLF})`);

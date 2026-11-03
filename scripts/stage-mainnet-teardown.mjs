#!/usr/bin/env node
/**
 * Emit the mainnet teardown commands as PowerShell ONE-LINERS.
 *
 * Mainnet writes are blocked for me by the permission classifier, so these are
 * handed over rather than run. That makes the exact text the deliverable, and
 * I have now got it wrong three times in one session by handing over bash:
 *
 *   `bash scripts/...`      -> PowerShell's `bash` is WSL, which cannot see
 *                              the Windows cargo install
 *   `claude mcp add ... --` -> PowerShell eats the `--` separator
 *   trailing `\`            -> a bash line continuation; PowerShell reads the
 *                              backslash as an argument and then tries to run
 *                              `json-args` as a command
 *
 * So: ONE LINE each, no continuations, no `--`, no `~`. Values are read from
 * the chain at generation time rather than copied from a document that was
 * written hours ago, and every credential path is checked to exist before a
 * command mentioning it is printed.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
const RPC = process.env.RPC ?? "https://free.rpc.fastnear.com";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const OWNER = "test015.near";
const VAULT = "float.test015.near";
const STUB = join(ROOT, ".demo", "stub-new.wasm");

const cred = (a) => join(homedir(), ".near-credentials", "mainnet", `${a}.json`);
for (const a of [OWNER, VAULT]) {
  if (!existsSync(cred(a))) {
    console.error(`FATAL: no mainnet credential at ${cred(a)}`);
    process.exit(1);
  }
}
if (!existsSync(STUB)) {
  console.error(`FATAL: ${STUB} missing — run: node scripts/make-stub-wasm.mjs`);
  process.exit(1);
}

const p = new JsonRpcProvider({ url: RPC });
const view = (c, m, a = {}) =>
  p.callFunction({ contractId: c, method: m, args: a, blockQuery: { finality: "final" } });
const near = (y) => (Number(y) / 1e24).toFixed(5);

// LIVE, not remembered. A staged amount copied from an old reading is how a
// withdraw leaves dust behind or reverts outright.
const vaultUsdc = String(await view(USDC, "ft_balance_of", { account_id: VAULT }));
const ownerUsdc = String(await view(USDC, "ft_balance_of", { account_id: OWNER }));
const acct = await p.viewAccount({ accountId: VAULT, blockQuery: { finality: "final" } });
const code = Buffer.from(
  (await p.viewContractCode({ contractId: VAULT, blockQuery: { finality: "final" } })).code_base64,
  "base64",
);
const stateBytes = acct.storage_usage - code.length;

console.log(`\n  read from chain just now:`);
console.log(`    vault USDC     ${(Number(vaultUsdc) / 1e6).toFixed(6)}  (${vaultUsdc} base units)`);
console.log(`    owner USDC     ${(Number(ownerUsdc) / 1e6).toFixed(6)}`);
console.log(`    vault storage  ${acct.storage_usage} B = ${code.length} code + ${stateBytes} state`);
console.log(`    shrink frees   ${near(BigInt(code.length - 33) * 10n ** 19n)} NEAR`);
// The ONLY datapoint for where the bound actually sits is the testnet
// refusal at 10,330 B. Compare against it rather than repeating a verdict
// that was written when the state was twice this size — a stale prediction
// stated confidently is how a plan stops matching the chain.
{
  const afterShrink = 33 + stateBytes;
  const REFUSED_AT = 10330;
  console.log(
    `    after shrink   ${afterShrink} B remains -> ` +
      (afterShrink < REFUSED_AT
        ? `delete is PLAUSIBLE (${REFUSED_AT - afterShrink} B under the testnet refusal at ${REFUSED_AT})`
        : `delete will almost certainly refuse (testnet refused at ${REFUSED_AT})`),
  );
}

if (vaultUsdc === "0") {
  console.log(`\n  Step 1 is already DONE — the vault holds no USDC.`);
}

const q = (s) => `'${s}'`;
const line = (parts) => parts.join(" ");

console.log(`\n${"=".repeat(78)}`);
console.log(`PowerShell. ONE LINE EACH. Run step 1, then stop and tell me.`);
console.log("=".repeat(78));

console.log(`\n--- STEP 1: rescue the USDC (IRREVERSIBLE, do first) ---\n`);
console.log(
  line([
    "near contract call-function as-transaction",
    VAULT,
    "withdraw json-args",
    q(JSON.stringify({ token: USDC, amount: vaultUsdc, receiver_id: OWNER })),
    "prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR'",
    "sign-as",
    OWNER,
    "network-config mainnet sign-with-access-key-file",
    q(cred(OWNER)),
    "send",
  ]),
);

/**
 * PURGE BEFORE SHRINKING, to give the delete a chance.
 *
 * The account cannot be deleted while it carries too much trie state — testnet
 * refused at 10,330 B. Each stored payment record is ~287 B, and
 * `purge_settled` is the only lever that shrinks STATE rather than CODE.
 * Dropping ~2,583 B takes the post-shrink account to ~4,698 B, comfortably
 * under the figure that refused, so a clean delete becomes plausible — and a
 * delete returns the WHOLE balance and leaves no husk, where a sweep strands
 * the remaining storage stake permanently.
 *
 * Must run BEFORE the shrink: `purge_settled` is a vault method and the stub
 * does not have it.
 *
 * `before_day` comes from the contract's own `current_day`, not an assumption.
 * Records are removed strictly BEFORE it, so today+1 catches every one.
 */
const PURGE_FILE = join(ROOT, ".demo", "purge-args.json");
{
  const day = Number(await view(VAULT, "current_day"));
  const payload = JSON.stringify({ before_day: day + 1, limit: 100 }, null, 2) + "\n";
  if (existsSync(PURGE_FILE)) rmSync(PURGE_FILE);
  writeFileSync(PURGE_FILE, payload, "utf8");
  const back = JSON.parse(readFileSync(PURGE_FILE, "utf8"));
  if (back.before_day !== day + 1 || back.limit !== 100) {
    console.error("FATAL: purge args did not round-trip.");
    process.exit(1);
  }
  console.log(`\n--- STEP 2.5: purge stored requests so the delete can succeed ---\n`);
  console.log(
    line([
      "near contract call-function as-transaction",
      VAULT,
      "purge_settled file-args",
      q(PURGE_FILE),
      "prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR'",
      "sign-as",
      OWNER,
      "network-config mainnet sign-with-access-key-file",
      q(cred(OWNER)),
      "send",
    ]),
  );
}

console.log(`\n--- STEP 2: reclaim the vault's token registration (after I verify step 1) ---\n`);
console.log(
  line([
    "near contract call-function as-transaction",
    USDC,
    "storage_unregister json-args '{}'",
    "prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR'",
    "sign-as",
    VAULT,
    "network-config mainnet sign-with-access-key-file",
    q(cred(VAULT)),
    "send",
  ]),
);

console.log(`\n--- STEP 3: shrink the contract, freeing the stake ---\n`);
console.log(
  line([
    "near contract deploy",
    VAULT,
    "use-file",
    q(STUB),
    "without-init-call network-config mainnet sign-with-access-key-file",
    q(cred(VAULT)),
    "send",
  ]),
);

console.log(`\n--- STEP 4: try the delete (expected to refuse; nothing lost if it does) ---\n`);
console.log(
  line([
    "near account delete-account",
    VAULT,
    "beneficiary",
    OWNER,
    "network-config mainnet sign-with-access-key-file",
    q(cred(VAULT)),
    "send",
  ]),
);

console.log(`\n--- STEP 5: sweep. I will read the exact amount after step 3. ---\n`);
console.log(
  line([
    "near tokens",
    VAULT,
    "send-near",
    OWNER,
    "'<AMOUNT> NEAR'",
    "network-config mainnet sign-with-access-key-file",
    q(cred(VAULT)),
    "send",
  ]),
);
console.log();

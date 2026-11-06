/**
 * Does a credential file on disk actually control the account it is named for?
 *
 * The question that needs answering when a wallet says "access key doesn't
 * match": is the file wrong, or was the paste wrong? A NEAR credential file
 * holds both halves of the keypair, so the file can be checked against the
 * chain without anyone typing anything.
 *
 * NOTHING SECRET IS PRINTED. The secret is read, used to derive the public
 * half, and the public half is what comes out. That matters more than usual
 * here: this session's transcript already contains a pasted private key
 * because it arrived inside a screenshot, and the whole point of a script
 * like this is that the human never has to open the file and look.
 *
 * It also re-derives rather than trusting the file's own `public_key` field.
 * Those two can disagree — a hand-edited or half-copied file is exactly the
 * failure being diagnosed — and the derived value is the one the network
 * will check against.
 *
 *   node scripts/check-credential-matches.mjs <account-id> [network]
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// near-api-js, not @near-js/crypto — the latter is not installed at the repo
// root, and a missing import is invisible to `node --check`.
import { KeyPair } from "near-api-js";

const account = process.argv[2];
const network = process.argv[3] ?? "testnet";
if (!account) {
  console.error("usage: node scripts/check-credential-matches.mjs <account-id> [network]");
  process.exit(2);
}

const file = path.join(homedir(), ".near-credentials", network, `${account}.json`);
const rpc = `https://rpc.${network}.near.org`;

/** The public keys the CHAIN says control this account. */
async function onChainKeys() {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_access_key_list", finality: "final", account_id: account },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  // A permission is either the string "FullAccess" or an object with one key.
  return json.result.keys.map((k) => ({
    publicKey: k.public_key,
    permission:
      typeof k.access_key.permission === "string"
        ? k.access_key.permission
        : Object.keys(k.access_key.permission)[0],
  }));
}

let raw;
try {
  raw = JSON.parse(await readFile(file, "utf8"));
} catch (e) {
  console.log(`file     ${file}`);
  console.log(`         UNREADABLE: ${e.message}`);
  process.exit(1);
}

// Older near-cli wrote `secret_key`; newer writes `private_key`. A file with
// neither is a public-only stub and cannot sign.
const secret = raw.private_key ?? raw.secret_key ?? null;

console.log(`account  ${account}  (${network})`);
console.log(`file     ${file}`);
console.log(`         keys present: ${Object.keys(raw).join(", ")}`);

if (!secret) {
  console.log(`         NO PRIVATE KEY IN FILE — this cannot sign anything.`);
  process.exit(1);
}

// The PREFIX is the thing under suspicion, so report its presence explicitly.
const hasPrefix = typeof secret === "string" && secret.includes(":");
const curve = hasPrefix ? secret.slice(0, secret.indexOf(":")) : "(none)";
const body = hasPrefix ? secret.slice(secret.indexOf(":") + 1) : secret;

console.log(`         curve prefix: ${curve}`);
console.log(`         base58 body length: ${body.length} chars`);

let derived;
try {
  // KeyPair.fromString wants the prefixed form; add it if the file omitted one.
  derived = KeyPair.fromString(hasPrefix ? secret : `ed25519:${secret}`)
    .getPublicKey()
    .toString();
} catch (e) {
  console.log(`         CANNOT PARSE the private key: ${e.message}`);
  process.exit(1);
}

console.log(`         derived public key: ${derived}`);
if (raw.public_key && raw.public_key !== derived) {
  console.log(`         !! file's own public_key field DISAGREES: ${raw.public_key}`);
}

const chain = await onChainKeys();
console.log();
console.log(`on chain ${chain.length} key(s):`);
for (const k of chain) {
  const mark = k.publicKey === derived ? "  <== MATCHES THE FILE" : "";
  console.log(`         ${k.publicKey}  ${k.permission}${mark}`);
}

console.log();
if (chain.some((k) => k.publicKey === derived)) {
  console.log(`VERDICT  the file controls ${account}. A wallet rejecting it is a`);
  console.log(`         FORMAT problem with what was pasted, not the wrong file.`);
  console.log(`         Paste the WHOLE value including the "${curve}:" prefix.`);
} else {
  console.log(`VERDICT  the file does NOT control ${account}. Its key is not one of`);
  console.log(`         the account's access keys — the file is stale or belongs`);
  console.log(`         to a different account.`);
  process.exitCode = 1;
}

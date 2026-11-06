/**
 * Build an owner-less create link that carries an agent key.
 *
 * WHY THIS IS NOT JUST `vault_create({bindAgent:true})`. That tool refuses an
 * agent when the owner is unknown, and the refusal is correct: the adapter
 * files a credential under the account the key signs AS, which for a virtual
 * agent is the VAULT, and the vault id is derived from the owner. With no
 * owner there is nothing to derive it from, and a record with the wrong
 * `agentId` is not a loud failure — `loadKeyring` skips any entry whose
 * `agentId` is not a string, in total silence. The agent would look set up
 * and simply never be found.
 *
 * But the owner-less link is the whole stranger-onboarding flow, so the
 * answer is to SPLIT the write rather than guess the id:
 *
 *   now    generate the key, stash the secret in .float/pending-agent.json
 *   later  once the vault exists on chain, `--complete` files the real
 *          credential under the real vault id
 *
 * The secret is on disk from the first moment, so nothing is lost if the
 * second step never runs — and the second step needs no secret material it
 * did not already have.
 *
 *   node scripts/make-agent-link.mjs
 *   node scripts/make-agent-link.mjs --complete <vault-id>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { KeyPair } from "near-api-js";

import { generateAgentKey } from "../packages/mcp/dist/agent-key.js";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, ".float");
const PENDING = join(DIR, "pending-agent.json");
const APP = process.env.APP_URL ?? "http://127.0.0.1:8080";
const FACTORY = process.env.FACTORY ?? "fac.floatv4.testnet";
const NETWORK = process.env.NETWORK ?? "testnet";

function complete(vault) {
  if (!existsSync(PENDING)) {
    console.error(`FATAL: no ${PENDING} — nothing is waiting to be filed.`);
    return 1;
  }
  const pending = JSON.parse(readFileSync(PENDING, "utf8"));
  // Re-derive the public key from the stored secret rather than trusting the
  // stored public half. If those two ever disagree the secret is what the
  // chain will check, and a credential filed against the wrong public key is
  // the kind of thing that only surfaces at the first payment.
  const derived = KeyPair.fromString(pending.secret).getPublicKey().toString();
  if (derived !== pending.publicKey) {
    console.error(`FATAL: ${PENDING} is inconsistent — its secret derives ${derived},`);
    console.error(`  but it records ${pending.publicKey}. Not filing a credential from it.`);
    return 1;
  }

  const keyringPath = join(DIR, "agent-keys.json");
  let existing = [];
  if (existsSync(keyringPath)) {
    const parsed = JSON.parse(readFileSync(keyringPath, "utf8"));
    if (Array.isArray(parsed)) existing = parsed;
  }
  // The shape `loadKeyring` accepts: a string `agentId` and a string `secret`.
  // Anything else is dropped without a word.
  existing.push({ agentId: vault, secret: pending.secret, nodeId: 0, publicKey: pending.publicKey });
  writeFileSync(keyringPath, JSON.stringify(existing, null, 2) + "\n");
  writeFileSync(
    join(DIR, "agent.env"),
    [
      `# Written by make-agent-link --complete. Contains a PRIVATE KEY.`,
      `NEAR_VAULT_AGENT_ID=${vault}`,
      `NEAR_VAULT_AGENT_KEY=${pending.secret}`,
      ``,
    ].join("\n"),
  );
  console.log(`filed ${pending.publicKey}`);
  console.log(`  as agent for ${vault}`);
  console.log(`  -> ${keyringPath}`);
  console.log(`  -> ${join(DIR, "agent.env")}`);
  return 0;
}

if (process.argv[2] === "--complete") {
  const vault = process.argv[3];
  if (!vault) {
    console.error("usage: node scripts/make-agent-link.mjs --complete <vault-id>");
    process.exit(2);
  }
  process.exitCode = complete(vault);
} else {
  mkdirSync(DIR, { recursive: true });
  if (existsSync(PENDING)) {
    // Refuse rather than overwrite: the stashed secret may belong to a link
    // already sent, and the vault it creates would be unreachable without it.
    console.error(`FATAL: ${PENDING} already exists.`);
    console.error(`  A key is already waiting to be filed. Complete it first:`);
    console.error(`    node scripts/make-agent-link.mjs --complete <vault-id>`);
    console.error(`  or delete the file if that link was never used.`);
    process.exit(1);
  }

  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  writeFileSync(
    PENDING,
    JSON.stringify({ publicKey, secret: kp.toString(), factory: FACTORY, network: NETWORK }, null, 2) +
      "\n",
  );

  const url = new URL(APP);
  url.searchParams.set("factory", FACTORY);
  url.searchParams.set("network", NETWORK);
  url.searchParams.set("agent_pk", publicKey);

  console.log(`agent public key`);
  console.log(`  ${publicKey}`);
  console.log(`  secret stashed at ${PENDING} (not printed)`);
  console.log();
  console.log(`link`);
  console.log(`  ${url.toString()}`);
  console.log();
  console.log(`after signing, file the credential:`);
  console.log(`  node scripts/make-agent-link.mjs --complete <vault-id>`);
}

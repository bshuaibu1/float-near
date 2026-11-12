#!/usr/bin/env node
/**
 * Retire ONE agent: recover its gas, then revoke its authority to spend.
 *
 * WHY THIS EXISTS. Unbinding an agent is one owner signature and leaves its
 * NEP-611 gas key funded on the vault — safe, but the NEAR is then reachable
 * only by tearing the whole vault down. Worse, the obvious tidy-up is to
 * delete the orphaned key, and `DeleteKey` on a funded gas key BURNS the
 * balance and reports SUCCESS. Measured in this repo: 0.08322 NEAR gone, the
 * transaction green, nothing to appeal to.
 *
 * So "retire an agent" had a correct path nobody would find and a natural path
 * that destroys money. This is the correct path, made the easy one.
 *
 * ORDER IS THE WHOLE SAFETY PROPERTY: withdraw, verify, THEN unbind. If the
 * withdrawal fails this stops without revoking anything, because an agent that
 * still works is a problem you can retry — an unbound key holding stranded gas
 * is one nobody revisits. float-exit uses the same ordering and the same
 * refusal for the same reason.
 *
 * TWO SIGNERS, ONE CREDENTIAL. The withdrawal must be signed by the VAULT
 * (`withdrawFromGasKey` acts on the vault's own key) and the unbind by the
 * OWNER (`assert_owner`). The factory puts the owner's key on the vault as
 * full-access at creation, so one credential covers both — which is also why
 * this cannot be done from a browser: wallets ignore `signerId` and silently
 * sign as the connected account.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// One import, matching float-exit. The @near-js/* scoped packages are not
// direct dependencies here, so importing them works until a clean install.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey } from "near-api-js";

import { resolveVaultSigner } from "./float-exit.mjs";

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  d: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const info = (m) => console.log(`    ${C.d("·")}    ${m}`);
const warn = (m) => console.log(`    ${C.y("!")}    ${m}`);
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const near = (y) => (Number(y) / 1e24).toFixed(6);

const ARGV = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = ARGV.indexOf(name);
  return i === -1 || i === ARGV.length - 1 ? dflt : ARGV[i + 1];
};
const has = (name) => ARGV.includes(name);

const DRY = has("--dry-run");
const NETWORK = opt("--network", "mainnet");
const RPC = {
  mainnet: "https://free.rpc.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
}[NETWORK];

const credPath = (a) =>
  join(
    process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials"),
    NETWORK,
    `${a}.json`,
  );
const readCred = (a) => {
  const p = credPath(a);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j.private_key ?? j.secret_key ?? null;
  } catch {
    return null;
  }
};

/**
 * Which key to retire, from a role name or the key itself.
 *
 * A ROLE IS THE USABLE HANDLE. Nobody remembers `ed25519:E2PGijm4Yq…`, and
 * asking someone to paste the right one of several keys into a command that
 * revokes access is how the wrong agent gets retired. The keyring already maps
 * role -> publicKey, so the name they chose is the name they can use.
 *
 * SCOPED TO THIS VAULT. An entry's `agentId` is the vault it was issued for,
 * and role names are not unique across vaults — every vault has a "root". An
 * unscoped lookup would find whichever was written first, which is how a
 * testnet credential nearly got used to sign a mainnet payment in this repo.
 */
function resolveKey(target, vault, keysPath) {
  if (target.startsWith("ed25519:")) return { publicKey: target, via: "argument" };
  if (!existsSync(keysPath)) {
    return { error: `no keyring at ${keysPath}, so "${target}" cannot be resolved to a key. Pass the ed25519:… key directly.` };
  }
  let entries;
  try {
    // STRIP A BOM. PowerShell's Out-File writes one by default and
    // JSON.parse rejects it at byte 0 — which already broke this keyring once
    // and read as "the file is corrupt" rather than "the encoding is wrong".
    entries = JSON.parse(readFileSync(keysPath, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    return { error: `${keysPath} is not readable JSON (${e.message}). A UTF-8 BOM does this.` };
  }
  const mine = entries.filter((e) => (e.agentId ?? e.vault) === vault);
  const hit = mine.find((e) => e.role === target);
  if (!hit) {
    const known = mine.map((e) => e.role ?? "(unnamed)").join(", ") || "none";
    return { error: `no agent with role "${target}" for ${vault}. Known: ${known}.` };
  }
  return { publicKey: hit.publicKey, via: `role "${target}"` };
}

async function main() {
  const target = opt("--retire");
  const owner = opt("--owner");
  const vault = opt("--vault");

  if (!target || !owner || !vault) {
    console.error(`
${C.b("float retire")} ${C.d("— recover an agent's gas, then revoke its access")}

  --retire <role|ed25519:…>   which agent
  --owner  <account>          the vault's owner
  --vault  <account>          the vault
  --dry-run                   show everything, write nothing
  --network mainnet|testnet   default mainnet
`);
    process.exitCode = 2;
    return;
  }
  if (!RPC) throw new Error(`unknown network ${NETWORK} — use --network mainnet|testnet`);

  console.log(
    `\n${C.b("float retire")} ${C.d(`— recover an agent's gas, then revoke its access (${NETWORK})`)}`,
  );

  const provider = new JsonRpcProvider({ url: RPC });
  const view = (contractId, method, args = {}) =>
    provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });

  // ---- [0] Can we sign as the vault AND as the owner?
  step(0, "Authorisation");
  const ownerSecret = readCred(owner);
  if (!ownerSecret) throw new Error(`no credential for ${owner} at ${credPath(owner)}`);
  const ownerKp = KeyPair.fromString(ownerSecret);

  const vaultKeys = (await provider.viewAccessKeyList({ accountId: vault, blockQuery: { finality: "final" } })).keys;
  const signer = resolveVaultSigner({
    vaultKeys,
    ownerPublicKey: ownerKp.getPublicKey().toString(),
    ownerSecret,
    vaultSecret: readCred(vault),
  });
  if (!signer.secret) {
    throw new Error(
      `nothing can sign as ${vault}. Recovering a gas key needs a signature whose ` +
        `signer_id is the VAULT, and ${signer.fullAccessCount} full-access key(s) are on it, ` +
        `none of them yours.`,
    );
  }
  ok(`${owner} can act as ${vault}${signer.via === "owner" ? " — its key is full-access on the vault" : ""}`);

  // ---- [1] Which agent, and what is on its key?
  step(1, "The agent");
  const keysPath = opt("--keys", join(".float", "agent-keys.json"));
  const found = resolveKey(target, vault, keysPath);
  if (found.error) throw new Error(found.error);

  const key = vaultKeys.find((k) => k.public_key === found.publicKey);
  if (!key) {
    throw new Error(
      `${found.publicKey} is not a key on ${vault}. It may already have been removed, ` +
        `or it belongs to a different vault.`,
    );
  }
  const gas = key.access_key.permission?.GasKeyFunctionCall;
  if (!gas) {
    warn(`${found.publicKey.slice(0, 24)}… is not a gas key — nothing to recover, only unbind`);
  }
  const balance = gas ? BigInt(gas.balance) : 0n;

  // WHICH NODE, so the operator can see they are retiring the agent they meant.
  const node = await view(vault, "get_virtual_agent_node", { public_key: found.publicKey }).catch(
    () => null,
  );
  info(`key      ${found.publicKey.slice(0, 24)}… ${C.d(`(${found.via})`)}`);
  info(`node     ${node === null ? "not bound to any node" : `#${node}`}`);
  info(`gas      ${balance === 0n ? "none" : `${near(balance)} NEAR`}`);

  const vaultAcct = new Account(vault, provider, new KeyPairSigner(KeyPair.fromString(signer.secret)));
  const ownerAcct = new Account(owner, provider, new KeyPairSigner(ownerKp));

  // ---- [2] GAS FIRST. See the header: order is the safety property.
  step(2, "Recovering the gas");
  if (balance === 0n) {
    ok("nothing to recover");
  } else if (DRY) {
    info(`would withdraw ${near(balance)} NEAR into ${vault}`);
    info(C.d("then re-read the key to confirm it is empty before revoking anything"));
  } else {
    try {
      await vaultAcct.withdrawFromGasKey(PublicKey.fromString(found.publicKey), balance);
    } catch (e) {
      throw new Error(
        `could not recover the gas (${e.message}). STOPPING before revoking access: ` +
          `an agent that still works can be retried, but an unbound key holding ` +
          `${near(balance)} NEAR is money nobody comes back for.`,
      );
    }
    // VERIFY, do not assume. A transaction can report success while the
    // balance stays put, and the next step is irreversible.
    const after = (await provider.viewAccessKeyList({ accountId: vault, blockQuery: { finality: "final" } })).keys.find(
      (k) => k.public_key === found.publicKey,
    );
    const left = BigInt(after?.access_key.permission?.GasKeyFunctionCall?.balance ?? 0);
    if (left !== 0n) {
      throw new Error(
        `withdrawal reported success but ${near(left)} NEAR is still on the key. ` +
          `NOT revoking access — re-run once this reads zero.`,
      );
    }
    ok(`recovered ${near(balance)} NEAR into ${vault}`);
  }

  // ---- [3] Only now.
  step(3, "Revoking access");
  if (node === null) {
    ok("already unbound — the key cannot authorise a payment");
  } else if (DRY) {
    info(`would unbind ${found.publicKey.slice(0, 24)}… from node #${node}`);
  } else {
    await ownerAcct.callFunction({
      contractId: vault,
      methodName: "unbind_virtual_agent",
      args: { public_key: found.publicKey },
      gas: 100_000_000_000_000n,
      deposit: 1n,
    });
    ok(`unbound from node #${node} — it can no longer authorise a payment`);
  }

  // ---- [4] What is left behind, said plainly.
  step(4, "What is left");
  info(`the node and its budget stay — retiring an agent does not delete its node`);
  info(`the access key stays on ${vault}, now empty and unbound`);
  warn(
    `do NOT delete that key to tidy up: DeleteKey on a funded gas key BURNS the ` +
      `balance and reports success. It is empty now, so there is nothing to lose — ` +
      `but the habit is what costs.`,
  );

  console.log(
    DRY
      ? `\n    ${C.d("· dry run — nothing was written")}\n`
      : `\n    ${C.g("retired")} ${target}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(`\n${C.r("failed")}  ${e.message}\n`);
    // process.exitCode, never process.exit: RPC handles may still be closing
    // and process.exit aborts the loop with UV_HANDLE_CLOSING, replacing a
    // clean 1 with -1073740791. Already fixed twice in this repo.
    process.exitCode = 1;
  }
}

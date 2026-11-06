#!/usr/bin/env node
/**
 * Unwinds a Float vault and refunds the owner.
 *
 * This exists because "your deposit is refundable" is only a true statement if
 * getting it back is one command. A documented multi-step recovery procedure
 * is one nobody performs, and the part they skip is the expensive part.
 *
 * ORDER IS LOAD-BEARING. A NEP-141 balance lives in the TOKEN contract, keyed
 * by account id. Deleting the NEAR account does NOT return those tokens — they
 * are stranded permanently, with the key that could have moved them gone. So
 * tokens are withdrawn FIRST, and a non-zero balance we failed to move is a
 * hard stop, never a warning.
 *
 *   1. read every token balance the vault holds
 *   2. withdraw each to the owner, and VERIFY each went to zero
 *   3. delete agent accounts, refunding unspent gas float to the vault
 *   4. delete the vault, refunding its balance + storage stake to the owner
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";

const ARGV = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = ARGV.indexOf(name);
  return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt;
};
const has = (name) => ARGV.includes(name);

const NETWORK = opt("--network", "mainnet");
const YES = has("--yes");
const DRY = has("--dry-run");

const RPC = {
  mainnet: "https://free.rpc.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
}[NETWORK];
if (!RPC) throw new Error(`unknown network ${NETWORK}`);

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const info = (m) => console.log(`    ${C.dim("·")}    ${m}`);
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const fmtNear = (y) => (Number(y) / 1e24).toFixed(4);

const CRED_DIR = join(
  process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials"),
  NETWORK,
);
const credPath = (id) => join(CRED_DIR, `${id}.json`);

function loadKey(id) {
  const p = credPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")).private_key;
}

const ask = (rl, q) =>
  new Promise((res) => rl.question(`    ${q} `, (a) => res(a.trim())));

async function main() {
  console.log(`\n${C.b("float exit")} ${C.dim(`— unwind a vault and refund the owner (${NETWORK})`)}`);

  const owner = opt("--owner");
  if (!owner) throw new Error("--owner is required");
  const vault = opt("--vault", `float.${owner}`);

  const provider = new JsonRpcProvider({ url: RPC });

  step(0, "Keys");
  const vaultSecret = loadKey(vault);
  if (!vaultSecret) {
    throw new Error(
      [
        `no key for ${vault} at ${credPath(vault)}`,
        "",
        "  Without it the vault cannot be deleted and its storage stake cannot",
        "  be refunded. If that file is lost, the stake is unrecoverable — there",
        "  is no seed phrase and no recovery flow.",
      ].join("\n"),
    );
  }
  ok(`${vault} key found`);
  const ownerSecret = loadKey(owner);
  if (!ownerSecret) throw new Error(`no key for ${owner} at ${credPath(owner)}`);
  ok(`${owner} key found`);

  const vaultAcct = new Account(vault, provider, new KeyPairSigner(KeyPair.fromString(vaultSecret)));

  // ---- 1. What does it hold, and what did it create?
  //
  // Both come from get_tree(). There is no list_token_balances or list_agents
  // on this contract — every token the vault can hold appears as a TokenLimit
  // on some node, and every agent is a node with `account` set. Deriving both
  // from the tree means this cannot miss a token that a node was budgeted for.
  step(1, "Reading the tree");
  const tree = await provider.callFunction({
    contractId: vault,
    method: "get_tree",
    args: {},
  });
  if (!Array.isArray(tree)) {
    throw new Error(`get_tree() returned ${typeof tree}, expected an array. Refusing to proceed.`);
  }
  ok(`${tree.length} nodes`);

  const tokens = [...new Set(tree.flatMap((n) => (n.limits ?? []).map((l) => l.token)))];
  const agentIds = tree.map((n) => n.account).filter(Boolean);

  if (!tokens.length) {
    throw new Error(
      [
        "no token appears in any node's limits, so this tool cannot tell what",
        "the vault may hold.",
        "",
        "  Refusing to delete it: a NEP-141 balance left behind is stranded",
        "  permanently once the account is gone. Withdraw manually first:",
        `    near call ${vault} withdraw '{"token":"<id>","amount":"<amt>","receiver_id":"${owner}"}' --accountId ${owner}`,
      ].join("\n"),
    );
  }
  for (const t of tokens) info(`token  ${t}`);
  for (const a of agentIds) info(`agent  ${a}`);

  // ---- 2. Withdraw, then VERIFY. An unverified withdrawal is not a withdrawal.
  step(2, "Withdrawing to the owner");
  for (const token of tokens) {
    const t = { token };
    const bal = await provider.callFunction({
      contractId: t.token,
      method: "ft_balance_of",
      args: { account_id: vault },
    });
    const amount = BigInt(bal ?? 0);
    if (amount === 0n) {
      ok(`${t.token} — already zero`);
      continue;
    }
    if (DRY) {
      info(`would withdraw ${amount} of ${t.token} to ${owner}`);
      continue;
    }
    await vaultAcct.callFunction({
      contractId: vault,
      methodName: "withdraw",
      args: { token: t.token, amount: amount.toString(), receiver_id: owner },
      gas: 100n * 10n ** 12n,
      deposit: 1n,
    });
    const after = BigInt(
      (await provider.callFunction({
        contractId: t.token,
        method: "ft_balance_of",
        args: { account_id: vault },
      })) ?? 0,
    );
    if (after !== 0n) {
      throw new Error(
        `withdrawal of ${t.token} left ${after} behind. STOPPING before deletion — ` +
          `deleting the account now would strand it permanently.`,
      );
    }
    ok(`${t.token} — withdrew ${amount}, balance verified zero`);
  }

  // ---- 3. Agents. Their unspent float returns to the vault.
  // ---- 3. Agents.
  //
  // An agent's own key is a FUNCTION-CALL access key restricted to
  // request_payment. Such keys can sign exactly one FunctionCall action — they
  // cannot sign DeleteAccount. So an agent account is only deletable if a
  // FULL-access key for it happens to exist locally, which the wizard does not
  // create. For the normal case this step deletes nothing, and says so.
  //
  // What is actually at stake is small: of each 0.55 NEAR, the 0.50 gas float
  // is consumed by the agent's own calls (its purpose, not a loss) and 0.05 is
  // staked storage. Stating that plainly beats "its float stays there", which
  // implied the whole 0.55 was stranded.
  step(3, "Agent accounts");
  if (!agentIds.length) info("no agents bound");
  let unreclaimed = 0;
  for (const id of agentIds) {
    const secret = loadKey(id);
    if (!secret) {
      unreclaimed++;
      info(`${id} — no full-access key locally, leaving in place`);
      continue;
    }
    if (DRY) {
      info(`would delete ${id}, refunding to ${vault}`);
      continue;
    }
    const acct = new Account(id, provider, new KeyPairSigner(KeyPair.fromString(secret)));
    await acct.deleteAccount(vault);
    ok(`${id} deleted — unspent float returned to ${vault}`);
  }

  if (unreclaimed) {
    // ~0.55 each, not ~0.05. Measured on live agents: the gas reserve is
    // barely consumed (busiest demo agent had burned 0.0077 NEAR), because
    // NEAR locks prepaid gas and refunds it. So almost the entire deposit is
    // sitting in those accounts, and without a full-access key it stays there.
    info(
      `${unreclaimed} agent account(s) hold ~${(unreclaimed * 0.55).toFixed(2)} NEAR that CANNOT be reclaimed.`,
    );
    info("Their gas reserve is near-untouched, but a function-call key cannot");
    info("sign DeleteAccount, and no full-access key for them exists.");
  }

  // ---- 4. The vault itself.
  step(4, "The vault");
  const balance = await vaultAcct.getBalance();
  console.log(`    ${C.b("about to delete")} ${vault}`);
  console.log(`    ${C.b("refunding")} ${C.b(fmtNear(balance))} NEAR ${C.b("to")} ${C.b(owner)}`);
  console.log(`    ${C.y("This is irreversible. The contract and all its state are destroyed.")}`);

  if (DRY) {
    info("dry run — nothing deleted");
    return;
  }
  if (!YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = await ask(rl, `Type the vault name to confirm:`);
      if (a !== vault) {
        console.log(`    ${C.r("aborted")} — got "${a}"`);
        return;
      }
    } finally {
      rl.close();
    }
  }
  await vaultAcct.deleteAccount(owner);
  ok(`${vault} deleted — ${fmtNear(balance)} NEAR refunded to ${owner}`);
  console.log(`\n${C.g("Done.")} ${C.dim("Your storage deposit is back in your account.")}\n`);
}

main().catch((e) => {
  console.error(`\n${C.r("failed")}  ${e.message}\n`);
  process.exit(1);
});

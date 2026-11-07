#!/usr/bin/env node
/**
 * Unwind a Float vault and refund the owner — ALL of it.
 *
 * This exists because "your deposit is refundable" is only a true statement if
 * getting it back is one command. A documented multi-step recovery procedure
 * is one nobody performs, and the part they skip is the expensive part.
 *
 * REWRITTEN 2026-11-07. The previous version could not refund anyone. It was
 * published in 0.4.0 as THE refund path and had five defects, each verified
 * against a live vault:
 *
 *   1. it demanded a `<vault>.json` credential, which a factory-created vault
 *      never has — so it refused to start at all
 *   2. it then said the stake was "unrecoverable — there is no seed phrase and
 *      no recovery flow", which is FALSE: the factory installs the OWNER's
 *      full-access key on every vault it creates, and that key signs for the
 *      vault. Telling someone their money is gone when it is not is the worst
 *      thing this tool could do
 *   3. it signed `withdraw` AS THE VAULT. `withdraw` calls `assert_owner`,
 *      which compares `predecessor_account_id()` to the owner — a self-call
 *      fails `NotOwner`, so the token step could never have worked
 *   4. it deleted agent SUB-ACCOUNTS, a model removed from the contract, and
 *      knew nothing of NEP-611 gas keys — whose balance the delete destroys
 *   5. it had no `purge_settled` and no code shrink, so `DeleteAccount` on a
 *      ~300 KB vault is refused outright
 *
 * THE ORDER IS THE WHOLE TOOL. Each step destroys the means of doing an
 * earlier one, so getting it wrong strands value permanently rather than
 * failing loudly:
 *
 *   1. ft_transfer the tokens out      — a delete does NOT return fungible
 *                                        tokens; the token ledger keeps a row
 *                                        keyed to an account nobody can sign for
 *   2. withdraw from each gas key      — NEP-611 balance. A CONTRACT cannot do
 *                                        this: near-sys has no withdraw host
 *                                        function at any version, so it needs
 *                                        the account's own key. `DeleteKey`
 *                                        BURNS the balance (0.08322 measured,
 *                                        transaction reported success)
 *   3. storage_unregister on the token — refunds ~0.00125, and refuses while a
 *                                        balance is held
 *   4. purge_settled                   — the only lever that shrinks STATE
 *   5. deploy a 33-byte stub           — shrinks CODE, frees ~1e19 per byte
 *   6. delete_account                  — returns the WHOLE remaining balance
 *
 * Step 5 removes `withdraw` and `purge_settled`, so 1 and 4 cannot happen
 * after it. Step 6 removes the account, so 2 cannot happen after it.
 *
 * Proven 3x by the identical sequence in scripts/teardown-vault.mjs: a mainnet
 * vault at 308,281 B deleted cleanly, and a testnet vault holding 46.5 USDC
 * plus a funded gas key returned 99.96% — owner USDC landed on exactly
 * 50.000000, NEAR +3.466465 of 3.467794 available, total gas 0.001329.
 */
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey } from "near-api-js";

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

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
};
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const info = (m) => console.log(`    ${C.dim("·")}    ${m}`);
const warn = (m) => console.log(`    ${C.y("!")}    ${m}`);
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const fmtNear = (y) => (Number(y) / 1e24).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CRED_DIR = () =>
  join(process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials"), NETWORK);
const credPath = (id) => join(CRED_DIR(), `${id}.json`);

function loadKey(id) {
  const p = credPath(id);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  return j.private_key ?? j.secret_key ?? null;
}

const ask = (rl, q) => new Promise((res) => rl.question(`    ${q} `, (a) => res(a.trim())));

/**
 * The smallest valid NEAR contract: one exported no-op `new`, 33 bytes.
 *
 * GENERATED, NOT SHIPPED AS A FILE. A published npm package cannot reach the
 * repo's `.demo/` directory, and adding a binary to `files` for 33 bytes
 * invites it to go stale against the generator. The bytes are deterministic,
 * and `test/float-exit.test.mjs` pins them.
 *
 * Why a stub at all: `DeleteAccount` is refused while the account is large —
 * observed refused at 10,330 B on testnet and succeeding at 3,300 B on
 * mainnet. A vault carries ~298,819 B of code, so the code has to go before
 * the account can. Deploying over it frees ~1e19 yocto per byte.
 */
export function stubWasm() {
  const leb = (n) => {
    const out = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return Buffer.from(out);
  };
  const section = (id, payload) =>
    Buffer.concat([Buffer.from([id]), leb(payload.length), payload]);
  const name = Buffer.from("new", "ascii");
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), // magic + version
    section(1, Buffer.from([0x01, 0x60, 0x00, 0x00])), // type: () -> ()
    section(3, Buffer.from([0x01, 0x00])), // function: one, of type 0
    section(
      7,
      Buffer.concat([Buffer.from([0x01, name.length]), name, Buffer.from([0x00, 0x00])]),
    ), // export `new`, func 0
    section(10, Buffer.from([0x01, 0x02, 0x00, 0x0b])), // code: empty body
  ]);
}

/**
 * Who can sign AS THE VAULT.
 *
 * THIS IS THE FIX FOR THE BUG THAT MADE THE OLD VERSION USELESS. It demanded
 * `<vault>.json` and, not finding one, told the user their stake was gone.
 *
 * A factory-created vault has exactly one full-access key: the OWNER's,
 * installed by `add_full_access_key(env::signer_account_pk())` during `new`.
 * So the owner's own credential signs for the vault, and no separate file is
 * needed or has ever existed.
 *
 * The standalone `<vault>.json` path is kept for vaults created by the CLI
 * wizard, which does generate one.
 *
 * Exported for tests: this decides whether a user is told their money is
 * recoverable, so it must be testable without a chain.
 */
export function resolveVaultSigner({ vaultKeys, ownerPublicKey, ownerSecret, vaultSecret }) {
  const fullAccess = vaultKeys.filter((k) => k.access_key.permission === "FullAccess");
  if (fullAccess.some((k) => k.public_key === ownerPublicKey)) {
    return { secret: ownerSecret, via: "owner", fullAccessCount: fullAccess.length };
  }
  if (vaultSecret) {
    return { secret: vaultSecret, via: "vault-file", fullAccessCount: fullAccess.length };
  }
  return { secret: null, via: null, fullAccessCount: fullAccess.length };
}

async function main() {
  if (!RPC) throw new Error(`unknown network ${NETWORK} — use --network mainnet|testnet`);
  console.log(
    `\n${C.b("float exit")} ${C.dim(`— unwind a vault and refund the owner (${NETWORK})`)}`,
  );

  const owner = opt("--owner");
  if (!owner) throw new Error("--owner is required");
  const vault = opt("--vault", `float.${owner}`);

  const provider = new JsonRpcProvider({ url: RPC });

  // ---- 0. Keys. Nothing is touched until we know the vault can be emptied.
  step(0, "Keys");
  const ownerSecret = loadKey(owner);
  if (!ownerSecret) throw new Error(`no key for ${owner} at ${credPath(owner)}`);
  const ownerKp = KeyPair.fromString(ownerSecret);
  ok(`${owner} key found`);

  const vaultAccountExists = await provider
    .viewAccount({ accountId: vault, blockQuery: { finality: "final" } })
    .then(() => true)
    .catch(() => false);
  if (!vaultAccountExists) {
    throw new Error(
      [
        `${vault} does not exist on ${NETWORK}.`,
        "",
        "  If you did not pass --vault, the default is the CLI wizard's naming",
        `  (float.<owner>). A vault made by the FACTORY is named`,
        "  <owner-with-dots-as-hyphens>-<label>.<factory>, e.g.",
        "  alice-testnet-fleet.fac.floatv4.testnet — pass it with --vault.",
      ].join("\n"),
    );
  }

  const vaultKeys = (
    await provider.viewAccessKeyList({ accountId: vault, blockQuery: { finality: "final" } })
  ).keys;
  const signer = resolveVaultSigner({
    vaultKeys,
    ownerPublicKey: ownerKp.getPublicKey().toString(),
    ownerSecret,
    vaultSecret: loadKey(vault),
  });

  if (!signer.secret) {
    throw new Error(
      [
        `nothing can sign as ${vault}.`,
        "",
        `  Full-access keys on it: ${signer.fullAccessCount}`,
        `  Your key (${owner}) is not one of them, and there is no`,
        `  ${credPath(vault)}.`,
        "",
        "  Its balance cannot be recovered: a vault with no full-access key",
        "  cannot deploy, cannot withdraw from a gas key, and cannot delete",
        "  itself. Leave it alone — shrinking it would free the stake into an",
        "  account nobody can empty, which is worse than doing nothing.",
      ].join("\n"),
    );
  }
  ok(
    signer.via === "owner"
      ? `${owner}'s key is full-access on ${vault} — no separate vault key needed`
      : `${vault} key found at ${credPath(vault)}`,
  );

  const vaultAcct = new Account(vault, provider, new KeyPairSigner(KeyPair.fromString(signer.secret)));
  const ownerAcct = new Account(owner, provider, new KeyPairSigner(ownerKp));
  const view = (contractId, method, args = {}) =>
    provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
  const ftBal = async (token, id) => BigInt((await view(token, "ft_balance_of", { account_id: id })) ?? 0);

  // ---- 1. Inventory. Everything recoverable, in one place, before any write.
  //
  // Tokens come from get_tree(): there is no list_token_balances, but every
  // token the vault can hold appears as a TokenLimit on some node. Deriving
  // them means this cannot miss one — which is also why this tool does not
  // take a --token flag. A wrong one reads as a zero balance and the delete
  // would strand the real tokens silently.
  step(1, "What is recoverable");
  const tree = await view(vault, "get_tree");
  if (!Array.isArray(tree)) {
    throw new Error(`get_tree() returned ${typeof tree}, expected an array. Refusing to proceed.`);
  }
  const tokens = [...new Set(tree.flatMap((n) => (n.limits ?? []).map((l) => l.token)))];
  if (!tokens.length) {
    throw new Error(
      [
        "no token appears in any node's limits, so this tool cannot tell what",
        "the vault may hold.",
        "",
        "  Refusing to delete it: a NEP-141 balance left behind is stranded",
        "  permanently once the account is gone. Withdraw manually first:",
        `    near call ${vault} withdraw '{"token":"<id>","amount":"<amt>","receiver_id":"${owner}"}' --accountId ${owner} --depositYocto 1`,
      ].join("\n"),
    );
  }

  const acct0 = await provider.viewAccount({ accountId: vault, blockQuery: { finality: "final" } });
  const code0 = Buffer.from(
    (await provider.viewContractCode({ contractId: vault, blockQuery: { finality: "final" } }))
      .code_base64,
    "base64",
  );
  const gasKeys = vaultKeys.filter((k) => k.access_key.permission?.GasKeyFunctionCall);
  const gasTotal = gasKeys.reduce(
    (a, k) => a + BigInt(k.access_key.permission.GasKeyFunctionCall.balance),
    0n,
  );
  const balances = [];
  for (const t of tokens) balances.push([t, await ftBal(t, vault)]);

  info(`${tree.length} node(s), ${acct0.storage_usage} B = ${code0.length} code + ${acct0.storage_usage - code0.length} state`);
  for (const [t, b] of balances) info(`token    ${t} — ${b}`);
  /**
   * A GAS-KEY BALANCE IS HELD OUTSIDE THE ACCOUNT'S `amount`. Measured: a
   * vault with no gas key and one with a 0.118354 gas key both reported the
   * same `amount`. So the refund is amount + the gas keys, and quoting
   * `amount` alone understates what the user gets back.
   */
  info(`NEAR     ${fmtNear(acct0.amount)} in the account`);
  for (const k of gasKeys) {
    info(`gas key  ${k.public_key.slice(0, 24)}… — ${fmtNear(k.access_key.permission.GasKeyFunctionCall.balance)}`);
  }
  console.log(
    `    ${C.b("total NEAR back")} ${C.b(fmtNear(BigInt(acct0.amount) + gasTotal))} ${C.dim("(account + gas keys, before gas costs)")}`,
  );

  // ---- 2. Tokens out. SIGNED BY THE OWNER.
  //
  // `withdraw` calls assert_owner(), which compares predecessor_account_id()
  // to the owner. The previous version signed this as the VAULT, so it was a
  // self-call and failed NotOwner every time.
  step(2, "Tokens out");
  for (const [token, amount] of balances) {
    if (amount === 0n) {
      ok(`${token} — already zero`);
      continue;
    }
    if (DRY) {
      info(`would withdraw ${amount} of ${token} to ${owner}`);
      continue;
    }
    await ownerAcct.callFunction({
      contractId: vault,
      methodName: "withdraw",
      args: { token, amount: amount.toString(), receiver_id: owner },
      gas: 100n * 10n ** 12n,
      deposit: 1n,
    });
    // An unverified withdrawal is not a withdrawal. Poll: a `final` read
    // straight after a write can be a whole transaction behind.
    let after = amount;
    for (let i = 0; i < 25 && after > 0n; i++) {
      await sleep(1000);
      after = await ftBal(token, vault);
    }
    if (after !== 0n) {
      throw new Error(
        `withdrawal of ${token} left ${after} behind. STOPPING before deletion — ` +
          `deleting the account now would strand it permanently.`,
      );
    }
    ok(`${token} — withdrew ${amount}, balance verified zero`);
  }

  // ---- 3. Gas keys. SIGNED BY THE VAULT, and a failure here is fatal.
  //
  // A contract cannot do this at all: near-sys exposes transfer_to_gas_key,
  // add_gas_key_with_full_access and add_gas_key_with_function_call, and
  // nothing that takes money out, at any version. That is why one-signature
  // close cannot be a contract method.
  step(3, "Gas keys");
  if (!gasKeys.length) info("none");
  for (const k of gasKeys) {
    const bal = BigInt(k.access_key.permission.GasKeyFunctionCall.balance);
    if (bal === 0n) {
      ok(`${k.public_key.slice(0, 24)}… — already empty`);
      continue;
    }
    if (DRY) {
      info(`would withdraw ${fmtNear(bal)} from ${k.public_key.slice(0, 24)}…`);
      continue;
    }
    try {
      await vaultAcct.withdrawFromGasKey(PublicKey.fromString(k.public_key), bal);
      ok(`${k.public_key.slice(0, 24)}… — withdrew ${fmtNear(bal)}`);
    } catch (e) {
      // STOP. The delete does not sweep a gas key's balance, so continuing
      // would take this money to the grave with the account and print nothing
      // about it. `DeleteKey` is NOT a fallback — it burns the balance and
      // reports success.
      throw new Error(
        `could not withdraw ${fmtNear(bal)} from gas key ${k.public_key}: ` +
          `${String(e.message).slice(0, 160)}\n\n` +
          `  STOPPING. Deleting now would destroy that balance.`,
      );
    }
  }

  // ---- 4. Token registration. Optional: the refund is ~0.00125, and
  // abandoning a teardown over it would strand far more than it reclaims.
  //
  // Not every NEP-145 implementation agrees on the method name: Circle's
  // mainnet USDC exports storage_unregister(), this repo's mock-ft exports
  // unregister(account_id). Ask the deployed bytes rather than assuming.
  step(4, "Token registration refund");
  for (const [token] of balances) {
    const reg = await view(token, "storage_balance_of", { account_id: vault }).catch(() => null);
    if (!reg) {
      info(`${token} — not registered`);
      continue;
    }
    if (DRY) {
      info(`would unregister from ${token}, refunding ~${fmtNear(reg.total ?? 0)}`);
      continue;
    }
    const code = Buffer.from(
      (await provider.viewContractCode({ contractId: token, blockQuery: { finality: "final" } }))
        .code_base64,
      "base64",
    ).toString("latin1");
    const attempts = [];
    if (code.includes("storage_unregister")) attempts.push(["storage_unregister", {}]);
    if (code.includes("unregister")) attempts.push(["unregister", { account_id: vault }]);
    let done = false;
    for (const [methodName, args] of attempts) {
      try {
        await vaultAcct.callFunction({
          contractId: token,
          methodName,
          args,
          gas: 30n * 10n ** 12n,
          deposit: 1n,
        });
        ok(`${token} — unregistered, ~${fmtNear(reg.total ?? 0)} refunded`);
        done = true;
        break;
      } catch {
        /* try the next spelling */
      }
    }
    if (!done) warn(`${token} — could not unregister; ~${fmtNear(reg.total ?? 0)} stays with the token`);
  }

  // ---- 5. Shrink STATE. Without this the delete is refused outright.
  step(5, "Shrinking state");
  const day = Number(await view(vault, "current_day"));
  const reqs = await view(vault, "list_requests", { from_index: 0, limit: 200 });
  if (!reqs.length) {
    info("no stored requests");
  } else if (DRY) {
    info(`would purge ${reqs.length} settled request(s)`);
  } else {
    // `day + 1` — records are removed strictly BEFORE the cutoff, so today
    // needs the day after it to be included. The day comes from the CONTRACT:
    // a vault can run a test clock that does not track UTC.
    await ownerAcct.callFunction({
      contractId: vault,
      methodName: "purge_settled",
      args: { before_day: day + 1, limit: 100 },
      gas: 100n * 10n ** 12n,
      deposit: 1n,
    });
    await sleep(2000);
    ok(`purged ${reqs.length} settled request(s)`);
  }

  // ---- 6. Shrink CODE, then delete.
  step(6, "The vault");
  console.log(`    ${C.b("about to delete")} ${vault}`);
  console.log(
    `    ${C.b("refunding")} ${C.b(fmtNear(BigInt(acct0.amount) + gasTotal))} NEAR ${C.b("to")} ${C.b(owner)} ${C.dim("minus gas")}`,
  );
  console.log(`    ${C.y("This is irreversible. The contract and all its state are destroyed.")}`);

  if (DRY) {
    info("dry run — nothing was written");
    return;
  }
  if (!YES) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = await ask(rl, "Type the vault name to confirm:");
      if (a !== vault) {
        console.log(`    ${C.r("aborted")} — got "${a}"`);
        return;
      }
    } finally {
      rl.close();
    }
  }

  const ownerBefore = BigInt(
    (await provider.viewAccount({ accountId: owner, blockQuery: { finality: "final" } })).amount,
  );

  await vaultAcct.deployContract(new Uint8Array(stubWasm()));
  await sleep(3000);
  const mid = await provider.viewAccount({ accountId: vault, blockQuery: { finality: "final" } });
  ok(`storage ${acct0.storage_usage} -> ${mid.storage_usage} B`);

  await vaultAcct.deleteAccount(owner);

  // Poll to an expected value, not just "until it changes": a stale read has
  // already changed, and the gas reservation makes a mid-flight figure look
  // exact.
  const want = ownerBefore + BigInt(mid.amount) - 5n * 10n ** 22n;
  let ownerAfter = ownerBefore;
  for (let i = 0; i < 30; i++) {
    ownerAfter = BigInt(
      (await provider.viewAccount({ accountId: owner, blockQuery: { finality: "final" } })).amount,
    );
    if (ownerAfter >= want) break;
    await sleep(1000);
  }
  const gone = await provider
    .viewAccount({ accountId: vault, blockQuery: { finality: "final" } })
    .then(() => false)
    .catch(() => true);

  ok(`${vault} ${gone ? "deleted" : "STILL EXISTS — read the chain before assuming"}`);
  console.log(
    `\n${gone ? C.g("Done.") : C.r("Incomplete.")} ${C.dim(`${owner}: ${fmtNear(ownerBefore)} -> ${fmtNear(ownerAfter)} NEAR (+${fmtNear(ownerAfter - ownerBefore)})`)}\n`,
  );
  if (!gone) process.exit(1);
}

// Only run when executed directly, so the pure helpers above can be imported
// by tests without the CLI firing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n${C.r("failed")}  ${e.message}\n`);
    process.exit(1);
  });
}

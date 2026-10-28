import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { createServer } from "node:http";

/**
 * Step ordering, by running the real CLI.
 *
 * HOW THIS IS HERMETIC, since a subprocess test usually is not. Two seams make
 * it so, and both already existed for this purpose:
 *
 *   - `NEAR_CREDENTIALS_DIR` redirects the keychain lookup, so preflight and
 *     the owner-key read work against a scratch directory. The wizard's own
 *     comment says why it exists: "a wizard whose only test path runs against
 *     the real keychain is a wizard nobody tests."
 *   - `--rpc http://127.0.0.1:1` points the first network call at a closed
 *     local port. It fails instantly, with no DNS and no internet, so the run
 *     is deterministic offline AND on a plane.
 *
 * WHAT IS BEING ASSERTED, and why it is ordering rather than output. The whole
 * point of f69e9d0 was "preflight before the bill, not after it": the wasm and
 * credential checks used to run at step 5, AFTER the plan was confirmed and two
 * accounts had been created and funded, so discovering there was nothing to
 * deploy left a half-built vault and real NEAR spent. That is a property of the
 * ORDER, invisible to any test of the individual steps.
 *
 * WHAT IT STILL CANNOT REACH. The `--dry-run` gate sits AFTER
 * `await ownerAcct.getBalance()`, so a hermetic run dies at step 3 and cannot
 * observe it. Steps 4 onwards spend real NEAR and are not exercised here by
 * design — nothing in this file is allowed to send a transaction.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "bin", "create-float.mjs");
const DEAD_RPC = "http://127.0.0.1:1";

/**
 * Run the CLI and capture stdout+stderr and the exit code, never throwing.
 *
 * ASYNC ON PURPOSE. This used execFileSync, which BLOCKS the event loop — so
 * the in-process RPC stub below could never answer a request, and the child sat
 * at getBalance() until the 60s timeout. The symptom reads as "the stub does
 * not work"; the cause is that the parent cannot serve while synchronously
 * waiting for the child. Awaiting keeps the loop free.
 */
const execFileAsync = promisify(execFile);
async function run(args, { creds } = {}) {
  // Structural, not a promise in a comment: every run in this file must target
  // loopback, and --rpc must be PRESENT. A future edit that drops it would fall
  // back to the real testnet RPC, where step 4 spends actual NEAR.
  const rpc = args[args.indexOf("--rpc") + 1];
  assert.match(rpc ?? "", /^http:\/\/127\.0\.0\.1:/, "tests must only ever talk to loopback");
  const env = { ...process.env };
  if (creds) env.NEAR_CREDENTIALS_DIR = creds;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** A scratch keychain holding one usable credential file. */
function scratchCreds(network, account) {
  const kp = KeyPair.fromRandom("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "cf-creds-"));
  mkdirSync(join(dir, network), { recursive: true });
  writeFileSync(
    join(dir, network, `${account}.json`),
    JSON.stringify({
      account_id: account,
      public_key: kp.getPublicKey().toString(),
      // GENERATED, not a literal. Two reasons. A key-shaped string committed to
      // a repo reads as a leak to anyone scanning, and more importantly it must
      // be VALID: a malformed key throws while the signer is built, so the run
      // would stop at key-parsing and the test would claim to prove "stops at
      // the first network call" while actually proving something weaker. This
      // key is valid, controls nothing, and is discarded with the temp dir.
      private_key: kp.toString(),
    }),
    "utf8",
  );
  return dir;
}


/**
 * A localhost NEAR RPC stub, just enough for `Account.getBalance()`.
 *
 * WHY THIS EXISTS. The `--dry-run` gate sits AFTER `await
 * ownerAcct.getBalance()`, so the dead-port runs above die before reaching it.
 * The alternative to a stub would be reordering production code to check DRY
 * earlier — but the balance, and the "insufficient balance" refusal, are part
 * of what a dry run is FOR. Moving the gate to suit a test would make the
 * feature worse. A stub leaves the wizard untouched.
 *
 * getBalance() needs two calls, discovered by logging what it asked for rather
 * than guessed: EXPERIMENTAL_protocol_config for storage_amount_per_byte, then
 * query/view_account. available = amount - max(locked, storage_usage * rate).
 */
function rpcStub({ nearBalance = 5, existingAccounts = ["me.testnet"] } = {}) {
  const YOCTO_PER_BYTE = "10000000000000000000";
  const amount = (BigInt(Math.round(nearBalance * 1e6)) * 10n ** 18n).toString();
  const seen = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b || "{}");
      const { method, id } = body;
      seen.push(method);
      // Accounts that do NOT exist must look that way. The stub used to answer
      // view_account for ANY id, so `new Account(vault).getState()` succeeded
      // and the vault appeared already-created — which silently disabled the
      // resumability check that reads it, and made an unaffordable plan look
      // affordable. A stub that says yes to everything tests nothing.
      const queried = body?.params?.account_id;
      if (
        method === "query" &&
        body?.params?.request_type === "view_account" &&
        queried &&
        !existingAccounts.includes(queried)
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" },
                     message: `account ${queried} does not exist while viewing` },
          }),
        );
        return;
      }
      const result =
        method === "EXPERIMENTAL_protocol_config"
          ? { runtime_config: { storage_amount_per_byte: YOCTO_PER_BYTE } }
          : method === "query" && body?.params?.request_type === "call_function"
            ? {
                // ft_metadata, base64 — step 2 now proves the token is a NEP-141
                // before the vault exists. Without this the run dies at step 2.
                result: [...Buffer.from(JSON.stringify({ spec: "ft-1.0.0", name: "T", symbol: "T", decimals: 6 }))],
                logs: [],
                block_height: 1,
                block_hash: "11111111111111111111111111111111",
              }
          : method === "query"
            ? {
                amount,
                locked: "0",
                code_hash: "11111111111111111111111111111111",
                storage_usage: 182,
                storage_paid_at: 0,
                block_height: 1,
                block_hash: "11111111111111111111111111111111",
              }
            : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${srv.address().port}`,
        seen,
        close: () => new Promise((r) => srv.close(r)),
      }),
    );
  });
}

/**
 * Strip ANSI before matching. The step headers are emitted as
 * `\x1b[1m[0]\x1b[0m Preflight`, so a naive /\[(\d)\]\s/ finds nothing — the
 * `]` is followed by an escape sequence, not a space. Matching raw output here
 * silently returned an empty step list, which read as "no steps ran" rather
 * than "the matcher cannot see them". Same hazard as asserting on coloured
 * text anywhere else.
 */
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The indices of the `[N] Title` step headers, in the order printed. */
const stepOrder = (out) => [...plain(out).matchAll(/\[(\d)\]\s+\w/g)].map((m) => Number(m[1]));

test("an unknown network exits 2 before any step runs", async () => {
  const r = await run(["--network", "betanet", "--rpc", "http://127.0.0.1:1"]);
  assert.equal(r.code, 2);
  assert.match(plain(r.out), /Unknown network 'betanet'/);
  assert.deepEqual(stepOrder(r.out), [], "no step may run once the network is rejected");
});

test("preflight runs FIRST, and a preflight failure stops everything after it", async () => {
  // The scratch dir has no `<network>/` subdirectory, so the credentials check
  // inside step 0 fails. This is the f69e9d0 property: nothing downstream may
  // run, because downstream is where accounts get created and funded.
  const empty = mkdtempSync(join(tmpdir(), "cf-nocreds-"));
  try {
    const r = await run(["--network", "testnet", "--yes", "--owner", "me.testnet", "--rpc", DEAD_RPC], {
      creds: empty,
    });
    assert.notEqual(r.code, 0, "a failed preflight must be a non-zero exit");
    const steps = stepOrder(r.out);
    assert.deepEqual(steps, [0], `only preflight may have run, got steps ${steps}`);
    assert.match(plain(r.out), /\[0\]\s+Preflight/);
    assert.doesNotMatch(plain(r.out), /\[4\]/, "step 4 creates the vault account — it must not be reached");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("steps run in ascending order, and stop at the first network call", async () => {
  const creds = scratchCreds("testnet", "me.testnet");
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--owner", "me.testnet", "--vault", "v.me.testnet", "--rpc", DEAD_RPC],
      { creds },
    );
    const steps = stepOrder(r.out);

    // 0 and 1 complete without a network: preflight is filesystem-only and the
    // owner key is read from disk. Step 2 now ENDS with a network call — it
    // validates the token is a real NEP-141 via ft_metadata — so a dead RPC
    // stops the run there. That check exists because a live mainnet run typed
    // "mainnet" at the token prompt and the wizard accepted it.
    assert.deepEqual(steps, [0, 1, 2], `expected 0,1,2 then a stop, got ${steps}`);
    assert.deepEqual([...steps].sort((a, b) => a - b), steps, "step numbers must be ascending");

    // Step 3 prints the plan and then reads the balance, which is where a dead
    // RPC stops it. Reaching 4 would mean money moved.
    assert.doesNotMatch(plain(r.out), /\[3\]/, "must not reach the plan with no reachable RPC");
    assert.notEqual(r.code, 0);
  } finally {
    rmSync(creds, { recursive: true, force: true });
  }
});

test("the plan is printed BEFORE the run can spend anything", async () => {
  // "Show the bill first" is principle 1 in the file's own header. The tree and
  // the cost must appear in the output of a run that never reaches step 4.
  // Needs the stub: step 2 validates the token over RPC before the plan prints.
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({ nearBalance: 5 });
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--dry-run", "--owner", "me.testnet", "--vault", "v.me.testnet", "--rpc", rpc.url],
      { creds },
    );
    const txt = plain(r.out);
    const planAt = txt.indexOf("[3]");
    const treeAt = txt.indexOf("/day,");
    const costAt = txt.indexOf("you send");
    assert.ok(planAt >= 0, "the plan step must be reached");
    assert.ok(treeAt > planAt, "the tree must print inside the plan");
    assert.ok(costAt > treeAt, "the cost must print after the tree, before any spend");
    assert.doesNotMatch(plain(r.out), /\[4\]/);
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

test("--agents rejects a non-numeric value, and does so before spending", async () => {
  // Also needs the stub: the --agents check lives in step 3, past the token
  // validation that step 2 now performs over RPC.
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({ nearBalance: 5 });
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--owner", "me.testnet", "--vault", "v.me.testnet",
       "--agents", "3abc", "--rpc", rpc.url],
      { creds },
    );
    assert.notEqual(r.code, 0);
    assert.match(plain(r.out), /--agents expects a number or "all", got "3abc"/);
    assert.doesNotMatch(plain(r.out), /\[4\]/, "a bad flag must not get as far as creating accounts");
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

// ---- the --dry-run gate
//
// Reachable only with the RPC stub, since the gate sits after getBalance().

test("--dry-run stops at the gate: plan shown, nothing sent, exit 0", async () => {
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({ nearBalance: 5 });
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--dry-run", "--owner", "me.testnet",
       "--vault", "v.me.testnet", "--rpc", rpc.url],
      { creds },
    );
    const txt = plain(r.out);
    assert.equal(r.code, 0, `a dry run is a success, not a failure: ${txt.slice(-300)}`);
    assert.match(txt, /dry run — nothing was sent/);
    // It got far enough to read the balance, which is the whole reason the gate
    // is placed where it is: a dry run reports affordability, not just intent.
    assert.match(txt, /your balance\s+4\.998 NEAR/);
    assert.deepEqual(stepOrder(r.out), [0, 1, 2, 3], "the gate is inside step 3");
    assert.doesNotMatch(txt, /\[4\]/, "step 4 creates the vault account");
    assert.ok(rpc.seen.includes("query"), "the balance really was read");
    // Nothing was broadcast. A send would appear as one of these.
    for (const m of ["broadcast_tx_commit", "send_tx", "broadcast_tx_async"]) {
      assert.ok(!rpc.seen.includes(m), `a dry run must not call ${m}`);
    }
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

test("WITHOUT --dry-run the same run goes past the gate — the control", async () => {
  // The positive control, and without it the test above proves little: it could
  // pass because something unrelated stopped the run before step 4. Identical
  // arguments minus the flag must get FURTHER. Safe because the stub is on
  // loopback and answers broadcasts with {}, so the "transaction" goes nowhere.
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({ nearBalance: 5 });
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--owner", "me.testnet",
       "--vault", "v.me.testnet", "--rpc", rpc.url],
      { creds },
    );
    const txt = plain(r.out);
    assert.doesNotMatch(txt, /dry run — nothing was sent/, "the gate must not fire without the flag");
    assert.ok(
      stepOrder(r.out).includes(4),
      `without --dry-run the run must reach step 4; got steps ${stepOrder(r.out)}`,
    );
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

test("an unaffordable plan is refused BEFORE the dry-run gate", async () => {
  // Ordering again: the affordability check precedes the gate, so `--dry-run`
  // does not paper over "you cannot afford this". A dry run that reported
  // success on a balance too small to proceed would be worse than no dry run.
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({ nearBalance: 1 }); // need 3.000
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--dry-run", "--owner", "me.testnet",
       "--vault", "v.me.testnet", "--rpc", rpc.url],
      { creds },
    );
    const txt = plain(r.out);
    assert.notEqual(r.code, 0, "cannot be a success when the plan is unaffordable");
    assert.match(txt, /insufficient balance: need 3\.000, have 0\.998/);
    assert.doesNotMatch(txt, /dry run — nothing was sent/, "the gate sits after this check");
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

test("a RESUME is not billed for a vault that already exists", async () => {
  // The exact failure a real mainnet run hit: the step-6 crash left the vault
  // created and holding its 3 NEAR, and re-running refused with "insufficient
  // balance: need 3.000, have 0.748" — the wizard's own principle 2
  // ("resumable, not restartable") contradicted by its cheapest check, and only
  // reachable AFTER a failure past step 4, which is when resuming is the thing
  // you need.
  //
  // 0.9 NEAR is below the 3.000 that the old code demanded and above the 0.000
  // the fixed code needs with no agents, so this row goes red if `total` ever
  // charges for the vault again. Note it is the SAME balance that the test
  // above refuses — the only difference is whether the vault exists, which is
  // the whole claim.
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({
    nearBalance: 0.9,
    existingAccounts: ["me.testnet", "v.me.testnet"],
  });
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--dry-run", "--owner", "me.testnet",
       "--vault", "v.me.testnet", "--rpc", rpc.url],
      { creds },
    );
    const txt = plain(r.out);
    assert.doesNotMatch(
      txt,
      /insufficient balance/,
      "a resume was refused for money already in the vault",
    );
    assert.match(
      txt,
      /v\.me\.testnet already exists and is funded/,
      "the cost block must say the vault is paid for, not bill for it again",
    );
    assert.match(txt, /you send\s+0\.000 NEAR/, "nothing left to send on a bare resume");
    assert.doesNotMatch(
      txt,
      /contract storage/,
      "the storage-deposit lines describe money that is not going to move",
    );
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

test("a resume still bills for the agents it has not created", async () => {
  // The other direction, so the fix is "skip what is paid for" rather than
  // "skip everything once the vault exists". Agents are created in step 7,
  // AFTER the vault, so an existing vault says nothing about them — and a
  // resume that silently stopped charging 0.55 each would pass the
  // affordability gate and then run out mid-way through creating them.
  const creds = scratchCreds("testnet", "me.testnet");
  const rpc = await rpcStub({
    nearBalance: 0.9, // enough for a bare resume, NOT for two agents
    existingAccounts: ["me.testnet", "v.me.testnet"],
  });
  try {
    const r = await run(
      ["--network", "testnet", "--yes", "--dry-run", "--owner", "me.testnet",
       "--vault", "v.me.testnet", "--agents", "all", "--rpc", rpc.url],
      { creds },
    );
    const txt = plain(r.out);
    assert.notEqual(r.code, 0, "two agents at 0.55 do not fit in 0.9 NEAR");
    assert.match(txt, /insufficient balance: need 1\.100/);
  } finally {
    await rpc.close();
    rmSync(creds, { recursive: true, force: true });
  }
});

#!/usr/bin/env node
/**
 * create-float — stands up a working Float vault in one command.
 *
 * Replaces roughly thirteen manual steps: making a sub-account, deploying the
 * contract, initialising it, building a budget tree, minting a restricted key
 * per agent, and writing both the adapter env and the MCP client config.
 *
 * Three principles it is built on, each from something that has actually gone
 * wrong before:
 *
 *   1. SHOW THE BILL FIRST. Every step here spends real NEAR and several are
 *      irreversible. The plan and its cost are printed and confirmed before
 *      anything is sent, and `--dry-run` stops right there.
 *
 *   2. RESUMABLE, NOT RESTARTABLE. Network calls fail halfway. Each step
 *      checks whether it is already done and skips if so, so re-running
 *      finishes the job instead of creating a second half-built vault.
 *
 *   3. NEVER CLOBBER. The MCP client config belongs to the user and may hold
 *      a dozen other servers. It is read, merged, and written back, with a
 *      `.bak` taken first. And `float` is not a key we assume is ours: if it
 *      belongs to another product — measured 2026-10-30, it belonged to
 *      `@usefloat/mcp` holding an owner key — this vault is added alongside it
 *      as `float-near` instead, and the collision is reported.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
// Only the ceiling is used here, for the closing advice. xchainCap lives with
// the tree that applies it; XCHAIN_HEADROOM is internal to both.
import { xchainCeiling } from "./xchain.mjs";
import { defaultTree, flatten, planTreeLines, toBaseUnits } from "./tree.mjs";
import { parseArgs, makeReaders, agentCount, wantsHelp, usage } from "./args.mjs";
import { planTokenSetup, fundingNotice } from "./token-setup.mjs";
import { mcpTargets, writeMcpConfigs } from "./mcp-config.mjs";
import { handoffLinks, handoffLines } from "./handoff.mjs";
import { vaultFunding } from "./funding.mjs";
import { rotationPlan, applyRotation, repointedCredential } from "./rotate-key.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const { has, opt } = makeReaders(argv);

// Answer `--help` before ANYTHING else — before parseArgs, and well before
// preflight. Two reasons, both learned the hard way on 2026-10-30:
//
//   - preflight needs credentials and a contract, so on a machine with nothing
//     set up `--help` answered with "no testnet credentials at ...". The one
//     command that must work everywhere was the one guaranteed to fail there.
//   - it ran the interactive wizard instead, prompting for a NEAR account. A
//     person typing --help is explicitly not ready to act.
//
// Ahead of parseArgs too, so `--help --network bogus` prints usage rather than
// an error about a flag the user was asking about.
if (wantsHelp(argv)) {
  console.log(usage());
  process.exit(0);
}

// Parsed in ./args.mjs, which also owns the unknown-network guard. That guard
// used to call process.exit(2) at module scope, so importing this file to check
// a single flag could terminate the caller; it now throws a UsageError and the
// catch at the bottom turns it back into the same exit code.
let CFG;
try {
  CFG = parseArgs(argv);
} catch (e) {
  console.error(e.message);
  process.exit(e.exitCode ?? 2);
}
const { dry: DRY, yes: YES, network: NETWORK, mainnet: MAINNET, rpc: RPC } = CFG;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};
const step = (n, t) => console.log(`\n${C.b(`[${n}]`)} ${t}`);
const ok = (m) => console.log(`    ${C.g("ok")}   ${m}`);
const skip = (m) => console.log(`    ${C.dim("skip")} ${C.dim(m)}`);
const warn = (m) => console.log(`    ${C.y("!")}    ${m}`);

const NEAR = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n; // NEAR -> yocto
const fmtNear = (y) => (Number(y / 10n ** 18n) / 1e6).toFixed(3);

/**
 * Format a deliverable amount for the closing advice.
 *
 * `.toFixed(0)` was used here and printed "deliver a round 1" for a per-tx cap
 * of 0.51, whose true ceiling is 0.50 — JS rounds half away from zero, so 0.5
 * became 1. It was chosen when the mainnet cap was 10.2, where toFixed(0) gives
 * a clean 10, and silently became wrong for every cap under about 1, which is
 * the entire mainnet tree. Two decimals, with trailing zeros kept so 0.50 does
 * not render as 0.5 next to a 0.51 cap.
 */
const fmtDeliver = (n) => n.toFixed(2);

/**
 * Per-agent cost, mirroring the contract's own floors:
 *   MIN_AGENT_KEY_ALLOWANCE = 0.5 NEAR   (gas allowance on the restricted key)
 *   AGENT_ACCOUNT_STORAGE   = 0.05 NEAR  (the sub-account's storage stake)
 * create_agent_account rejects anything below their sum, so these are not
 * tuning knobs — they are the contract's minimum, restated.
 */
/** Mainnet USDC on NEAR, and the 1Click asset id for USDC on Base. */
const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

// Cap sizing for the cross-chain spread lives in its own module so it can be
// tested — this file calls main() at the bottom, so a test importing it would
// launch the wizard. See bin/xchain.mjs for the measurements behind the 2%.

const AGENT_KEY_ALLOWANCE = NEAR(0.5);
const AGENT_STORAGE = NEAR(0.05);
const AGENT_COST = AGENT_KEY_ALLOWANCE + AGENT_STORAGE;
// VAULT_FUNDING is no longer a constant. The code stake is 1e19 yocto per
// BYTE, so a growing contract silently eats the headroom: at 278 KB a flat
// 3 NEAR left 0.152 for state, and at 292 KB it left 0.010 -- about one
// kilobyte, far too little for a four-node tree. The wizard would have
// funded, deployed, then failed mid-tree with a storage error after the user
// had paid. Derived from the artifact instead: see bin/funding.mjs.

// The tree and its rendering live in ./tree.mjs so both can be tested;
// this file calls main() at the bottom, so a test importing it would
// launch the wizard. MAINNET gets the SMALL tree -- see tree.mjs.
const DEFAULT_TREE = defaultTree(MAINNET);

async function ask(rl, q, dflt) {
  if (YES) return dflt;
  const a = (await rl.question(`    ${q}${dflt ? ` ${C.dim(`[${dflt}]`)}` : ""}: `)).trim();
  return a || dflt;
}

/**
 * Where `near login` leaves credentials.
 *
 * Overridable via NEAR_CREDENTIALS_DIR so the preflight can be exercised
 * against a scratch directory. A wizard whose only test path runs against the
 * real keychain is a wizard nobody tests.
 */
const credPath = (acct) =>
  join(process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials"), NETWORK, `${acct}.json`);

function findWasm() {
  // res/ first, and that is the path that matters: it is populated by
  // `prepack`, so an INSTALLED create-float carries the contract and the user
  // needs no Rust toolchain. The target/ paths are the repo-local fallback for
  // development.
  //
  // Only ever cargo-near output. A plain
  // `cargo build --target wasm32-unknown-unknown` produces a wasm that RUNS
  // but loses every panic message, so this contract's stable reason codes are
  // silently destroyed. That path is therefore not searched.
  //
  // MEASURED 2026-10-28, both artifacts built from the same source with the
  // same toolchain and profile, differing only in the build command:
  //   cargo near build : "Smart contract panicked: INVALID_CONFIG: label ..."
  //   plain cargo build: "WebAssembly trap: An `unreachable` opcode was executed."
  // Pinned by contracts/integration-tests/tests/panic_reason_codes.rs, which
  // deploys BOTH into one sandbox and triggers the same panic on each.
  //
  // The mechanism is in near-sdk-env, NOT in near-sdk -- which is why grepping
  // near-sdk for the cfg finds nothing and is easy to misread as "no such
  // mechanism exists". near-sdk-env 0.1.7 gates `use near_sys as sys` on
  // `all(near, target_arch = "wasm32")`, and `panic_str` picks a branch:
  //   host:  sys::panic_utf8(..)          <- only with --cfg near, i.e. cargo-near
  //   local: eprintln!(..); panic!()      <- otherwise
  // Without --cfg near the local branch is compiled: eprintln! goes nowhere on
  // wasm and panic!() lowers to an `unreachable` opcode.
  //
  // NOTE on verifying this: counting wasm IMPORTS does distinguish the two
  // builds. The host branch is the only caller of panic_utf8, so when it is not
  // compiled the import is absent. Re-measured 2026-10-30 with
  // scripts/wasm-imports.mjs, which parses the import section:
  //   cargo near build : 40 env imports (incl. panic_utf8, sha256)
  //   plain cargo build: 38 env imports (panic_utf8 and sha256 MISSING)
  //
  // THE TRAP, which cost a wrong conclusion in this repo on 2026-10-30:
  // target/wasm32-unknown-unknown/release/vault.wasm is NOT the plain-cargo
  // artifact. cargo-near builds THERE first, with --cfg near, and then
  // wasm-opts into target/near/vault/. Comparing those two paths compares
  // cargo-near against itself and reports IDENTICAL import sets -- which reads
  // as "the build mode makes no difference". Getting a genuine plain build
  // means running `cargo build -p vault --target wasm32-unknown-unknown
  // --release` on its own, which overwrites that very path.
  //
  // An earlier version of this note called `grep -c panic_utf8 <wasm>` the
  // unreliable check. That is true in general -- the name is also in the name
  // section, in debug info and in string data -- but it overstated the case
  // here: the shipped wasm is wasm-opt-stripped and contains the string exactly
  // ONCE, at the import entry itself, while a plain build contains it nowhere.
  // So grep and the import section agreed for this artifact. bundle-wasm.mjs
  // reads the import section anyway, because the proxy is only accidentally
  // exact and a build that retained a name section would break it silently.
  const candidates = [
    join(HERE, "..", "res", "vault.wasm"),
    resolve(process.cwd(), "target", "near", "vault", "vault.wasm"),
    resolve(process.cwd(), "..", "..", "target", "near", "vault", "vault.wasm"),
  ];
  return candidates.find((p) => existsSync(p));
}

async function main() {
  console.log(`
${C.b("create-float")} ${C.dim(`— a Float vault on NEAR ${NETWORK}, in one command`)}
${MAINNET ? "  " + C.y("MAINNET — this spends real funds.") + "\n" : ""}`);

  const rl = YES ? null : createInterface({ input: process.stdin, output: process.stdout });
  try {
    // ---- 0. Everything that can be known before a single question.
    //
    // These used to fail at step 5, after the plan was printed and confirmed
    // and two accounts had already been created and funded. Finding out then
    // that there is no contract to deploy leaves a half-built vault and real
    // NEAR spent. Cheap checks belong before the bill, not after it.
    step(0, "Preflight");

    const wasm = findWasm();
    if (!wasm) {
      const plain = resolve(process.cwd(), "target/wasm32-unknown-unknown/release/vault.wasm");
      throw new Error(
        [
          "no contract to deploy.",
          "  Build it with cargo-near, from the crate directory:",
          "    cd contracts/vault && cargo near build non-reproducible-wasm --no-abi",
          "",
          "  --no-abi is required on Windows: the ABI pass builds the contract as a",
          "  native DLL and near-sdk's host functions have no implementation off-wasm,",
          "  so it fails to link with ~52 unresolved externals.",
          ...(existsSync(plain)
            ? [
                "",
                "  WARNING: a plain-cargo artifact exists under target/wasm32-unknown-unknown/",
                "  and is deliberately NOT used. It deploys and runs, but every contract panic",
                "  arrives as \"WebAssembly trap: An `unreachable` opcode was executed\" with the",
                "  message gone -- so INVALID_CONFIG, DAILY_BUDGET and every other reason code",
                "  this vault returns become indistinguishable from each other and from a bug.",
                "  Measured, not theorised: see contracts/integration-tests/tests/",
                "  panic_reason_codes.rs. Do not deploy that file.",
              ]
            : []),
        ].join("\n"),
      );
    }
    ok(`contract ${(readFileSync(wasm).length / 1024).toFixed(0)} KB — ${wasm}`);
    // Derived from THIS artifact, not a constant, so a contract that grows
    // cannot silently eat the state headroom. See bin/funding.mjs.
    const VAULT_FUND = vaultFunding(readFileSync(wasm).length);

    const credDir = join(
      process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials"),
      NETWORK,
    );
    if (!existsSync(credDir)) {
      throw new Error(
        [
          `no ${NETWORK} credentials at ${credDir}`,
          "  Install near-cli-rs and log in:",
          "    npm i -g near-cli-rs && near login",
          "  create-float signs as you; it never asks for or stores a seed phrase.",
        ].join("\n"),
      );
    }
    ok(`credentials directory ${credDir}`);

    // ---- 1. Who is doing this, and can they sign?
    step(1, "Owner account");
    let owner = opt("--owner", null);
    if (!owner) {
      owner = await ask(rl, `Your NEAR ${NETWORK} account`, "");
      if (!owner) throw new Error("an owner account is required (or pass --owner)");
    }
    if (!existsSync(credPath(owner))) {
      throw new Error(
        `no key for ${owner} at ${credPath(owner)}\n` +
          `  Run:  near login\n` +
          `  create-float signs as you; it never asks for or stores your seed phrase.`,
      );
    }
    const cred = JSON.parse(readFileSync(credPath(owner), "utf8"));
    const ownerKey = cred.private_key ?? cred.secret_key;
    if (!ownerKey) throw new Error(`credential file for ${owner} has no private key`);
    ok(`${owner} (key found)`);

    // ---- 2. Names and token.
    step(2, "Vault");
    const vault = opt("--vault", null) ?? (await ask(rl, "Vault account", `float.${owner}`));
    if (!vault.endsWith(`.${owner}`)) {
      // The contract refuses owner == vault, and a sub-account is the only
      // shape the owner can actually create.
      throw new Error(`the vault must be a sub-account of ${owner}, e.g. float.${owner}`);
    }
    // NEAR caps account ids at 64 characters. An IMPLICIT account is already
    // exactly 64 hex characters, so `float.<implicit>` is 70 and the protocol
    // rejects it outright — an implicit account can never own a vault. Caught
    // here rather than as an opaque "invalid value" from the RPC after the
    // bill has been confirmed.
    if (vault.length > 64) {
      const implicit = /^[0-9a-f]{64}$/.test(owner);
      throw new Error(
        [
          `the vault account id "${vault}" is ${vault.length} characters; NEAR allows 64.`,
          ...(implicit
            ? [
                `  "${owner}" is an IMPLICIT account — exactly 64 hex characters — so NO`,
                "  sub-account of it can ever fit inside the limit. An implicit account",
                "  cannot own a vault. Use a NAMED account such as yourname.near.",
              ]
            : ["  Use a shorter vault name, or a shorter owner account."]),
        ].join("\n"),
      );
    }
    // Defaulting mainnet to the TESTNET token would have configured a vault
    // to pay in something that does not exist there, failing only at the
    // first transfer.
    const token =
      opt("--token", null) ??
      (await ask(rl, "Token (NEP-141)", MAINNET ? MAINNET_USDC : "usdc.fakes.testnet"));
    const decimalsFlag = Number(opt("--decimals", "6"));

    const provider = new JsonRpcProvider({ url: RPC });
    const ownerAcct = new Account(owner, provider, new KeyPairSigner(KeyPair.fromString(ownerKey)));

    // Is it actually a NEP-141? Asked here, before anything is created.
    //
    // This was not checked, and a real mainnet run typed the word "mainnet" at
    // the prompt — a VALID account id, so nothing complained. The wizard
    // reported "paying in mainnet (6 dp)" and would have built the whole tree
    // against a token that does not exist, with every payment failing later at
    // the transfer for reasons that point nowhere near the cause.
    //
    // ft_metadata is the cheapest possible proof: a contract that answers it is
    // a fungible token, and the decimals it reports are authoritative. Using
    // them also removes --decimals as a way to be quietly wrong.
    const meta = await viewSafe(provider, token, "ft_metadata");
    if (!meta || typeof meta.decimals !== "number") {
      throw new Error(
        [
          `"${token}" does not answer ft_metadata on ${NETWORK}, so it is not a NEP-141.`,
          MAINNET
            ? `  Mainnet USDC is ${MAINNET_USDC}`
            : "  Testnet USDC is usdc.fakes.testnet",
          "  Pass it with --token, or press enter at the prompt to take the default.",
        ].join("\n"),
      );
    }
    // The CONTRACT's decimals win over the flag. A mismatch here silently
    // scales every cap by a power of ten, so the authoritative value is used
    // and the flag is reported as the mistake it is.
    if (meta.decimals !== decimalsFlag) {
      warn(`${token} reports ${meta.decimals} decimals, not ${decimalsFlag} — using ${meta.decimals}`);
    }
    const decimals = meta.decimals;

    // THE TWO STEPS THIS WIZARD USED TO DISOWN. It holds the owner's
    // full-access key and already moves 3 NEAR, so "cannot do these for you"
    // was never true — it just cost every user two hand-typed commands that
    // fail on PowerShell unless the inner quotes are escaped.
    //
    // Read from the token rather than assumed: `storage_balance_of` returns
    // null when unregistered, and the bounds minimum is 0.00125 NEAR on
    // mainnet USDC but is not guaranteed to be anywhere else.
    const tokenRegistered = await viewSafe(provider, token, "storage_balance_of", { account_id: vault });
    const tokenBounds = await viewSafe(provider, token, "storage_balance_bounds");
    const ownerTokenBalance = await viewSafe(provider, token, "ft_balance_of", { account_id: owner });
    const tokenPlan = planTokenSetup({
      token, vault, decimals,
      storageMin: tokenBounds?.min ?? "1250000000000000000000",
      registered: tokenRegistered ?? null,
      ownerBalance: ownerTokenBalance ?? "0",
      fundAmount: opt("--fund", null),
    });
    ok(`${vault} paying in ${meta.symbol ?? token} (${token}, ${meta.decimals} dp)`);

    // ---- 3. The bill, before a single transaction.
    const nodes = flatten(DEFAULT_TREE);

    // Agent ACCOUNTS are opt-in; the budget TREE is always built.
    //
    // The tree is the product — the overcommit contention is visible from
    // get_tree() with no agent accounts at all — and its nodes are cheap
    // contract state. Agent accounts are 0.55 NEAR each and can be bound at
    // any time afterwards via create_agent_account. Creating them up front
    // charged every new user 1.1 NEAR of gas float for agents they had not
    // configured yet, which is the most skippable part of the ask.
    //
    // Default is to defer. --agents <n> opts in; --agents all takes the lot.
    const candidateAgents = nodes.filter((n) => n.agent);
    const agentOpt =
      opt("--agents", null) ??
      (YES ? "0" : await ask(rl, `Create agent accounts now? (0-${candidateAgents.length}, 0.55 NEAR each)`, "0"));
    // Validation moved to ./args.mjs so it can be tested, and TIGHTENED while
    // moving: the old check accepted "3abc", because Number.parseInt returns 3
    // and that is finite. The comment above it always said a non-numeric value
    // must be refused rather than silently treated as a number, so this makes
    // the code agree with its own stated intent. agentCount() rejects anything
    // that does not round-trip as an integer.
    const agents = candidateAgents.slice(0, agentCount(agentOpt, candidateAgents.length));

    // RESUMABILITY, in the one place it was missing. Step 4 skips when the vault
    // already exists, so its funding is not needed again — but `total` charged
    // for it unconditionally, and the affordability gate then refused a resume
    // with "insufficient balance: need 3.000, have 0.748". That is the wizard's
    // own principle 2 ("resumable, not restartable") contradicted by its
    // cheapest check, and it only shows up after a run has failed PAST step 4,
    // which is exactly when resuming is the thing you need.
    //
    // Same existence probe step 4 uses, so the two cannot disagree about what
    // is already paid for.
    let vaultExists = true;
    try {
      await new Account(vault, provider).getState();
    } catch {
      vaultExists = false;
    }
    // tokenPlan.nearCost is the storage deposit for registering the vault on
    // the token. Leaving it out would let a run clear this gate and then fail
    // with the vault already created — the exact shape of the resume bug.
    const total =
      (vaultExists ? 0n : VAULT_FUND) +
      AGENT_COST * BigInt(agents.length) +
      tokenPlan.nearCost;

    step(3, "Plan");
    console.log(`    ${C.dim("tree")}`);
    // Rendered by ./tree.mjs so the exact lines can be asserted in tests —
    // this is the output that revealed xchainCap sitting on the wrong branch.
    for (const line of planTreeLines(nodes, C.dim)) console.log(line);
    {
      // Derived, not hardcoded. The note must describe the tree actually
      // printed above — the mainnet tree has different numbers, and a fixed
      // string would confidently describe a tree that is not on screen.
      const leaves = nodes.filter((n) => n.agent);
      const pool = nodes.find((n) => n.label === leaves[0]?.parent);
      const sum = leaves.reduce((s, n) => s + n.daily, 0);
      if (pool && sum > pool.daily) {
        const who = leaves.map((l) => l.label).join(" + ");
        console.log(
          `\n    ${C.dim(`${who} may spend ${sum}/day between them, but ${pool.label} holds ${pool.daily}.`)}`,
        );
        console.log(`    ${C.dim("They contend on purpose — that contention is the thing to watch.")}`);
      }
    }
    // NEAR storage is a REFUNDABLE DEPOSIT, not a fee — it locks 1e19 yocto per
    // byte for as long as the data occupies the chain, and returns it when the
    // account is deleted. Printing a single "total" made a 4.10 NEAR deposit
    // read like a 4.10 NEAR purchase, which is the single largest piece of
    // felt onboarding friction and is not even true. Split it, and derive the
    // staked figure from the artifact being deployed rather than hardcoding it.
    const codeStake = BigInt(readFileSync(wasm).length) * 10n ** 19n;
    const agentTotal = AGENT_COST * BigInt(agents.length);
    const agentStake = AGENT_STORAGE * BigInt(agents.length);
    const agentFloat = AGENT_KEY_ALLOWANCE * BigInt(agents.length);
    const vaultIdle = VAULT_FUND - codeStake;

    console.log(`\n    ${C.dim("cost — almost all of this is a deposit, not a fee")}`);
    if (vaultExists) {
      // A resume. Saying "you send 3.000" when the vault is already funded
      // would be a bill for money that is not going to move.
      console.log(
        `      ${C.dim(`${vault} already exists and is funded — its 3.000 NEAR is not charged again`)}`,
      );
    } else {
      console.log(
        `      contract storage     ${fmtNear(codeStake)} NEAR  ${C.dim(`refundable — ${(Number(readFileSync(wasm).length) / 1024).toFixed(0)} KB staked at 1 NEAR/100 KB`)}`,
      );
      console.log(`      vault balance        ${fmtNear(vaultIdle)} NEAR  ${C.dim("refundable — stakes budget-tree state")}`);
    }
    if (agents.length) {
      // MEASURED on live testnet agents, which contradicted the first version
      // of this label. The 0.5 is a RESERVE, not a spend: NEAR locks the full
      // prepaid gas of a call against the signer and refunds the unused part,
      // so a key needs ~0.5 of headroom to transact at all while burning a
      // tiny fraction of it. The busiest demo agent had spent 0.0077 NEAR.
      //
      // So nearly the whole 0.55 per agent sits intact — and is currently
      // STRANDED, because the agent's own key is function-call only and cannot
      // sign DeleteAccount. Say so rather than implying it gets consumed.
      console.log(
        `      ${agents.length} agent accounts     ${fmtNear(agentTotal)} NEAR  ${C.dim(`${fmtNear(agentFloat)} gas reserve, barely consumed`)}`,
      );
      console.log(
        `      ${C.dim("")}                     ${C.dim("not yet reclaimable — see float-exit")}`,
      );
    } else {
      console.log(
        `      ${C.dim("agent accounts")}       ${C.dim("none — add later with --agents, 0.55 NEAR each")}`,
      );
    }
    console.log(`      ${C.b("you send")}             ${C.b(fmtNear(total))} NEAR`);
    console.log(
      `      ${C.dim("burned")}               ${C.dim("~0.02 NEAR of gas — the only part that does not come back")}`,
    );
    console.log(
      `\n    ${C.dim(`Recover it with:  npx -p @floatonnear/create-float float-exit --owner ${owner}`)}`,
    );
    console.log(
      `    ${C.dim("That withdraws tokens, deletes the accounts, and refunds you.")}`,
    );

    // getBalance() returns a bigint of yoctoNEAR, NOT an object. Reading it as
    // `{available}` yields undefined, which coerces to a balance of zero and
    // turns the affordability check into a hard stop for every real user. The
    // dry run is what caught it; the shape is asserted below so a future
    // library change surfaces as an error rather than as a false refusal.
    const available = await ownerAcct.getBalance();
    if (typeof available !== "bigint") {
      throw new Error(
        `expected getBalance() to return a bigint, got ${typeof available}. ` +
          `Refusing to guess at your balance — near-api-js may have changed shape.`,
      );
    }
    console.log(`\n      your balance         ${fmtNear(available)} NEAR`);
    if (available < total) {
      throw new Error(
        `insufficient balance: need ${fmtNear(total)}, have ${fmtNear(available)}\n` +
          `  Top up at https://near-faucet.io/`,
      );
    }

    // The gate sits AFTER the balance read and the affordability check, not
    // before. A dry run reports what the plan COSTS and whether you can afford
    // it; hoisting this above them would make `--dry-run` answer "fine" on a
    // balance too small to proceed. Pinned from both sides by M35 and M36 in
    // docs/MUTATIONS.md.
    if (DRY) {
      console.log(`\n${C.y("dry run")} — nothing was sent.\n`);
      return;
    }
    if (MAINNET) {
      // Typed, not a y/N. A flag or a single keystroke is the kind of thing
      // that gets copy-pasted out of a README; spelling out the word is not.
      console.log(`
    ${C.y("This is MAINNET. Real funds.")}

      - The budget tree above is the ONLY thing limiting what agents spend.
      - The daily window resets at 00:00 UTC and is a cliff, not a rolling
        24 hours: an agent can spend its cap at 23:59 and again at 00:01.
      - Agent private keys are written to .float/agent-keys.json in plain
        text. Anyone who reads that file can spend up to those caps.
      - This contract has not been audited.`);
      const typed = await ask(rl, `\n    Type ${C.b("mainnet")} to continue`, "");
      if (typed !== "mainnet") {
        console.log("\n    cancelled.\n");
        return;
      }
    } else if (!YES) {
      const go = await ask(rl, `\n    Proceed? (y/N)`, "N");
      if (!/^y/i.test(go)) {
        console.log("\n    cancelled.\n");
        return;
      }
    }

    // ---- 4. The vault account. Skipped if it already exists, so a failed
    // run can be resumed rather than restarted.
    step(4, "Creating the vault account");
    const vaultKey = KeyPair.fromRandom("ed25519");
    let vaultSecret = vaultKey.toString();
    let exists = true;
    try {
      await new Account(vault, provider).getState();
    } catch {
      exists = false;
    }
    if (exists) {
      skip(`${vault} already exists`);
      if (!existsSync(credPath(vault))) {
        // Only reachable for a vault rotated by an OLDER create-float, which
        // deleted this file instead of repointing it. Step 9 now rewrites it
        // with the owner's key, so a rotated vault keeps a usable signer and
        // comes in through the `else` branch below.
        //
        // Still a legitimate state, not a broken run — the vault works, it just
        // has no key here. So refuse only if something ahead needs a
        // vault-signed action.
        const initialised = await viewSafe(provider, vault, "get_config");
        if (!initialised) {
          throw new Error(
            `${vault} exists but there is no key for it at ${credPath(vault)},\n` +
              `  and the contract is not initialised.\n` +
              `  Deploying and initialising require the vault to sign for itself, so this\n` +
              `  run cannot continue. If the key was rotated to the owner, deploy with that\n` +
              `  wallet instead.`,
          );
        }
        vaultSecret = null;
        skip("vault key already rotated to the owner — no step here needs it");
      } else {
        vaultSecret = JSON.parse(readFileSync(credPath(vault), "utf8")).private_key;
      }
    } else {
      await ownerAcct.createSubAccount({
        accountOrPrefix: vault,
        publicKey: vaultKey.getPublicKey(),
        nearToTransfer: VAULT_FUND,
      });
      mkdirSync(dirname(credPath(vault)), { recursive: true });
      writeFileSync(
        credPath(vault),
        JSON.stringify({ account_id: vault, public_key: vaultKey.getPublicKey().toString(), private_key: vaultSecret }, null, 2),
      );
      ok(`${vault} created, funded with ${fmtNear(VAULT_FUND)} NEAR`);
      ok(`setup key at ${credPath(vault)} ${C.dim("(temporary — removed in step 9)")}`);
    }

    // A null secret means the key was already rotated away. Reads (and
    // getAccessKeyList) need no signer, so build a read-only Account rather
    // than crashing on KeyPair.fromString(null).
    const vaultAcct = vaultSecret
      ? new Account(vault, provider, new KeyPairSigner(KeyPair.fromString(vaultSecret)))
      : new Account(vault, provider);

    // ---- 5. Contract.
    // ---- 4b. The two things this wizard used to disown.
    //
    // Registration must precede the transfer: ft_transfer to an unregistered
    // account panics with "The account ... is not registered". Measured on
    // mainnet, where the first cross-chain payment failed exactly this way.
    // planTokenSetup orders the steps; this just runs them.
    if (tokenPlan.steps.length) {
      for (const a of tokenPlan.steps) {
        if (a.action === "storage_deposit") {
          await ownerAcct.callFunction({
            contractId: token,
            methodName: "storage_deposit",
            args: { account_id: a.account, registration_only: true },
            gas: 30n * 10n ** 12n,
            deposit: a.deposit,
          });
          ok(`${vault} registered on ${token} ${C.dim(`(${fmtNear(a.deposit)} NEAR, refundable)`)}`);
        } else {
          await ownerAcct.callFunction({
            contractId: token,
            methodName: "ft_transfer",
            args: { receiver_id: a.to, amount: String(a.amount) },
            gas: 30n * 10n ** 12n,
            deposit: 1n,
          });
          ok(`funded ${vault} with ${opt("--fund", "")} ${token}`);
        }
      }
    }
    for (const w of tokenPlan.warnings) warn(w);

    step(5, "Deploying the contract");
    // `wasm` was resolved in the preflight, before anything was spent.
    if (!vaultSecret) {
      skip("contract already deployed; the vault key now lives in the owner wallet");
    } else {
      const code = readFileSync(wasm);
      await vaultAcct.deployContract(code);
      ok(`deployed ${(code.length / 1024).toFixed(0)} KB from ${wasm}`);
    }

    // `new` demands predecessor == the vault itself, so that nobody can
    // initialise a freshly deployed vault with their own owner. Signing as the
    // vault is what satisfies it.
    const already = await viewSafe(provider, vault, "get_config");
    if (already) {
      skip("already initialised");
    } else {
      await vaultAcct.callFunction({
        contractId: vault,
        methodName: "new",
        args: { owner, network: NETWORK, strict_allocation: false },
        gas: 100n * 10n ** 12n,
        deposit: 0n,
      });
      ok(`initialised, owner ${owner}, overcommit mode`);
    }

    // ---- 6. Tree.
    step(6, "Building the budget tree");
    const existingTree = (await viewSafe(provider, vault, "get_tree")) ?? [];
    const byLabel = new Map(existingTree.map((n) => [n.label, n.id]));
    for (const n of nodes) {
      if (byLabel.has(n.label)) {
        skip(`${n.label} exists (node ${byLabel.get(n.label)})`);
        continue;
      }
      const id = await ownerAcct.callFunction({
        contractId: vault,
        methodName: "add_node",
        args: {
          parent: n.parent === null ? null : byLabel.get(n.parent),
          label: n.label,
          limits: [
            {
              token,
              daily_cap: String(toBaseUnits(n.daily, decimals)),
              per_tx_cap: String(toBaseUnits(n.perTx, decimals)),
            },
          ],
          cooldown_sec: 0,
          // The owner is allowlisted on the root so there is always a way for
          // funds to come back out, even before anyone discovers `withdraw`.
          // Children inherit from the nearest ancestor that sets a list.
          recipients: n.parent === null ? [owner] : null,
        },
        gas: 100n * 10n ** 12n,
        deposit: 1n,
      });
      byLabel.set(n.label, id);
      ok(`${n.label} → node ${id}  (${n.daily}/day, ${n.perTx}/tx)`);
    }

    // ---- 7. Agent keys.
    step(7, "Creating agent accounts");
    const created = [];
    for (const a of agents) {
      const agentId = `${a.label}.${vault}`;
      let agentExists = true;
      try {
        await new Account(agentId, provider).getState();
      } catch {
        agentExists = false;
      }
      if (agentExists) {
        skip(`${agentId} exists — leaving its key alone`);
        continue;
      }
      const kp = KeyPair.fromRandom("ed25519");
      await ownerAcct.callFunction({
        contractId: vault,
        methodName: "create_agent_account",
        args: {
          node_id: byLabel.get(a.label),
          sub_label: a.label,
          public_key: kp.getPublicKey().toString(),
          key_allowance: AGENT_KEY_ALLOWANCE.toString(),
        },
        gas: 100n * 10n ** 12n,
        deposit: AGENT_COST,
      });
      created.push({ nodeId: byLabel.get(a.label), agentId, secret: kp.toString() });
      ok(`${agentId} — restricted key, may only call request_payment`);
    }

    // ---- 8. The quote signer, for the cross-chain rail.
    //
    // Generated and registered here rather than left as a manual
    // `set_quote_signer` call, because a setup step that is "documented" and
    // not performed is a step that gets skipped — and the symptom is every
    // cross-chain payment refused with QUOTE_SIGNER_UNSET long after anyone
    // remembers why.
    //
    // MAINNET ONLY, on purpose. NEAR Intents has no testnet, so on testnet
    // this key would authorise a rail that cannot be used. Registering one
    // there would be theatre, and worse, it would teach the habit of having
    // a live signing key around for no reason.
    step(8, "Cross-chain quote signer");
    let quoteSignerSecret = null;
    if (!MAINNET) {
      skip("testnet — NEAR Intents is mainnet-only, so the cross-chain rail stays closed");
    } else {
      const existing = await viewSafe(provider, vault, "get_quote_signer");
      if (existing) {
        // Never silently replace one. A key already registered may be in use
        // by a running adapter; overwriting it would close the rail for that
        // process with no error anywhere near the cause.
        skip("a quote signer is already registered — leaving it alone");
        warn("to rotate it: set_quote_signer with a new key, then update FLOAT_QUOTE_SIGNER_KEY");
      } else {
        // Generated with raw ed25519, NOT near-api-js KeyPair.
        //
        // This is not a NEAR account key — it is a plain keypair the contract
        // verifies with env::ed25519_verify, and going through KeyPair means
        // going through NEAR's encoding. That encoding is base58 with a
        // leading key-type byte, and reading it as base64 silently yields a
        // seed of the wrong length (65 or 66 bytes, varying per key) whose
        // derived public key matches nothing. The failure mode is every
        // cross-chain payment refused with QUOTE_BAD_SIGNATURE, long after
        // setup, with nothing pointing at the cause. Caught exactly that way.
        const seed = randomBytes(32);
        const pub = Buffer.from(ed25519.getPublicKey(new Uint8Array(seed)));
        quoteSignerSecret = seed.toString("hex");

        await ownerAcct.callFunction({
          contractId: vault,
          methodName: "set_quote_signer",
          args: { public_key: pub.toString("base64") },
          gas: 30n * 10n ** 12n,
          deposit: 1n,
        });
        ok("generated and registered — the cross-chain rail is now open");
      }
    }

    // The closing advice has to describe the tree that was built. The
    // mainnet tree has different numbers, and a hardcoded sentence would
    // confidently instruct the user to spend amounts their caps reject.
    const leaves = nodes.filter((n) => n.agent);
    const pool = nodes.find((n) => n.label === leaves[0]?.parent);
    const each = pool ? Math.min(leaves[0].perTx, pool.daily * 0.7) : 0;
    const tryFirst =
      pool && leaves.length >= 2
        ? `have ${leaves[0].label} and ${leaves[1].label} each spend ${each}. Both have ` +
          `${leaves[0].daily} of their own limit, so both look fine — but ${pool.label} ` +
          `only holds ${pool.daily}, and the second will be refused with the pool ` +
          `empty. That refusal is the product.`
        : "spend from an agent and watch the budget tree charge every level above it.";

    // The cap the cross-chain sentence should talk about: the SPENDING node's
    // per-tx limit, since that is the one a payment is checked against first.
    // Falls back through the tree rather than assuming an `agent: true` leaf
    // exists — a virtual-agent vault has spending nodes with no bound account,
    // and defaulting to 0 there would print "delivers at most 0.00".
    const leafPerTx = leaves[0]?.perTx
      ?? nodes[nodes.length - 1]?.perTx
      ?? nodes[0]?.perTx
      ?? 0;

    // ---- 9. Hand the vault's full-access key to the owner's wallet.
    //
    // Runs LAST of the on-chain steps, because every vault-signed action
    // (deployContract, the `new` init call) needs the setup key that this
    // removes. Rotating earlier would strand the rest of the run.
    //
    // Why it matters: a full-access key on the VAULT can call the token's
    // ft_transfer as the vault and move the entire balance with no contract
    // logic involved — bypassing caps, the allowlist, cooldowns and the pause
    // switch — and can DeployContract or DeleteAccount. It is strictly more
    // powerful than the owner key, and it used to be written to
    // ~/.near-credentials and left there forever.
    step(9, "Securing the vault key");
    {
      // null once rotated: rotationPlan then sees no setup key and reports done.
      const setupPk = vaultSecret ? KeyPair.fromString(vaultSecret).getPublicKey().toString() : null;
      const ownerPk = cred.public_key;
      const { keys } = await vaultAcct.getAccessKeyList();
      const plan = rotationPlan({ keys, ownerPublicKey: ownerPk, setupPublicKey: setupPk });

      if (plan.action === "blocked") {
        // Not fatal: the vault works. But say so loudly rather than printing a
        // success line over a vault whose key is still on disk.
        warn(`vault key NOT rotated — ${plan.reason}`);
      } else if (plan.action === "done") {
        skip("vault key already belongs to the owner");
      } else {
        // Order and failure-skipping both live in applyRotation, where they
        // are asserted at runtime. Earlier versions inlined the loop here and
        // "tested" the ordering by reading the source, which a mutation pass
        // showed to be both false-negative and false-positive prone.
        await applyRotation(plan, {
          addOwnerKey: async () => {
            await vaultAcct.addFullAccessKey(ownerPk);
            ok(`${owner}'s key added to ${vault} — upgrades are now a wallet signature`);
          },
          removeSetupKey: async () => {
            await vaultAcct.deleteKey(setupPk);
            ok(`setup key removed from ${vault}`);
          },
          // Runs only after both chain steps resolve. If the removal failed,
          // this file is the only thing that can finish the job on a re-run.
          //
          // REPOINTED, NOT DELETED. A DeployContract action applies to the
          // signer's own account, so a deploy's signer_id must equal its
          // receiver_id: the vault can only ever be upgraded by a full-access
          // key ON the vault, which after this rotation is the owner's. And
          // near-cli-rs's legacy keychain finds that key by FILENAME, so
          // `near contract deploy <vault>` reads the file named after the
          // VAULT. Deleting it left no signer and killed the upgrade path;
          // doing the same rotation by hand on mainnet left the file holding
          // the key just removed, which cost three failed deploys on
          // 2026-10-31. Either way the next upgrade is broken.
          //
          // The owner's secret already sits in this same directory under the
          // owner's own filename, so this exposes nothing new.
          repointCredential: async () => {
            writeFileSync(
              credPath(vault),
              JSON.stringify(
                repointedCredential({ vault, ownerPublicKey: ownerPk, ownerPrivateKey: ownerKey }),
                null,
                2,
              ),
            );
            ok(`${credPath(vault)} now points at ${owner}'s key — upgrades keep working`);
          },
        });
      }
    }

    // ---- 10. Config the user would otherwise hand-write.
    step(10, "Writing configuration");
    mkdirSync(".float", { recursive: true });

    const envPath = join(".float", "adapter.env");
    const first = created[0];
    writeFileSync(
      envPath,
      [
        `# Written by create-float. The adapter serves the dashboard's /v1 API.`,
        `NEAR_VAULT_CONTRACT=${vault}`,
        `NEAR_VAULT_RPC_URL=${RPC}`,
        `NEAR_VAULT_TOKEN=${token}`,
        `NEAR_VAULT_TOKEN_DECIMALS=${decimals}`,
        `PORT=8787`,
        ``,
        `# Required for POST /v1/pay, which signs with the agent key below.`,
        `# Without it the adapter still serves the dashboard's reads but`,
        `# REFUSES to spend. Generated per vault, never reused.`,
        `#`,
        `# The adapter binds 127.0.0.1 only. Set HOST to expose it, and`,
        `# understand what that means first: this endpoint moves money.`,
        `FLOAT_API_TOKEN=${randomBytes(24).toString("base64url")}`,
        ``,
        `# The adapter signs POST /v1/pay as ONE agent. A vault with several`,
        `# agents needs one adapter per agent, or the agents sign for`,
        `# themselves through the MCP server.`,
        first ? `NEAR_VAULT_AGENT_ID=${first.agentId}` : `# NEAR_VAULT_AGENT_ID=`,
        first ? `NEAR_VAULT_AGENT_KEY=${first.secret}` : `# NEAR_VAULT_AGENT_KEY=`,
        ``,
        `# Opens the cross-chain rail. This key binds a payee to a one-time`,
        `# deposit address, so whoever holds it can redirect any Intents`,
        `# payment the budget allows — it belongs to the OPERATOR, not to the`,
        `# machines agents run on.`,
        quoteSignerSecret
          ? `FLOAT_QUOTE_SIGNER_KEY=${quoteSignerSecret}`
          : MAINNET
            ? `# FLOAT_QUOTE_SIGNER_KEY=  (a signer was already registered; paste its secret)`
            : `# FLOAT_QUOTE_SIGNER_KEY=  (mainnet only — NEAR Intents has no testnet)`,
      ].join("\n") + "\n",
    );
    ok(`${envPath}`);
    if (quoteSignerSecret) {
      // Written once, into the gitignored dir, and deliberately NOT echoed.
      // A secret printed to stdout ends up in scrollback, in CI logs, and in
      // whatever the user pastes when they ask someone for help.
      warn(`${envPath} now holds the quote-signer secret. Do not commit or paste it.`);
    }

    if (created.length) {
      const keysPath = join(".float", "agent-keys.json");
      writeFileSync(keysPath, JSON.stringify(created, null, 2) + "\n");
      ok(`${keysPath}`);
      warn(`${keysPath} holds private keys. It is git-ignored; do not commit it.`);
      const gi = join(".float", ".gitignore");
      if (!existsSync(gi)) writeFileSync(gi, "*\n");
    }

    // Merge into EVERY MCP client on this machine — read, modify one key,
    // write back, once per client.
    //
    // This used to target Claude Desktop alone, at one hardcoded path, and
    // `mkdirSync(..., { recursive: true })` ran whether or not the app was
    // installed — so it created `%APPDATA%\Claude\` on machines that had never
    // run Claude Desktop, and told users driving Claude Code or Cursor that
    // their client was configured when nothing they read had changed.
    //
    // mcpTargets only returns clients whose own directory already exists, so a
    // client we cannot detect is skipped rather than fabricated. The exception
    // is the per-project `.mcp.json`, where writing the file IS the install.
    const entry = {
      command: "npx",
      args: ["-y", "@floatonnear/mcp"],
      env: {
        NEAR_VAULT_CONTRACT: vault,
        NEAR_VAULT_RPC_URL: RPC,
        NEAR_VAULT_TOKEN: token,
        NEAR_VAULT_TOKEN_DECIMALS: String(decimals),
        ...(first ? { NEAR_VAULT_AGENT_ID: first.agentId, NEAR_VAULT_AGENT_KEY: first.secret } : {}),
      },
    };
    const targets = mcpTargets({
      home: homedir(),
      appData: process.env.APPDATA,
      platform: platform(),
      cwd: process.cwd(),
      exists: existsSync,
      join,   // node:path.join — without it Windows gets mixed separators
    });
    for (const r of writeMcpConfigs({ targets, entry })) {
      // The loop itself lives in mcp-config.mjs so it can be tested against
      // real files. Here we only report, which is the part that cannot be
      // asserted from a unit test anyway.
      if (r.skipped === "unparseable") {
        warn(`${r.target.path} could not be parsed as JSON — leaving it untouched`);
        continue;
      }
      if (r.skipped === "absent") continue;

      ok(`${r.target.name}: ${r.target.path} ${C.dim(`(only the '${r.entryKey}' entry was changed)`)}`);
      if (r.collided) {
        // `float` belonged to someone else — on the machine where this was
        // found, to @usefloat/mcp holding an owner key. The old message read
        // "(only the 'float' entry was changed)" while changing exactly that.
        warn(
          `'float' in ${r.target.path} is another server — left untouched. ` +
            `This vault was added as '${r.entryKey}'; refer to it by that name.`,
        );
      }
    }
    if (!targets.some((t) => !t.perProject)) {
      warn(
        "no global MCP client detected (Claude Desktop, Cursor) — wrote the " +
          "project .mcp.json only. Add the 'float' entry by hand if your client " +
          "reads somewhere else.",
      );
    }

    // ---- 9. What is still a manual step, stated plainly.
    console.log(`
${C.g("Done.")} ${vault} is live.

${C.b("Still to do:")}

${fundingNotice(tokenPlan, { token, vault, owner, network: NETWORK, decimals }).map((l) => `  ${l}`).join("\n")}

  1. Restart your MCP client so it picks up the new server.

${C.b("Check it yourself — every account the wizard touched:")}

${handoffLines(
  handoffLinks({
    vault, owner, token, symbol: meta.symbol, network: NETWORK,
    canFundFromOwner: tokenPlan.canFundFromOwner,
    agentIds: created.map((c) => c.agentId),
  }),
  C.dim,
).map((l) => (l ? `  ${l}` : "")).join("\n")}

${C.b("Then:")}

  ${C.dim("# the API the dashboard reads (no shell sourcing; same on PowerShell)")}
  FLOAT_ENV_FILE=.float/adapter.env npx @floatonnear/float-adapter

  ${C.dim("# the dashboard")}
  cd apps/dashboard && npm run dev

${C.b("What to try first:")} ${tryFirst}
${quoteSignerSecret ? `
${C.b("Cross-chain is open.")} Pay an address on Base straight from this NEAR
balance — a solver delivers and prices the gas in:

  curl -X POST localhost:8787/v1/pay -H 'content-type: application/json' \
    -d '{"amount":"0.50","recipient":"0xYourBaseAddress","rail":"intents"}'

${C.b("Why your caps are not round numbers.")} A quote is EXACT_OUTPUT: ${C.dim("amount")} is what
the payee RECEIVES, and the vault is charged more — solver fee plus a slippage
reserve. The tree is charged that larger figure, which is correct, because a cap
governs what actually leaves. So the caps above are pre-sized ~2% high: a per-tx
cap of ${leafPerTx} is there to let you deliver a round ${fmtDeliver(xchainCeiling(leafPerTx))}, and the daily caps
follow the same shape.

Two things that follow:

  ${C.b("*")} These caps apply to ${C.b("both rails")}. ${leafPerTx} per transaction means a direct
    NEAR payment can also spend ${leafPerTx} — 2% more than the round figure. If an
    exact direct-payment ceiling matters more to you than round cross-chain
    amounts, set the caps to flat numbers and accept delivering ~98% of them.

  ${C.b("*")} If you ${C.b("do")} flatten them, a request for the full cap is refused by
    ${C.b("your own budget")}, not by the solver, and nothing in the error mentions
    cross-chain. That reads like a bug unless you are expecting it.

Measured ~1.03% at 100 and ~1.5% at 0.50 — worst at small sizes, since most of
it is the slippage reserve rather than fee. Re-check before trusting it:

  ${C.dim("node --experimental-strip-types scripts/oneclick-probe.mjs")}
` : ""}`);
  } finally {
    rl?.close();
  }
}

/**
 * A view call that yields null instead of throwing.
 *
 * This is what makes the wizard resumable: "is the contract already
 * initialised", "which nodes already exist". Note the argument shape —
 * `callFunction` takes a single object with `contractId`/`method`. Passing
 * positional arguments does not fail loudly; it sends a malformed request that
 * throws, which this function would then swallow as null. Every existence
 * check would quietly answer "no", and a second run would try to rebuild a
 * tree that was already there. Hence the smoke test in test/.
 */
async function viewSafe(provider, contractId, method, args = {}) {
  try {
    return await provider.callFunction({ contractId, method, args });
  } catch {
    return null;
  }
}

main().catch((e) => {
  console.error(`\n${C.r("failed")}  ${e.message}\n`);
  // `process.exitCode`, NOT `process.exit`. By the time main() rejects it has
  // made RPC calls, and exiting outright tears the event loop down while a
  // handle is still closing. Measured against the published 0.3.1 on 2026-11-01:
  //
  //   failed  insufficient balance: need 3.347, have 0.177
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
  //
  // The message printed correctly, so a human still learns what went wrong —
  // but the exit code became -1073740791 instead of 1, so anything SCRIPTING
  // the wizard saw a native crash rather than a clean failure. Setting the code
  // lets the loop drain.
  //
  // The three other process.exit calls in this file are at MODULE SCOPE, before
  // any network I/O, where exiting immediately is both safe and intended.
  process.exitCode = 1;
});

/**
 * Send a fresh wallet enough NEAR to create a vault, and prove it is enough.
 *
 * The point of this script is the arithmetic, not the transfer. "Fund it with
 * about three and a half" has failed in a wallet before:
 *
 *   Sender work12.testnet does not have enough balance 3.5234
 *   for operation costing 3.674061500357969
 *
 * because a transaction reserves `prepaid_gas * 1e9` at the MAXIMUM gas price
 * for the duration of the call. Almost none of it is burned — about 0.004 in
 * practice — but the wallet checks the balance against the reservation and
 * refuses below it. So the figure a new owner must HOLD is the deposit plus
 * the reservation, and that is what gets sent.
 *
 * EVERY INPUT IS READ, NOT ASSUMED:
 *   required_deposit   from the factory's own `get_config` view
 *   contract bytes     from the wasm file on disk
 *   gas                from CREATE_GAS_TGAS, the constant the page attaches
 *
 * A hardcoded total would be wrong the next time the contract is rebuilt or
 * the factory's deposit is retuned, and wrong in the direction that strands a
 * user at a wallet prompt they cannot satisfy.
 *
 *   node scripts/fund-new-owner.mjs <recipient-account-id> [extra-near]
 */
import { statSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { Account, KeyPair, KeyPairSigner, JsonRpcProvider } from "near-api-js";

const ROOT = resolve(import.meta.dirname, "..");
// POSITIONALS ONLY. `--agent` sitting in argv[3] was parsed as the extra-near
// amount and reached `BigInt("--agent")`, which throws inside main() — an
// unhandled rejection that also resurrected the libuv exit abort. Flags and
// positionals must be separated before either is read.
const POSITIONAL = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const TO = POSITIONAL[0] ?? process.env.TO;
// Slack on top of the required hold: covers the ~0.004 actually burned by the
// create, plus a little gas for whatever the new owner does next.
const EXTRA_NEAR = POSITIONAL[1] ?? process.env.EXTRA_NEAR ?? "0.15";
const FROM = process.env.FROM ?? "floatv4.testnet";
const NETWORK = process.env.NETWORK ?? "testnet";
const FACTORY = process.env.FACTORY ?? (NETWORK === "mainnet" ? undefined : "fac.floatv4.testnet");
const WASM = process.env.WASM ?? join(ROOT, "packages", "create-float", "res", "vault.wasm");
const RPC =
  process.env.RPC ??
  (NETWORK === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

// Must match CREATE_GAS_TGAS in packages/mcp/src/create.ts and web/index.html.
const CREATE_GAS_TGAS = 200n;
const STORAGE_COST_PER_BYTE = 10n ** 19n;

const p = new JsonRpcProvider({ url: RPC });
const near = (y, dp = 6) => {
  const neg = y < 0n;
  const v = neg ? -y : y;
  return `${neg ? "-" : ""}${v / 10n ** 24n}.${(v % 10n ** 24n).toString().padStart(24, "0").slice(0, dp)}`;
};
const toYocto = (s) => {
  const [w, f = ""] = String(s).split(".");
  return BigInt(w) * 10n ** 24n + BigInt(f.padEnd(24, "0").slice(0, 24));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (a) =>
  BigInt((await p.viewAccount({ accountId: a, blockQuery: { finality: "final" } })).amount);
const credPath = (a) => join(homedir(), ".near-credentials", NETWORK, `${a}.json`);

/**
 * Everything that touches the network runs inside `main` so a fatal path can
 * RETURN rather than call `process.exit()`.
 *
 * `process.exit()` after the provider has opened a socket aborts in libuv's
 * teardown on Windows:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c
 *
 * which replaced the real exit code with 127 and printed a crash on top of a
 * message that was, in fact, the script working correctly. Returning lets the
 * event loop drain and `process.exitCode` survive. The argument checks below
 * still exit directly — nothing has opened a socket yet at that point.
 */
async function main() {
  // ---- what does a vault actually cost, right now --------------------------
  const cfg = await p.callFunction({
    contractId: FACTORY,
    method: "get_config",
    args: {},
    blockQuery: { finality: "final" },
  });
  if (cfg.paused) {
    console.error(`FATAL: ${FACTORY} is paused — a funded wallet still could not create a vault.`);
    return 1;
  }

  const bytes = BigInt(statSync(WASM).size);

  // THE FACTORY'S FLOOR IS NOT WHAT THE USER IS ASKED FOR, and funding to the
  // floor is what this script got wrong the first time.
  //
  // `begin()` in contracts/factory/src/lib.rs rejects below
  // `required_deposit + bytes * 1e19` — 3.037280 today. But web/index.html
  // attaches `stake + 0.36` instead, deliberately, as headroom for the root
  // node's state. Measured 2026-11-03: tinyrice9138.testnet's vault holds
  // exactly 3.297280, the page's figure to the yocto.
  //
  // A wallet checks the balance against what the PAGE attaches. Funding the
  // floor plus 0.15 slack sent 3.387280 against a 3.497280 requirement, which
  // is the `does not have enough balance` rejection quoted at the top of this
  // file — reintroduced by the very script that documents it.
  //
  // So the page's constant is read FROM the page. A fourth hardcoded copy of
  // this number would drift like the others; if the pattern stops matching
  // this fails loudly rather than falling back to a figure that strands
  // someone at a wallet prompt.
  const pageSrc = readFileSync(join(ROOT, "web", "index.html"), "utf8");
  const m = pageSrc.match(/const baseTotal = stake \+ (\d+)n \* 10n \*\* (\d+)n;/);
  if (!m) {
    console.error(`FATAL: cannot find the deposit formula in web/index.html.`);
    console.error(`  This script funds whatever that page asks for, and it can no`);
    console.error(`  longer tell what that is. Re-read the page and fix the pattern`);
    console.error(`  rather than guessing — an underfunded wallet cannot sign.`);
    return 1;
  }
  const headroom = BigInt(m[1]) * 10n ** BigInt(m[2]);

  // AND THE AGENT'S GAS KEY, when the link carries one.
  //
  // A create link with `agent_pk` attaches 0.12 more, because the factory
  // installs and funds a NEP-611 gas key in the same batch and raises its own
  // deposit floor to match. Funding without this term underfunds by exactly
  // that much — the same failure as the 0.26 headroom miss this script was
  // written to fix, arriving through a third term.
  //
  // Read from the page, like the headroom, and FATAL rather than defaulting
  // to zero: a silent zero here is indistinguishable from "no agent", and
  // produces a wallet the user cannot sign with.
  const WITH_AGENT = process.env.AGENT === "1" || process.argv.includes("--agent");
  let agentGas = 0n;
  if (WITH_AGENT) {
    const g = pageSrc.match(/const AGENT_GAS = (\d+)n \* 10n \*\* (\d+)n;/);
    if (!g) {
      console.error(`FATAL: --agent was requested but web/index.html has no AGENT_GAS constant.`);
      console.error(`  Refusing to guess it — funding short strands the wallet at the prompt.`);
      return 1;
    }
    agentGas = BigInt(g[1]) * 10n ** BigInt(g[2]);
  }

  const stake = bytes * STORAGE_COST_PER_BYTE;
  const floor = BigInt(cfg.required_deposit) + stake + agentGas;
  const deposit = stake + headroom + agentGas;
  const reservation = CREATE_GAS_TGAS * 10n ** 12n * 10n ** 9n;
  const mustHold = deposit + reservation;
  const send = mustHold + toYocto(EXTRA_NEAR);

  console.log(`factory          ${FACTORY}  (owner ${cfg.owner})`);
  console.log(`  contract         ${bytes} B -> ${near(stake)} storage stake`);
  console.log(`  factory floor    ${near(floor)}  (required_deposit ${near(BigInt(cfg.required_deposit))} + stake)`);
  console.log(`  page headroom    ${near(headroom)}  (read from web/index.html)`);
  if (WITH_AGENT) console.log(`  agent gas key    ${near(agentGas)}  (--agent)`);
  console.log(`  page attaches    ${near(deposit)}  <-- what the wallet is asked for`);
  if (deposit < floor) {
    console.error(`\nFATAL: the page attaches ${near(deposit)}, below the factory's`);
    console.error(`  ${near(floor)} floor. The create would be rejected on chain.`);
    return 1;
  }
  console.log(`  gas reservation  ${near(reservation)}  (${CREATE_GAS_TGAS} TGas at max price)`);
  console.log(`  MUST HOLD        ${near(mustHold)}`);
  console.log(`  + slack          ${EXTRA_NEAR}`);
  console.log(`  SENDING          ${near(send)}`);

  // ---- can the sender afford it -------------------------------------------
  if (!existsSync(credPath(FROM))) {
    console.error(`\nFATAL: no credential for ${FROM} at ${credPath(FROM)}`);
    return 1;
  }
  const f = JSON.parse(readFileSync(credPath(FROM), "utf8"));
  const secret = f.private_key ?? f.secret_key;
  if (!secret) {
    console.error(`\nFATAL: ${credPath(FROM)} holds no private key — it cannot sign.`);
    return 1;
  }
  const kp = KeyPair.fromString(secret);

  // The recipient must EXIST. A transfer cannot create a named account, and a
  // typo in a wallet-supplied account id is the likeliest thing to go wrong
  // here — the NEAR a typo sends is simply gone.
  let toBefore;
  try {
    toBefore = await bal(TO);
  } catch {
    console.error(`\nFATAL: ${TO} does not exist on ${NETWORK}.`);
    console.error(`  Check the spelling against the wallet. A transfer cannot`);
    console.error(`  create a named account, and NEAR sent to a typo is gone.`);
    return 1;
  }

  const fromBefore = await bal(FROM);
  console.log(`\nfrom  ${FROM}  ${near(fromBefore)}`);
  console.log(`to    ${TO}  ${near(toBefore)}`);

  // Leave the sender able to pay for its own gas afterwards.
  const KEEP = toYocto("0.05");
  if (fromBefore < send + KEEP) {
    console.error(`\nFATAL: ${FROM} holds ${near(fromBefore)} but needs ${near(send + KEEP)}`);
    console.error(`  (${near(send)} to send plus ${near(KEEP)} kept back for its own gas)`);
    return 1;
  }

  console.log(`\ntransferring ...`);
  await new Account(FROM, p, new KeyPairSigner(kp)).transfer({ receiverId: TO, amount: send });

  // Poll to the EXPECTED value. A balance read straight after a write can be a
  // whole transaction behind, and a stale value here reads as a failed
  // transfer — "it changed" is not enough, because a stale value has already
  // changed.
  let toAfter = toBefore;
  for (let i = 0; i < 20 && toAfter < toBefore + send; i++) {
    await sleep(1000);
    toAfter = await bal(TO);
  }
  const fromAfter = await bal(FROM);

  console.log(`\nfrom  ${FROM}  ${near(fromAfter)}  (${near(fromAfter - fromBefore)})`);
  console.log(`to    ${TO}  ${near(toAfter)}  (+${near(toAfter - toBefore)})`);

  if (toAfter < mustHold) {
    console.error(`\nINCOMPLETE: ${TO} holds ${near(toAfter)}, below the ${near(mustHold)} needed.`);
    return 1;
  }

  console.log(`\nREADY. ${TO} can now sign a vault creation (needs ${near(mustHold)}).`);
  console.log(`Open the create link with this wallet connected — the page derives`);
  console.log(`the vault address from whichever wallet it sees, so no owner needs`);
  console.log(`to be typed.`);
  return 0;
}

// ---- argument checks, before anything opens a socket -----------------------
if (!TO) {
  console.error("usage: node scripts/fund-new-owner.mjs <recipient-account-id> [extra-near]");
  process.exit(2);
}
if (!FACTORY) {
  console.error(`FATAL: no factory known for ${NETWORK}. Pass FACTORY=...`);
  process.exit(2);
}
if (NETWORK === "mainnet" && process.env.CONFIRM_MAINNET !== "1") {
  console.error("FATAL: mainnet requires CONFIRM_MAINNET=1. This MOVES real NEAR.");
  process.exit(2);
}
if (!existsSync(WASM)) {
  console.error(`FATAL: ${WASM} missing — cannot price the deposit without the contract.`);
  process.exit(1);
}

process.exitCode = await main();

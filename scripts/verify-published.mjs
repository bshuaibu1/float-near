// Verify the PUBLISHED create-float 0.4.0 by driving what the registry serves,
// from a temp directory outside the repo. Reading the repo proves nothing about
// what a user gets; both 0.3.2 defects were found exactly this way.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG = "@floatonnear/create-float@0.4.0";
/** The artifact DEPLOYED and 7/7-validated on mainnet. */
const MAINNET_HASH = "5UcToT1FShk3Ec2vjG7EgXjWtwBiEwsAe98ofh81TQCi";

let fails = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => {
  fails++;
  console.log(`  FAIL  ${m}`);
};
const chk = (c, m) => (c ? ok : bad)(m);
const note = (m) => console.log(`        ${m}`);

const b58 = (buf) => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
};

const dir = mkdtempSync(join(tmpdir(), "float-040-"));
note(`installing ${PKG} into ${dir}`);
execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore", shell: true });
// --prefer-online, and that flag is load-bearing. Without it the install fails
// `notarget` on a freshly published version, because npm's LOCAL packument
// cache still holds the pre-publish response. That is a different cache from
// the registry CDN and lags independently of it.
//
// stdio "pipe", not "ignore": the first run of this script hid the reason the
// install failed, which turned a one-line diagnosis into a guess.
try {
  execFileSync("npm", ["install", PKG, "--no-audit", "--no-fund", "--prefer-online"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
} catch (e) {
  console.error(`install failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`);
  process.exit(1);
}
const root = join(dir, "node_modules", "@floatonnear", "create-float");
const BIN = join(root, "bin", "create-float.mjs");
const AGENT = join(root, "bin", "float-agent.mjs");

console.log("\n[1] Is it 0.4.0, from the registry?");
chk(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version === "0.4.0", "version is 0.4.0");

console.log("\n[2] Does it ship the bytes RUNNING ON MAINNET?");
const wasm = readFileSync(join(root, "res", "vault.wasm"));
const h = b58(createHash("sha256").update(wasm).digest());
chk(wasm.length === 301033, `301033 bytes (got ${wasm.length})`);
chk(h === MAINNET_HASH, "code hash matches the mainnet deployment");
note(`published ${h}`);
note(`mainnet   ${MAINNET_HASH}`);

console.log("\n[3] Is float-agent shipped and runnable?");
chk(existsSync(AGENT), "bin/float-agent.mjs is in the package");
const bins = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).bin;
chk(!!bins["float-agent"], `registered as a bin (${Object.keys(bins).join(", ")})`);
const agentHelp = execFileSync(process.execPath, [AGENT, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
chk(/virtual agent/i.test(agentHelp), "--help describes a virtual agent");
chk(/gas key bound to a node/i.test(agentHelp), "it says what that means");
const ask = agentHelp.match(/About ([\d.]+) NEAR/);
chk(ask !== null, `--help quotes a default ask${ask ? ` (${ask[1]})` : ""}`);
// ONE-SIDED, like its create-float sibling: it may round UP, never down. The
// published 0.4.0 said 0.06 against a real 0.12 — the reservation alone,
// which would fund a key that cannot cover even one call.
chk(ask !== null && Number(ask[1]) >= 0.12, `and does not UNDERSTATE the 0.12 default`);

console.log("\n[4] Is the default tree FLAT, with nothing that can spend?");
// --yes answers every prompt with its default, which is what an agent running
// this non-interactively gets.
let plan = "";
try {
  plan = execFileSync(
    process.execPath,
    [BIN, "--network", "testnet", "--owner", "floatv4.testnet", "--vault", "x.floatv4.testnet", "--dry-run", "--yes"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 },
  );
} catch (e) {
  plan = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const p = strip(plan);
chk(/\broot\b/.test(p), "the plan shows a root node");
chk(!/research/.test(p), "NO `research` node — the 4-node default is gone");
chk(!/\br1\b|\br2\b/.test(p), "no r1/r2 agent leaves");
chk(/nothing can spend until you add one/i.test(p), "it says nothing can spend yet");
const total = p.match(/you send\s+([\d.]+)\s*NEAR/);
chk(total !== null, `it quotes a total${total ? ` (${total[1]})` : ""}`);
chk(total !== null && Number(total[1]) < 3.6, `the total is the flat-vault ask, not 3.897`);

console.log("\n[5] Does --agents refuse instead of silently creating nothing?");
let agentsOut = "";
try {
  agentsOut = execFileSync(
    process.execPath,
    [BIN, "--network", "testnet", "--owner", "floatv4.testnet", "--vault", "x.floatv4.testnet", "--agents", "2", "--dry-run", "--yes"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 },
  );
} catch (e) {
  agentsOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
const a = strip(agentsOut);
chk(/--agents has nothing to attach to/.test(a), "it refuses explicitly");
chk(/gas key bound to a node/.test(a), "and points at the replacement");

console.log("\n[6] Are the quoted costs the NEW ones?");
const help = strip(execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const figs = [...help.matchAll(/\b(\d+\.\d{3})\b/g)].map((m) => Number(m[1]));
chk(figs.length >= 2, `--help quotes both totals (${figs})`);
chk(!figs.includes(3.897), "the old 3.897 vault+agent figure is gone");
chk(!/0\.55 NEAR/.test(help), "--help does not quote 0.55 per agent");
const skill = readFileSync(join(root, "SKILL.md"), "utf8");
chk(!/plus 0\.55 per agent/.test(skill), "SKILL.md does not quote 0.55 per agent");
chk(/~0\.12 per agent/.test(skill), "SKILL.md quotes the virtual-agent cost");

console.log(`\n  ${fails === 0 ? "PUBLISHED 0.4.0 VERIFIED" : `${fails} PROBLEM(S)`}`);
note(`temp dir: ${dir}`);
process.exitCode = fails === 0 ? 0 : 1;

#!/usr/bin/env node
/**
 * Every surface must default to the SAME network.
 *
 * WHY THIS EXISTS. The CLIs defaulted to mainnet and the MCP and adapter
 * defaulted to testnet, for weeks, and nothing anywhere said so. The failure is
 * not an error message: an operator runs `create-float` (mainnet), starts the
 * MCP (testnet), and every read answers "account does not exist" about an
 * account holding real money. That reads as "Float is broken", not as "these
 * two halves disagree about which chain they are on".
 *
 * It survived because each default was individually defensible and no test
 * compared them. Flipping the MCP to mainnet broke ZERO of 290 tests — the
 * value was never the problem, the absence of agreement was.
 *
 * So this asserts agreement itself, across four independently-written surfaces
 * in three languages' worth of syntax. It reads the SOURCE rather than
 * importing, because the CLIs are `.mjs` with top-level `opt()` calls and the
 * page is an HTML file — there is nothing to import, and a reimplementation
 * here could agree with itself while the shipped files disagreed.
 */
import { readFileSync } from "node:fs";

/** The one true default. Change here and the surfaces must follow. */
const EXPECTED = "mainnet";

const LF = String.fromCharCode(10);

/**
 * Each probe pulls the DEFAULT out of one surface's real source.
 *
 * `find` returns the network a surface picks when nothing is configured, or
 * null if the probe could not locate the expression at all — which is reported
 * as a broken probe, never as agreement.
 */
const SURFACES = [
  {
    name: "mcp",
    file: "packages/mcp/src/server.ts",
    // const NETWORK = process.env.NEAR_VAULT_NETWORK ?? "mainnet";
    find: (s) => /NEAR_VAULT_NETWORK\s*\?\?\s*"([a-z]+)"/.exec(s)?.[1] ?? null,
  },
  {
    name: "adapter",
    file: "packages/float-adapter/src/server.ts",
    find: (s) => /NEAR_VAULT_NETWORK\s*\?\?\s*"([a-z]+)"/.exec(s)?.[1] ?? null,
  },
  {
    name: "cli (args.mjs)",
    file: "packages/create-float/bin/args.mjs",
    // const network = opt("--network", "mainnet");
    find: (s) => /opt\("--network",\s*"([a-z]+)"\)/.exec(s)?.[1] ?? null,
  },
  {
    name: "web page",
    file: "web/index.html",
    // const NETWORK = q.get("network") === "testnet" ? "testnet" : "mainnet";
    find: (s) =>
      /q\.get\("network"\)\s*===\s*"[a-z]+"\s*\?\s*"[a-z]+"\s*:\s*"([a-z]+)"/.exec(s)?.[1] ?? null,
  },
];

/** The four other CLI binaries, which each carry their own `--network` default. */
const CLI_BINS = ["float-agent", "float-topup", "float-exit", "float-retire"];
for (const bin of CLI_BINS) {
  SURFACES.push({
    name: `cli (${bin})`,
    file: `packages/create-float/bin/${bin}.mjs`,
    find: (s) => /opt\("--network",\s*"([a-z]+)"\)/.exec(s)?.[1] ?? null,
  });
}

const rows = SURFACES.map((sf) => {
  let src;
  try {
    src = readFileSync(sf.file, "utf8");
  } catch (e) {
    return { ...sf, got: null, err: `cannot read ${sf.file}: ${e.message}` };
  }
  return { ...sf, got: sf.find(src), err: null };
});

/**
 * A PROBE THAT FOUND NOTHING IS A BROKEN PROBE, not a passing surface.
 *
 * This is the failure mode the whole repo keeps relearning: zero matches and
 * "the pattern cannot match" produce identical output. If a default moves to a
 * different expression, this must go red and say so rather than quietly
 * checking three surfaces and calling it four.
 */
const unreadable = rows.filter((r) => r.got === null);
const disagree = rows.filter((r) => r.got !== null && r.got !== EXPECTED);

for (const r of rows) {
  const tag = r.got === null ? "BROKEN" : r.got === EXPECTED ? "ok    " : "DIFFER";
  console.log(`  ${tag} ${r.name.padEnd(20)} ${r.got ?? r.err ?? "default not found"}`);
}

if (unreadable.length) {
  console.error(
    `${LF}BROKEN: ${unreadable.length} probe(s) could not find a network default.` +
      `${LF}  A probe that matches nothing looks exactly like a surface that agrees.` +
      `${LF}  Either the default moved to a new expression — update the probe — or the file did.`,
  );
  process.exit(1);
}

if (disagree.length) {
  console.error(
    `${LF}BROKEN: ${disagree.length} surface(s) do not default to "${EXPECTED}".` +
      `${LF}  ${disagree.map((d) => `${d.name} => ${d.got}`).join(`${LF}  `)}` +
      `${LF}${LF}  A vault created on one chain and read from another does not error. It reports` +
      `${LF}  the vault as missing, which reads as a broken product. Pick one network and make` +
      `${LF}  every surface say it; testnet stays available via NEAR_VAULT_NETWORK / --network.`,
  );
  process.exit(1);
}

console.log(
  `${LF}network defaults: all ${rows.length} surfaces default to "${EXPECTED}"`,
);

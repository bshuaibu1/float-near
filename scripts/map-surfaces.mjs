#!/usr/bin/env node
/**
 * What can Float DO, and what can actually reach it?
 *
 * WHY THIS EXISTS. Every gap found this week was found the same way: a user
 * tripped over it. `float-retire` was missing until someone asked how to shut
 * down an agent. The memo leak surfaced when someone wondered who could read a
 * vault. Seventeen ownerless fetches were found because one page showed the
 * wrong network. None of them were hard to see — nothing was looking.
 *
 * The contract is the product's full capability. Everything else is a way to
 * REACH it: the MCP for an agent, the CLIs for a human, the adapter and
 * dashboard for a browser. So a method with no caller is a feature that
 * shipped and cannot be used — built, tested, deployed, invisible.
 *
 * Run it to see the map. It also fails the build when a NEW method appears
 * with nothing reaching it, because that is the moment to decide whether an
 * interface is owed, not six months later when someone asks for it.
 *
 * DERIVED, NEVER TYPED. A hand-written architecture doc is a snapshot of
 * someone's understanding on one afternoon, and this repo already has docs
 * that contradict the code. Reading the source means the map is wrong only if
 * the source moved, and then it says so.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const LF = String.fromCharCode(10);

/**
 * Methods that legitimately have no user-facing caller, each with its reason.
 *
 * A BARE LIST WOULD ROT. Without the reason, nobody can tell later whether an
 * entry was a decision or someone silencing the check — which is the exact
 * failure this whole script exists to prevent.
 */
const NOT_A_FEATURE = {
  new: "the constructor, called by the factory inside the creation batch",
  migrate: "a borsh migration, run as part of a deploy transaction",
  on_transfer_result: "a cross-contract callback; the runtime calls it, not a person",
  on_withdraw_result: "same",
  fail: "a test-only helper for forcing a failure path",
  set_day_len_ns: "the TEST CLOCK. Reaching it from a product surface is the bug, not the gap",
  is_valid_request_id: "internal validation, exposed for tests",
  available: "a helper on the budget view, not a contract entry point",
  clock_mode: "same",
  get_node: "get_tree returns every node, and vault_tree already renders it",
  get_approval_threshold:
    "the NODE's own value; vault_tree reports get_effective_threshold, which is the one in force because a threshold inherits",
  on_vault_created: "a cross-contract callback the runtime invokes after create_vault",
  vault_id: "an internal helper; vault_id_for is the view callers use",
  create_vault:
    "the GLOBAL-CONTRACT path, deliberately unused: it needs a published global contract (~29.9 NEAR to publish) and every client calls create_vault_with_code instead. Kept so the factory does not need redeploying when that is paid for -- but if it is still here in six months with no publish, it is dead code, not an option",
  set_code_hash:
    "operator-only, for pointing the factory at a new vault build. Run by hand with near-cli on the rare occasion it is needed; a product surface for it would be a surface for breaking every future vault",
  set_required_deposit: "operator-only, same reasoning as set_code_hash",
};

/**
 * Real gaps, acknowledged with the date they were found.
 *
 * SEPARATE FROM `NOT_A_FEATURE` ON PURPOSE. These ARE features a user should
 * be able to reach; they are listed so the check can stay green on what is
 * already known while failing loudly on anything NEW. Silently excluding them
 * would make this script agree that the product is complete, which is the
 * thing it was written to stop.
 *
 * An entry here is a commitment to build it or to decide it is not wanted --
 * not a parking space.
 */
const KNOWN_GAPS = {
  propose_owner:
    "2026-11-11: two-step ownership transfer, complete in the contract and unreachable. vault_config already REPORTS pending_owner, so the product can show a transfer in flight that it gives you no way to start",
  accept_ownership: "2026-11-11: the other half of the above",
  remove_node:
    "2026-11-11: vault_plan_add_node exists and nothing removes one, so a budget tree can only ever grow",
  sweep_stuck_pending:
    "2026-11-11: recovers payments stuck in-flight. Nothing reaches it, so a stuck reservation holds budget until someone runs near-cli by hand",
  set_max_daily_near:
    "2026-11-11: a NEAR-denominated cap alongside the per-token ones. Unreachable, and get_near_budget (its read side) with it",
  get_near_budget: "2026-11-11: the read side of set_max_daily_near",
};

// ---- the capability: every public method on the vault and the factory
const methodsOf = (file) => [
  ...new Set(
    [...read(file).matchAll(/^\s*pub fn ([a-z_][a-z0-9_]*)/gm)].map((m) => m[1]),
  ),
];
const vault = methodsOf("contracts/vault/src/lib.rs");
const factory = methodsOf("contracts/factory/src/lib.rs");

// ---- the reach: everything that could name a method
const surfaces = {
  mcp: read("packages/mcp/src/server.ts") + read("packages/mcp/src/payloads.ts"),
  cli: readdirSync("packages/create-float/bin")
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => read(join("packages/create-float/bin", f)))
    .join(LF),
  adapter: readdirSync("packages/float-adapter/src")
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => read(join("packages/float-adapter/src", f)))
    .join(LF),
  web: read("web/index.html"),
};

const reachedBy = (m) =>
  Object.entries(surfaces)
    .filter(([, src]) => new RegExp(`["'\`]${m}["'\`]`).test(src))
    .map(([name]) => name);

let orphans = 0;
for (const [label, list] of [
  ["vault", vault],
  ["factory", factory],
]) {
  const rows = list.map((m) => ({ m, by: reachedBy(m) })).sort((a, b) => a.m.localeCompare(b.m));
  const unreachable = rows.filter(
    (r) => r.by.length === 0 && !(r.m in NOT_A_FEATURE) && !(r.m in KNOWN_GAPS),
  );

  console.log(`${LF}${label}: ${list.length} public method(s)`);
  for (const r of rows) {
    if (r.m in NOT_A_FEATURE) continue;
    const tag = r.by.length ? "    " : r.m in KNOWN_GAPS ? "KNOWN" : "NEW  ";
    console.log(
      `  ${tag} ${r.m.padEnd(28)} ${r.by.join(", ") || (r.m in KNOWN_GAPS ? KNOWN_GAPS[r.m].slice(0, 58) : "nothing reaches this")}`,
    );
  }
  orphans += unreachable.length;
}

console.log(
  `${LF}  ${Object.keys(NOT_A_FEATURE).length} not-a-feature, ` +
    `${Object.keys(KNOWN_GAPS).length} KNOWN gaps awaiting an interface — both with reasons in this file.`,
);

if (orphans) {
  console.error(
    `${LF}BROKEN: ${orphans} contract method(s) that nothing can reach.${LF}${LF}` +
      `  Each is a shipped, tested, deployed capability a user cannot use. Either${LF}` +
      `  give it an interface, or add it to NOT_A_FEATURE with the reason it does${LF}` +
      `  not need one. "We will get to it" is how float-retire stayed missing${LF}` +
      `  until someone asked how to shut down an agent.`,
  );
  process.exit(1);
}
console.log(`${LF}surfaces: every contract capability is reachable`);

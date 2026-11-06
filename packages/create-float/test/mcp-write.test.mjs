import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeMcpConfigs, parseConfig } from "../bin/mcp-config.mjs";

/**
 * The config-writing loop, against REAL files.
 *
 * It lived inline in main(), after account creation — so the only way to
 * exercise it was to spend NEAR, which means it was never exercised. Both bugs
 * found on 2026-10-30 were in this path, and both were invisible to the unit
 * tests of the pure helpers because nothing proved the loop called them.
 *
 * The fixtures are the shapes actually found on the machine: one config with a
 * UTF-8 BOM whose `float` key belongs to @usefloat/mcp, and one clean config
 * with an unrelated server.
 */

const OURS = { command: "npx", args: ["-y", "@floatonnear/mcp"], env: { NEAR_VAULT_CONTRACT: "v.near" } };
const FOREIGN = {
  command: "npx",
  args: ["-y", "@usefloat/mcp@latest"],
  env: { FLOAT_OWNER_CONTROL_KEY: "secret", FLOAT_OWNER_WALLET: "w" },
};

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "float-cfg-"));
  const p = (n) => join(d, n);
  // BOM + a foreign float entry: the real Cursor file's shape.
  writeFileSync(p("bom.json"), "﻿" + JSON.stringify({ mcpServers: { float: FOREIGN } }, null, 2));
  writeFileSync(p("clean.json"), JSON.stringify({ mcpServers: { wren: { command: "x" } } }, null, 2));
  writeFileSync(p("broken.json"), "{ this is not json");
  return { d, p };
}

test("a BOM'd config is WRITTEN, not skipped as corrupt", () => {
  const { p } = scratch();
  const res = writeMcpConfigs({
    targets: [{ name: "Cursor", path: p("bom.json"), perProject: false }],
    entry: OURS,
  });
  assert.equal(res[0].skipped, undefined, `BOM'd file was skipped: ${res[0].skipped}`);
  const after = parseConfig(readFileSync(p("bom.json"), "utf8"));
  assert.ok(after.mcpServers["float-near"], "our entry was not written");
});

test("a foreign float entry survives byte for byte, secrets included", () => {
  const { p } = scratch();
  writeMcpConfigs({
    targets: [{ name: "Cursor", path: p("bom.json"), perProject: false }],
    entry: OURS,
  });
  const after = parseConfig(readFileSync(p("bom.json"), "utf8"));
  assert.deepEqual(after.mcpServers.float, FOREIGN, "the other product's entry was modified");
  assert.equal(after.mcpServers.float.env.FLOAT_OWNER_CONTROL_KEY, "secret");
});

test("the collision is REPORTED, not just handled quietly", () => {
  const { p } = scratch();
  const res = writeMcpConfigs({
    targets: [{ name: "Cursor", path: p("bom.json"), perProject: false }],
    entry: OURS,
  });
  assert.equal(res[0].entryKey, "float-near");
  assert.equal(res[0].collided, true, "a caller cannot warn about what it is not told");
});

test("an uncontested config gets the plain float key and keeps its other servers", () => {
  const { p } = scratch();
  const res = writeMcpConfigs({
    targets: [{ name: "Claude Desktop", path: p("clean.json"), perProject: false }],
    entry: OURS,
  });
  assert.equal(res[0].entryKey, "float");
  assert.equal(res[0].collided, false);
  const after = parseConfig(readFileSync(p("clean.json"), "utf8"));
  assert.deepEqual(after.mcpServers.wren, { command: "x" });
});

test("a backup is taken before any existing file is rewritten", () => {
  const { p } = scratch();
  writeMcpConfigs({
    targets: [{ name: "Cursor", path: p("bom.json"), perProject: false }],
    entry: OURS,
  });
  assert.ok(existsSync(p("bom.json.bak")), "no .bak was written");
});

test("genuinely malformed JSON is left ALONE — no write, no backup", () => {
  const { p } = scratch();
  const before = readFileSync(p("broken.json"), "utf8");
  const res = writeMcpConfigs({
    targets: [{ name: "Cursor", path: p("broken.json"), perProject: false }],
    entry: OURS,
  });
  assert.equal(res[0].skipped, "unparseable");
  assert.equal(readFileSync(p("broken.json"), "utf8"), before, "a file we could not read was rewritten");
  assert.equal(existsSync(p("broken.json.bak")), false);
});

test("an absent GLOBAL config is not invented; an absent project file is created", () => {
  const { p } = scratch();
  const res = writeMcpConfigs({
    targets: [
      { name: "Claude Desktop", path: p("nope.json"), perProject: false },
      { name: "Claude Code", path: p("sub/.mcp.json"), perProject: true },
    ],
    entry: OURS,
  });
  assert.equal(res[0].skipped, "absent");
  assert.equal(existsSync(p("nope.json")), false, "config was invented for software that is not installed");
  assert.equal(res[1].entryKey, "float");
  assert.ok(existsSync(p("sub/.mcp.json")), "project file was not created");
});

test("a repeat run is idempotent on a colliding config — no float-near-2", () => {
  const { p } = scratch();
  const t = [{ name: "Cursor", path: p("bom.json"), perProject: false }];
  writeMcpConfigs({ targets: t, entry: OURS });
  const second = writeMcpConfigs({ targets: t, entry: { ...OURS, env: { NEAR_VAULT_CONTRACT: "new.near" } } });
  assert.equal(second[0].entryKey, "float-near", "a second run moved to a new key");
  const after = parseConfig(readFileSync(p("bom.json"), "utf8"));
  assert.deepEqual(Object.keys(after.mcpServers).sort(), ["float", "float-near"]);
  assert.equal(after.mcpServers["float-near"].env.NEAR_VAULT_CONTRACT, "new.near");
});

// ---- wiring (tdd-extras Rule 5, with its limitation stated)
//
// Every test above constructs writeMcpConfigs itself, so none can see whether
// the wizard CALLS it. Replacing the call with `[]` survived the whole suite.
//
// True reachability would mean driving main() to step 9, which happens only
// after accounts have been created and NEAR spent — so it cannot be asserted
// from a test suite. This is a STRUCTURAL proxy: weaker than running the code,
// strictly better than nothing, and it catches the exact mutation that
// survived. Its weakness is brittleness to reformatting, not false confidence.

test("WIRING: the wizard imports and calls writeMcpConfigs", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "bin", "create-float.mjs"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.match(code, /import \{[^}]*writeMcpConfigs[^}]*\} from "\.\/mcp-config\.mjs"/);
  assert.match(code, /writeMcpConfigs\(\{\s*targets/, "the wizard does not call writeMcpConfigs");
});

test("WIRING: the wizard no longer parses client config itself", () => {
  // The bug was JSON.parse on a path read from disk. If that reappears here,
  // the BOM fix has been bypassed regardless of what mcp-config.mjs does.
  const src = readFileSync(join(import.meta.dirname, "..", "bin", "create-float.mjs"), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  assert.doesNotMatch(
    code,
    /JSON\.parse\(readFileSync\(t\.path/,
    "the wizard is parsing a client config directly again, bypassing parseConfig",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpTargets, mergeMcpEntry } from "../bin/mcp-config.mjs";

/**
 * Which MCP clients get configured, and how the entry is merged.
 *
 * THE WIZARD ALREADY DID THIS — for Claude Desktop, at one hardcoded path per
 * platform, merging a single `float` key and keeping a `.bak`. That part was
 * right and is kept. Two things were not:
 *
 *   1. It only ever knew about Claude Desktop. A user driving Claude Code or
 *      Cursor got a config written somewhere they would never read.
 *   2. `mkdirSync(dirname(cfgPath), { recursive: true })` ran unconditionally,
 *      so it CREATED `%APPDATA%\\Claude\\` on machines with no Claude Desktop
 *      installed — littering a directory for an app the user does not have.
 *
 * So detection is the feature, and the rule that makes a wrong guess harmless:
 * never create a directory for a client that is not there. A per-project file
 * (`.mcp.json`) is the one exception, because creating it IS the install.
 */

const env = {
  home: "/home/u",
  appData: "/home/u/AppData/Roaming",
  cwd: "/proj",
};

/** `exists` is injected so these tests never touch a real filesystem. */
const withPaths = (...present) => (p) => present.includes(p);

test("a client whose directory is absent is NOT targeted", () => {
  // The bug: the old code wrote (and mkdir -p'd) regardless.
  const t = mcpTargets({ ...env, platform: "linux", exists: withPaths() });
  const global = t.filter((x) => !x.perProject);
  assert.deepEqual(global, [], "nothing global should be targeted on a bare machine");
});

test("Claude Desktop is targeted when its directory exists", () => {
  const dir = "/home/u/.config/Claude";
  const t = mcpTargets({ ...env, platform: "linux", exists: withPaths(dir) });
  const cd = t.find((x) => x.name === "Claude Desktop");
  assert.ok(cd, "should be detected");
  assert.equal(cd.path, `${dir}/claude_desktop_config.json`);
});

test("the Windows path uses APPDATA, not the home directory", () => {
  const dir = "/home/u/AppData/Roaming/Claude";
  const t = mcpTargets({ ...env, platform: "win32", exists: withPaths(dir) });
  assert.equal(
    t.find((x) => x.name === "Claude Desktop")?.path,
    `${dir}/claude_desktop_config.json`,
  );
});

test("macOS uses Application Support", () => {
  const dir = "/home/u/Library/Application Support/Claude";
  const t = mcpTargets({ ...env, platform: "darwin", exists: withPaths(dir) });
  assert.equal(
    t.find((x) => x.name === "Claude Desktop")?.path,
    `${dir}/claude_desktop_config.json`,
  );
});

test("Cursor is targeted when ~/.cursor exists", () => {
  const t = mcpTargets({ ...env, platform: "linux", exists: withPaths("/home/u/.cursor") });
  assert.equal(t.find((x) => x.name === "Cursor")?.path, "/home/u/.cursor/mcp.json");
});

test("Claude Code gets a PROJECT .mcp.json, which is created even when absent", () => {
  // The exception to the no-create rule: a per-project file IS the install.
  // Writing it is how the project gains the server, so an absent file is not
  // evidence the client is missing.
  const t = mcpTargets({ ...env, platform: "linux", exists: withPaths() });
  const cc = t.find((x) => x.name === "Claude Code");
  assert.ok(cc, "should always be offered");
  assert.equal(cc.path, "/proj/.mcp.json");
  assert.equal(cc.perProject, true);
});

test("every detected client is returned, not just the first", () => {
  const t = mcpTargets({
    ...env,
    platform: "linux",
    exists: withPaths("/home/u/.config/Claude", "/home/u/.cursor"),
  });
  assert.deepEqual(
    t.map((x) => x.name).sort(),
    ["Claude Code", "Claude Desktop", "Cursor"],
  );
});

// ---- merging

const entry = {
  command: "npx",
  args: ["-y", "@floatonnear/mcp"],
  env: { NEAR_VAULT_CONTRACT: "v.me.near" },
};

test("merging preserves every other server", () => {
  const before = { mcpServers: { other: { command: "x" } } };
  const after = mergeMcpEntry(before, entry);
  assert.deepEqual(after.mcpServers.other, { command: "x" });
  assert.equal(after.mcpServers.float.command, "npx");
});

test("merging preserves unrelated TOP-LEVEL keys", () => {
  // Claude Desktop's config holds more than mcpServers. Dropping a sibling key
  // would silently reconfigure the user's client.
  const before = { globalShortcut: "Cmd+Space", mcpServers: {} };
  const after = mergeMcpEntry(before, entry);
  assert.equal(after.globalShortcut, "Cmd+Space");
});

test("re-running REPLACES the float entry rather than nesting or duplicating it", () => {
  const once = mergeMcpEntry({}, entry);
  const twice = mergeMcpEntry(once, { ...entry, env: { NEAR_VAULT_CONTRACT: "w.me.near" } });
  assert.equal(twice.mcpServers.float.env.NEAR_VAULT_CONTRACT, "w.me.near");
  assert.equal(Object.keys(twice.mcpServers).length, 1);
});

test("an empty or missing config is handled without throwing", () => {
  assert.equal(mergeMcpEntry({}, entry).mcpServers.float.command, "npx");
  assert.equal(mergeMcpEntry(undefined, entry).mcpServers.float.command, "npx");
});

test("a config using the `servers` key is merged under THAT key", () => {
  // VS Code-style configs name the map `servers`. Writing `mcpServers` into one
  // of those adds a key the client ignores, which looks like success and does
  // nothing.
  const before = { servers: { other: { command: "x" } } };
  const after = mergeMcpEntry(before, entry);
  assert.ok(after.servers.float, "must use the key the file already uses");
  assert.equal(after.mcpServers, undefined, "must not invent a second map");
  assert.deepEqual(after.servers.other, { command: "x" });
});

test("the caller's path joiner is used, so separators match the platform", () => {
  // Found by printing the real targets on Windows:
  //   C:\Users\BASHIR\AppData\Roaming/Claude/claude_desktop_config.json
  // Node tolerates mixed separators so it WORKS, which is why no assertion
  // caught it — but it reads as a broken path to the person being asked to
  // trust an installer with their config file. The joiner is injected so
  // production can pass node:path.join while these tests stay POSIX.
  const SEP = "\\";
  const t = mcpTargets({
    home: ["C:", "Users", "u"].join(SEP),
    appData: ["C:", "Users", "u", "AppData", "Roaming"].join(SEP),
    platform: "win32",
    cwd: ["C:", "proj"].join(SEP),
    exists: () => true,
    join: (...p) => p.join(SEP),
  });
  const cd = t.find((x) => x.name === "Claude Desktop");
  assert.equal(
    cd.path,
    ["C:", "Users", "u", "AppData", "Roaming", "Claude", "claude_desktop_config.json"].join(SEP),
  );
  assert.doesNotMatch(cd.path, /\//, "no forward slashes when the joiner uses backslashes");
});

// ---------------------------------------------------------------------------
// Two failures found by inspecting a real machine on 2026-10-30, not by
// reasoning about the code.
//
// 1. A UTF-8 BOM made the wizard skip a perfectly valid config. Cursor's
//    ~/.cursor/mcp.json began with U+FEFF, JSON.parse threw, and the wizard
//    warned "is not valid JSON -- leaving it untouched" and moved on. The file
//    IS valid JSON. On Windows this is routine: PowerShell's Out-File and
//    Set-Content write a BOM by default.
//
// 2. `float` was already taken -- by `npx -y @usefloat/mcp@latest`, the
//    Solana Float product, carrying FLOAT_OWNER_CONTROL_KEY in its env.
//    mergeMcpEntry wrote cfg[key].float unconditionally, so the wizard would
//    have replaced a working server holding someone's owner key, while
//    printing "(only the 'float' entry was changed)".
//
// On that machine the BOM accidentally prevented the overwrite. Remove the BOM
// and the clobber happens -- so these are one bug wearing two hats, and both
// get fixed.

import { parseConfig, entryKeyFor, isOurs } from "../bin/mcp-config.mjs";

const OURS = { command: "npx", args: ["-y", "@floatonnear/mcp"], env: { NEAR_VAULT_CONTRACT: "v.near" } };
const FOREIGN = {
  command: "npx",
  args: ["-y", "@usefloat/mcp@latest"],
  env: { FLOAT_OWNER_CONTROL_KEY: "secret", FLOAT_OWNER_WALLET: "w" },
};

test("parseConfig strips a UTF-8 BOM, which is what PowerShell writes", () => {
  const withBom = "﻿" + JSON.stringify({ mcpServers: { float: FOREIGN } });
  assert.deepEqual(parseConfig(withBom).mcpServers.float.command, "npx");
});

test("parseConfig still throws on genuinely malformed JSON", () => {
  // The warning path must stay reachable; a BOM fix that swallows real
  // corruption would overwrite a file it could not read.
  assert.throws(() => parseConfig("{ not json"));
  assert.throws(() => parseConfig("﻿{ not json"));
});

test("isOurs recognises our entry under the CURRENT scope", () => {
  assert.equal(isOurs(OURS), true);
});

test("isOurs recognises our entry under the OLD scope, so upgraders are not duplicated", () => {
  // Anyone who ran the wizard before the @floatonnear rename has this. Treating
  // it as foreign would leave them with two servers, one of them a 404.
  assert.equal(isOurs({ command: "npx", args: ["-y", "@near-vault/mcp"] }), true);
});

test("isOurs rejects a different product that merely shares the key", () => {
  assert.equal(isOurs(FOREIGN), false);
  assert.equal(isOurs(undefined), false);
  assert.equal(isOurs({ command: "node", args: ["server.js"] }), false);
});

test("an unoccupied float key is used as-is", () => {
  assert.equal(entryKeyFor({}), "float");
  assert.equal(entryKeyFor({ other: { command: "x" } }), "float");
});

test("our OWN entry is updated in place — a repeat run must not accumulate keys", () => {
  assert.equal(entryKeyFor({ float: OURS }), "float");
  assert.equal(entryKeyFor({ float: { command: "npx", args: ["-y", "@near-vault/mcp"] } }), "float");
});

test("a FOREIGN float entry is stepped around, not overwritten", () => {
  assert.equal(entryKeyFor({ float: FOREIGN }), "float-near");
});

test("and if float-near is also taken by something else, it keeps going", () => {
  assert.equal(entryKeyFor({ float: FOREIGN, "float-near": FOREIGN }), "float-near-2");
  assert.equal(
    entryKeyFor({ float: FOREIGN, "float-near": FOREIGN, "float-near-2": FOREIGN }),
    "float-near-3",
  );
});

test("mergeMcpEntry leaves a foreign entry and its secrets completely untouched", () => {
  // The whole point. FLOAT_OWNER_CONTROL_KEY must survive.
  const before = { mcpServers: { float: FOREIGN } };
  const after = mergeMcpEntry(before, OURS);
  assert.deepEqual(after.mcpServers.float, FOREIGN, "the other product's entry was modified");
  assert.equal(after.mcpServers.float.env.FLOAT_OWNER_CONTROL_KEY, "secret");
  assert.equal(after.mcpServers["float-near"].args.join(" "), "-y @floatonnear/mcp");
});

test("mergeMcpEntry still updates OUR entry in place when the key is ours", () => {
  const before = { mcpServers: { float: OURS } };
  const after = mergeMcpEntry(before, { ...OURS, env: { NEAR_VAULT_CONTRACT: "new.near" } });
  assert.equal(Object.keys(after.mcpServers).length, 1, "a repeat run added a second entry");
  assert.equal(after.mcpServers.float.env.NEAR_VAULT_CONTRACT, "new.near");
});

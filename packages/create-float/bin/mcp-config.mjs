import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Which MCP clients to configure, and how to merge the entry.
 *
 * The wizard already wrote a merged `float` entry with a `.bak` — that part was
 * right and is unchanged. Two things were not:
 *
 *   1. It knew only about Claude Desktop, at one hardcoded path per platform.
 *      A user driving Claude Code or Cursor got a file written somewhere they
 *      would never read, and were told it had worked.
 *   2. `mkdirSync(dirname(cfgPath), { recursive: true })` ran unconditionally,
 *      so it CREATED `%APPDATA%\Claude\` on machines with no Claude Desktop.
 *      Littering a directory for an app the user does not have is the kind of
 *      thing that gets an installer distrusted.
 *
 * THE RULE THAT MAKES A WRONG GUESS HARMLESS: never create a directory for a
 * client that is not there. Detection is "does the client's own directory
 * already exist" — cheap, and wrong only in the safe direction (a client we
 * fail to detect is simply not configured, and the wizard says so).
 *
 * The single exception is a per-project file. `.mcp.json` living in the project
 * root IS how a project gains a server, so its absence is not evidence the
 * client is missing — creating it is the point.
 *
 * Paths are limited to ones that are stable and well-known. A guessed path for
 * a client we are unsure about would either do nothing or litter, and the
 * no-create rule makes the first outcome silent. Better to configure three
 * clients correctly and name the rest than to spray files.
 */

/**
 * Default joiner: POSIX, so the tests read the same on every platform.
 *
 * Production passes node:path.join instead. Without that, Windows produced
 * `C:\Users\u\AppData\Roaming/Claude/claude_desktop_config.json` — half
 * backslashes from the environment, half forward slashes from here. Node
 * tolerates it so it WORKED, which is exactly why no assertion caught it; it
 * was found by printing the real targets and reading them. A path that looks
 * malformed is a bad thing to show someone while asking to edit their config.
 */
const posixJoin = (...parts) => parts.join("/").replace(/\/+/g, "/");

/**
 * Every MCP client worth writing to on this machine.
 *
 * `exists` is injected rather than imported so this is testable without
 * touching a real filesystem — and so the detection rule itself is the thing
 * under test, not node:fs.
 */
export function mcpTargets({ home, appData, platform, cwd, exists, join = posixJoin }) {
  const j = join;
  const out = [];

  // Claude Desktop. The directory is created by the app on first run, so its
  // presence is a reliable signal — and its absence is why the old code was
  // creating folders for software that was never installed.
  const desktopDir =
    platform === "win32"
      ? j(appData ?? home, "Claude")
      : platform === "darwin"
        ? j(home, "Library", "Application Support", "Claude")
        : j(home, ".config", "Claude");
  if (exists(desktopDir)) {
    out.push({
      name: "Claude Desktop",
      path: j(desktopDir, "claude_desktop_config.json"),
      perProject: false,
    });
  }

  // Cursor keeps a global server list in ~/.cursor/mcp.json.
  const cursorDir = j(home, ".cursor");
  if (exists(cursorDir)) {
    out.push({ name: "Cursor", path: j(cursorDir, "mcp.json"), perProject: false });
  }

  // Claude Code reads .mcp.json from the project root. Always offered: writing
  // it is how the project gains the server, so there is nothing to detect.
  out.push({ name: "Claude Code", path: j(cwd, ".mcp.json"), perProject: true });

  return out;
}

/**
 * Merge one server entry into an existing config, touching nothing else.
 *
 * KEY NAME IS TAKEN FROM THE FILE. Most clients use `mcpServers`; VS Code-style
 * configs use `servers`. Writing `mcpServers` into a file that uses `servers`
 * adds a key the client ignores — which reads as success and does nothing at
 * all. So an existing `servers` map wins, and only a file with neither gets the
 * `mcpServers` default.
 */
export function mergeMcpEntry(existing, entry) {
  const cfg = { ...(existing ?? {}) };
  const key = cfg.servers && !cfg.mcpServers ? "servers" : "mcpServers";
  cfg[key] = { ...(cfg[key] ?? {}) };
  cfg[key][entryKeyFor(cfg[key])] = { ...entry };
  return cfg;
}

/**
 * Parse a client config, tolerating a byte-order mark.
 *
 * `JSON.parse` throws on a leading U+FEFF and the wizard read that as
 * corruption: it warned "is not valid JSON — leaving it untouched" and skipped
 * the file. Measured 2026-10-30 on a real machine, `~/.cursor/mcp.json` began
 * with a BOM and was silently passed over, so the user got no server entry and
 * a message that misdescribed why.
 *
 * Routine on Windows rather than exotic: PowerShell's `Out-File` and
 * `Set-Content` write UTF-8 with a BOM by default, so any config anyone has
 * edited from a PowerShell one-liner carries one.
 *
 * Still throws on genuinely malformed JSON — the warning path must stay
 * reachable, because a parser that guessed at broken input would overwrite a
 * file it could not actually read.
 */
export function parseConfig(raw) {
  return JSON.parse(raw.replace(/^﻿/, ""));
}

/**
 * Is this existing entry OURS, or a different product sharing the name?
 *
 * `float` is not a name we get to assume. Measured 2026-10-30: the key was
 * already taken by `npx -y @usefloat/mcp@latest` — the Solana Float product —
 * holding FLOAT_OWNER_CONTROL_KEY and FLOAT_OWNER_WALLET in its env. The person
 * most likely to hit that is one of this product's OWN users.
 *
 * The old `@near-vault/mcp` scope counts as ours: anyone who ran the wizard
 * before the rename has it, and calling it foreign would leave them with two
 * entries, one pointing at a package that no longer exists.
 */
export function isOurs(server) {
  const args = (server?.args ?? []).join(" ");
  return /@floatonnear\/mcp|@near-vault\/mcp/.test(args);
}

/**
 * Which key this entry may safely occupy.
 *
 * Ours, or absent, means write in place — that keeps a repeat run idempotent
 * instead of accumulating `float-2`, `float-3`. Anything else means step aside:
 * replacing a stranger's entry destroys a working server and the credentials in
 * its env, and the old success line — "(only the 'float' entry was changed)" —
 * was literally true while missing that the entry was not ours to change.
 *
 * This matters more unattended than interactively. On a VPS nobody reads the
 * warning or notices the `.bak`.
 */
export function entryKeyFor(servers, preferred = "float") {
  const taken = (k) => servers?.[k] && !isOurs(servers[k]);
  if (!taken(preferred)) return preferred;
  if (!taken(`${preferred}-near`)) return `${preferred}-near`;
  for (let n = 2; ; n++) {
    if (!taken(`${preferred}-near-${n}`)) return `${preferred}-near-${n}`;
  }
}

/**
 * Write the entry into every target config, and report what happened.
 *
 * Extracted from main() because it was unreachable by any test: it ran after
 * account creation, so exercising it meant spending NEAR, which meant nobody
 * ever did. Both bugs found on 2026-10-30 lived in this loop, and both were
 * invisible to the unit tests of the helpers above — a correct helper proves
 * nothing about a caller that does not use it.
 *
 * Returns one result per target rather than printing, so the caller owns the
 * output and the behaviour can be asserted. `collided` is part of that: a
 * caller cannot warn about something it was never told.
 */
export function writeMcpConfigs({ targets, entry }) {
  return targets.map((t) => {
    let cfg = {};
    if (existsSync(t.path)) {
      try {
        cfg = parseConfig(readFileSync(t.path, "utf8"));
      } catch {
        // Unreadable is NOT the same as empty. Rewriting here would replace a
        // file whose contents we could not understand.
        return { target: t, skipped: "unparseable" };
      }
      copyFileSync(t.path, `${t.path}.bak`);
    } else if (!t.perProject) {
      // Only a per-project file may be created from nothing. Anything else
      // would be inventing config for software that is not installed.
      return { target: t, skipped: "absent" };
    }

    const servers = cfg.servers && !cfg.mcpServers ? cfg.servers : cfg.mcpServers;
    const entryKey = entryKeyFor(servers ?? {});
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, JSON.stringify(mergeMcpEntry(cfg, entry), null, 2) + "\n");
    return { target: t, entryKey, collided: entryKey !== "float" };
  });
}

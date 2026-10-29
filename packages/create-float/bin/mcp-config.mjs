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
  cfg[key].float = { ...entry };
  return cfg;
}

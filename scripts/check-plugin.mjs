#!/usr/bin/env node
/**
 * Is the Claude Code plugin actually installable, and does its skill describe
 * tools that exist?
 *
 * WHY A PLUGIN AT ALL. Installing the MCP server by hand is
 * `claude mcp add float-near -- npx -y @floatonnear/mcp`, which a user has to
 * copy correctly. A plugin declares the server in its manifest, so installing
 * the plugin starts it — nothing to paste.
 *
 * It also fixes something that had quietly never worked: `SKILL.md` sat at the
 * repo root with valid frontmatter (`name: float`) and shipped inside the
 * create-float tarball, but Claude Code reads skills from
 * `.claude/skills/<name>/SKILL.md` or from inside a plugin — never from an npm
 * package root. So a 16.5 KB skill was shipped to every user and loadable by
 * nobody. A plugin is the one format that carries the server and the skill
 * together.
 *
 * THE CHECK THAT EARNS ITS KEEP IS THE THIRD ONE. A manifest that parses and a
 * skill that is present are cheap to verify and rarely wrong. What drifts is
 * the skill naming tools the server no longer exposes — exactly what happened
 * to the published MCP today, which advertised `vault_plan_create_agent` for a
 * contract method that had been removed. So this reads the tool names out of
 * the BUILT server and fails if the skill promises something it cannot do.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST = resolve(ROOT, "plugin", ".claude-plugin", "plugin.json");
const SKILL = resolve(ROOT, "plugin", "skills", "float", "SKILL.md");
const ROOT_SKILL = resolve(ROOT, "SKILL.md");
const SERVER = resolve(ROOT, "packages", "mcp", "dist", "server.js");

const fail = (...lines) => {
  console.error(`BROKEN: ${lines.join("\n  ")}`);
  process.exit(1);
};

// ---- 1. the manifest -------------------------------------------------------
if (!existsSync(MANIFEST)) fail(`no plugin manifest at ${MANIFEST}`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (e) {
  fail(`plugin.json does not parse: ${e.message}`);
}
for (const field of ["name", "description", "version"]) {
  if (!manifest[field]) fail(`plugin.json has no "${field}"`);
}

/**
 * The whole point of the plugin: it must DECLARE the server. Without this the
 * plugin installs a skill that describes tools nobody has, which is worse than
 * no plugin — the skill would tell Claude to call tools that are not there.
 */
const servers = manifest.mcpServers ?? {};
const names = Object.keys(servers);
if (names.length !== 1) {
  fail(`expected exactly one mcpServers entry, found ${names.length}: ${names.join(", ")}`);
}
const server = servers[names[0]];
if (server.command !== "npx") fail(`mcpServers.${names[0]}.command is "${server.command}", expected npx`);
if (!Array.isArray(server.args) || !server.args.includes("@floatonnear/mcp")) {
  fail(`mcpServers.${names[0]}.args does not install @floatonnear/mcp: ${JSON.stringify(server.args)}`);
}
// `-y` or npx prompts, and a prompt inside a plugin launch is a hang with no
// visible cause.
if (!server.args.includes("-y")) {
  fail(`mcpServers.${names[0]}.args is missing "-y"; npx will prompt and the server will never start`);
}

// ---- 2. the skill ----------------------------------------------------------
if (!existsSync(SKILL)) fail(`no skill at ${SKILL}`);
const skill = readFileSync(SKILL, "utf8");
const rootSkill = existsSync(ROOT_SKILL) ? readFileSync(ROOT_SKILL, "utf8") : null;
if (rootSkill !== null && skill !== rootSkill) {
  fail(
    `plugin/skills/float/SKILL.md has drifted from the root SKILL.md.`,
    `They are the same document shipped two ways; copy the root one over:`,
    `  cp SKILL.md plugin/skills/float/SKILL.md`,
  );
}

/**
 * THE THIRD COPY, which was live and wrong.
 *
 * Next.js serves `public/` with no route, so `apps/dashboard/public/skill.md`
 * is published at `app.usefloat.xyz/skill.md` without anything importing it.
 * Measured 2026-11-10: the apex served the current skill (24,130 B) while
 * `app.` served an October one (18,881 B) — two different documents at the
 * same path on two hosts, and nothing in the repo compared them. Anyone
 * installing from the `app.` URL got a skill months out of date.
 *
 * Checked here rather than in its own script because it is the same invariant
 * the plugin copy has: one document, shipped several ways, every way the same
 * bytes.
 */
const DASH_SKILL = resolve(ROOT, "apps", "dashboard", "public", "skill.md");
if (rootSkill !== null && existsSync(DASH_SKILL)) {
  if (readFileSync(DASH_SKILL, "utf8") !== rootSkill) {
    fail(
      `apps/dashboard/public/skill.md has drifted from the root SKILL.md.`,
      `Next.js serves public/ with no route, so this IS app.usefloat.xyz/skill.md:`,
      `  cp SKILL.md apps/dashboard/public/skill.md`,
    );
  }
}
if (!/^---\r?\n/.test(skill)) fail("the skill has no frontmatter block, so Claude Code will not load it");
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1] ?? "";
if (!/^description:/m.test(fm)) {
  fail("the skill's frontmatter has no `description`, which is what Claude matches on to invoke it");
}

// ---- 3. does the skill promise tools the server actually has? --------------
if (!existsSync(SERVER)) {
  console.error(`BROKEN: ${SERVER} is not built; cannot check the skill against real tools.`);
  console.error(`  npm run build --workspace @floatonnear/mcp`);
  process.exit(1);
}

const tools = await new Promise((done) => {
  const p = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, NEAR_VAULT_CONTRACT: "", NEAR_VAULT_AGENT_KEY: "" },
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  const send = (o) => p.stdin.write(`${JSON.stringify(o)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "1" } },
  });
  setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 1200);
  setTimeout(() => {
    p.kill();
    for (const line of out.split("\n").filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (j.id === 2 && j.result?.tools) return done(j.result.tools.map((t) => t.name));
      } catch {
        /* not a json line */
      }
    }
    done(null);
  }, 6000);
});

if (!tools) fail("the built MCP server did not answer tools/list, so the skill cannot be checked against it");

/**
 * Only whole tool names. The skill writes `vault_plan_*` as a family when
 * talking about the group, and matching that against a real tool would fail
 * forever on a sentence that is correct.
 */
const named = [...new Set([...skill.matchAll(/\bvault_[a-z_]+\b/g)].map((m) => m[0]))]
  .filter((n) => !n.endsWith("_"))
  .sort();
const missing = named.filter((n) => !tools.includes(n));
if (missing.length) {
  fail(
    `the skill names ${missing.length} tool(s) the server does not expose: ${missing.join(", ")}`,
    ``,
    `A skill that promises a tool nobody has sends Claude to call something`,
    `that is not there. The published MCP did exactly this today, advertising`,
    `vault_plan_create_agent for a contract method that had been removed.`,
  );
}

console.log(
  `plugin: manifest declares ${names[0]} via npx, skill matches the root, ` +
    `and all ${named.length} tool(s) it names exist among the server's ${tools.length}`,
);

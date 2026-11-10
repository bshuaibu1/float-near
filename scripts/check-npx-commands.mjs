#!/usr/bin/env node
/**
 * Does every `npx` command we tell people to run resolve to something we ship?
 *
 * WHY. On 2026-11-10 three documented commands did not exist:
 *
 *   npx @floatonnear/float-exit    404 — it is a BIN of @floatonnear/create-float
 *   npx @floatonnear/float-topup   404 — same, and not even in the published bins
 *   npx @floatonnear/float-agent   404 — same shape, undocumented but latent
 *
 * `float-exit` is the one that matters. `SKILL.md` sells the ~3.09 NEAR deposit
 * as refundable stake — "your deposit comes back, your gas is spent" — and
 * `float-exit` is the ONLY documented way to get it back. The refund path
 * dead-ended at an npx 404, in the skill text and in the MCP server
 * instructions sent to every connected client.
 *
 * A bin is not a package. `npx <pkg>` runs a bin only when the bin shares the
 * package's name; otherwise it is `npx -p <pkg> <bin>`. Nothing in the repo
 * knew the difference, because the string was prose in a markdown file and a
 * template literal in a tool response — neither of which any test reads.
 *
 * So: parse the commands out of the docs and the server, resolve each against
 * the workspace's own `package.json` bin maps, and fail on anything that
 * cannot run. Purely local — no network, no registry — so it belongs in the
 * gate. Whether the resolved package has been PUBLISHED at the right version
 * is a separate question this cannot answer; see `check-create-page.mjs` for
 * the shape that asks live questions.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Every bin this workspace ships, bin name -> package name.
const bins = new Map();
const pkgNames = new Set();
for (const dir of readdirSync("packages")) {
  const p = join("packages", dir, "package.json");
  if (!existsSync(p)) continue;
  const d = JSON.parse(readFileSync(p, "utf8"));
  pkgNames.add(d.name);
  for (const b of Object.keys(d.bin ?? {})) bins.set(b, d.name);
}

const FILES = ["SKILL.md", "README.md", "packages/mcp/src/server.ts"].filter(existsSync);

let bad = 0;
for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    // `npx [-y] [-p pkg] <target> ...`. Only our own scope is checked — a
    // third-party npx is not ours to validate.
    for (const m of line.matchAll(/npx\s+(?:-y\s+)?(?:-p\s+(@?[\w\/.-]+)\s+)?(@floatonnear\/[a-z0-9-]+|float-[a-z0-9-]+)/g)) {
      const [, viaP, target] = m;

      if (viaP) {
        // `npx -p <pkg> <bin>` — the package must be ours and declare the bin.
        if (pkgNames.has(viaP) && bins.get(target) !== viaP) {
          console.error(`BROKEN: ${file}:${i + 1}`);
          console.error(`    npx -p ${viaP} ${target}`);
          console.error(`  ${viaP} does not declare a '${target}' bin.`);
          bad++;
        }
        continue;
      }

      // Bare `npx <target>`: resolves ONLY if a package of that exact name
      // exists. A bin of a differently-named package is a 404.
      const bare = target.replace(/^@floatonnear\//, "");
      if (pkgNames.has(target)) continue;
      if (bins.has(bare)) {
        console.error(`BROKEN: ${file}:${i + 1}`);
        console.error(`    npx ${target}`);
        console.error(
          `  '${bare}' is a BIN of ${bins.get(bare)}, not a package — this 404s.\n` +
            `  Use: npx -p ${bins.get(bare)} ${bare}`,
        );
        bad++;
      } else {
        console.error(`BROKEN: ${file}:${i + 1}`);
        console.error(`    npx ${target}`);
        console.error(`  Neither a workspace package nor a bin any package declares.`);
        bad++;
      }
    }
  });
}

if (bad) {
  console.error(
    `\n  ${bad} unrunnable command(s). One of these is the documented refund path\n` +
      `  for a ~3 NEAR deposit, so a 404 here reads to the user as "my money is gone".`,
  );
  process.exit(1);
}
console.log(`npx commands: all resolve to a shipped bin (${bins.size} bins across ${pkgNames.size} packages)`);

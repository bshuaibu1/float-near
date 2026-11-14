#!/usr/bin/env node
/**
 * Do the create PAGE and the MCP agree on which factory creates a vault?
 *
 * WHY THIS EXISTS. The page read `?factory=` with no fallback, so the BARE
 * URL — <https://usefloat.xyz>, the link in the README, on npm, and in
 * anything anyone shares — answered:
 *
 *     This link has no factory, so there is nothing to create the vault.
 *
 * The first thing a new user or a judge saw was a refusal. The MCP had known
 * the right answer the whole time, in `FACTORY_BY_NETWORK`; the page simply
 * did not have access to the same constant, because one is TypeScript in a
 * published package and the other is a `<script type="module">` served as a
 * static file. Nothing could import across that boundary, so the value was
 * duplicated — and a duplicated constant is a constant that drifts.
 *
 * It had already drifted once in the worst direction: the page refused while
 * a perfectly good mainnet factory was deployed and live.
 *
 * So this compares the two lists directly. It is a string comparison across a
 * boundary no import can cross, which is exactly the shape that needs a test
 * rather than a convention.
 *
 *   node scripts/check-create-factory-default.mjs
 */
import { readFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const problems = [];

const page = readFileSync("web/index.html", "utf8");
const mcp = readFileSync("packages/mcp/src/create.ts", "utf8");

/**
 * The MCP's canonical map. Parsed from the source rather than imported,
 * because importing would need a build step and this check has to run on a
 * bare tree.
 */
const canonical = {};
const block = mcp.match(/FACTORY_BY_NETWORK[^=]*=\s*\{([\s\S]*?)\}/);
if (!block) {
  problems.push("could not find FACTORY_BY_NETWORK in packages/mcp/src/create.ts");
} else {
  for (const m of block[1].matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) canonical[m[1]] = m[2];
}

/** The page's fallback, which is what a bare URL lands on. */
const pageDefault = page.match(
  /const DEFAULT_FACTORY\s*=\s*NETWORK === "mainnet"\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/,
);
if (!pageDefault) {
  problems.push(
    `web/index.html has no DEFAULT_FACTORY fallback.${LF}` +
      `      Without one the BARE URL refuses to create anything — which is the link` +
      `${LF}      in the README and on npm.`,
  );
}

if (block && pageDefault) {
  const pageMap = { mainnet: pageDefault[1], testnet: pageDefault[2] };
  for (const net of ["mainnet", "testnet"]) {
    if (!canonical[net]) {
      // A network the MCP deliberately has no factory for must not be given
      // one by the page. That asymmetry is how a real deposit reaches an
      // unverified account.
      problems.push(
        `the page defaults ${net} to "${pageMap[net]}" but FACTORY_BY_NETWORK has no ${net} ` +
          `entry. The page must not invent a factory the MCP refuses to name.`,
      );
    } else if (canonical[net] !== pageMap[net]) {
      problems.push(
        `${net}: page says "${pageMap[net]}", FACTORY_BY_NETWORK says "${canonical[net]}".`,
      );
    }
  }
}

/**
 * AN EXPLICIT PARAM MUST STILL WIN. If the default were applied
 * unconditionally, a testnet or private-factory link would silently create on
 * the wrong network — a worse failure than the one being fixed, because it
 * succeeds.
 */
if (!/q\.get\("factory"\)\s*\?\?\s*DEFAULT_FACTORY/.test(page)) {
  problems.push(
    `the page does not prefer an explicit ?factory= over the default.${LF}` +
      `      An unconditional default would send a private or testnet link to the` +
      `${LF}      wrong factory, and it would SUCCEED, which is worse than refusing.`,
  );
}

if (problems.length) {
  console.error(`BROKEN: the create page and the MCP disagree about the factory.${LF}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `create factory: page and MCP agree (mainnet ${canonical.mainnet}, ` +
    `testnet ${canonical.testnet}), and an explicit ?factory= still wins`,
);

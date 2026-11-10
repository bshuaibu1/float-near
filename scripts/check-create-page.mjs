#!/usr/bin/env node
/**
 * Does the URL we hand users actually create a vault?
 *
 * WHY THIS EXISTS. On 2026-11-10 three separate things were wrong at once, and
 * every existing check was green through all of them:
 *
 *   1. `vault_create` returned `https://app.usefloat.xyz`, which serves the
 *      DASHBOARD. The create page is at `https://usefloat.xyz`. Every user
 *      following the MCP's own URL landed somewhere with no create flow.
 *   2. The `vault.wasm` served beside the page was 298,920 B — the build from
 *      BEFORE the `#[payable]` fix. Vaults created from it get a
 *      `bind_virtual_agent` that cannot be called at all.
 *   3. The factory's OTHER method, `create_vault`, references a global
 *      contract that was never published. Unused, but one `set_code_hash`
 *      away from being the live path.
 *
 * None of that is visible to a unit test, because none of it is in the repo:
 * it is the relationship between a constant here, a file on a web server, and
 * an account on chain. The deploy's config assertions could not see it either
 * — they described the bytes we uploaded, and the break was in what we
 * uploaded them NEXT TO.
 *
 * So this check ATTEMPTS THE PRODUCT ACTION's preconditions, over the network,
 * against the real default URL. It is deliberately not in `verify-all`: it
 * needs the internet and it fails for reasons a working tree cannot fix. Run
 * it after any deploy that touches the page, the wasm, or the factory.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC = "packages/mcp/src/create.ts";
const SERVER = "packages/mcp/src/server.ts";

/**
 * Read the pins from SOURCE, not from a copy typed in here.
 *
 * A constant duplicated into its own checker verifies nothing — it would pass
 * while the real default pointed anywhere at all.
 */
const read = (p) => readFileSync(p, "utf8");
const bytesPin = Number(/CONTRACT_BYTES = (\d+)/.exec(read(SRC))?.[1]);
const appUrl = /appUrl:.*\?\?\s*"([^"]+)"/.exec(read(SERVER))?.[1];

if (!Number.isInteger(bytesPin)) throw new Error(`could not read CONTRACT_BYTES from ${SRC}`);
if (!appUrl) throw new Error(`could not read the default appUrl from ${SERVER}`);

console.log(`create page: ${appUrl}  (expects vault.wasm of ${bytesPin} B)`);

let bad = 0;
const fail = (m, fix) => {
  console.error(`BROKEN: ${m}`);
  if (fix) console.error(`  ${fix}`);
  bad++;
};

const get = async (u, init) => {
  try {
    return await fetch(u, { signal: AbortSignal.timeout(120_000), ...init });
  } catch (e) {
    return { ok: false, status: 0, _err: e.message };
  }
};

// 1. THE PAGE IS THE CREATE PAGE, not merely a 200.
//
// `app.usefloat.xyz` answered 200 for a month while serving the dashboard. A
// status code says a server is up, not that it is the right server — so match
// on the thing only the create page contains: the method it calls.
const page = await get(appUrl);
const html = page.ok ? await page.text() : "";
if (!page.ok) {
  fail(`${appUrl} returned ${page.status}${page._err ? ` (${page._err})` : ""}`);
} else if (!html.includes("create_vault_with_code")) {
  fail(
    `${appUrl} responded 200 but is not the create page — no create_vault_with_code in it.`,
    `It is probably the dashboard. The create page is served by web/serve.mjs.`,
  );
} else {
  console.log(`  page           OK  (${html.length} B, calls create_vault_with_code)`);
}

// 2. IT MUST NOT CALL THE GLOBAL PATH.
//
// `create_vault` needs a published global contract. Publishing burns 1e20
// yocto/byte, ~29.9 NEAR for this vault, and it has never been paid — so a
// page that called it would fail for every user, on mainnet, with the deposit
// already approved.
if (html.includes('"create_vault"') || /methodName:\s*"create_vault"/.test(html)) {
  fail(
    `the page calls create_vault, which needs a PUBLISHED global contract.`,
    `Mainnet answers NO_GLOBAL_CONTRACT for the referenced hash. Use create_vault_with_code.`,
  );
}

// 3. THE WASM BESIDE IT IS THE BUILD WE PINNED.
//
// Size AND hash. Size alone is a weak check — two builds 81 bytes apart is
// exactly what the `#[payable]` fix produced, but a change that happens to
// preserve length would slip through, and "same size" has already been
// mistaken for "same code" in this repo.
const wasmUrl = new URL("./vault.wasm", appUrl.endsWith("/") ? appUrl : appUrl + "/").toString();
const w = await get(wasmUrl);
if (!w.ok) {
  fail(
    `${wasmUrl} returned ${w.status}${w._err ? ` (${w._err})` : ""}`,
    `The page fetches ./vault.wasm at signing time; without it nobody can create anything.`,
  );
} else {
  const buf = Buffer.from(await w.arrayBuffer());
  const sha = createHash("sha256").update(buf).digest("hex").slice(0, 16);
  if (buf.length !== bytesPin) {
    fail(
      `served vault.wasm is ${buf.length} B but CONTRACT_BYTES pins ${bytesPin} (sha ${sha}).`,
      buf.length > bytesPin
        ? `The server has an OLDER build. Users are being quoted for one contract and sent another — ` +
          `and the deposit is derived from the pin, so an under-quote bricks the vault. Redeploy the page.`
        : `The pin is ahead of the server, or the artifact was rebuilt without re-pinning.`,
    );
  } else {
    console.log(`  vault.wasm     OK  (${buf.length} B, sha ${sha})`);
  }
}

if (bad) {
  console.error(
    `\n  ${bad} problem(s). This is the check that config assertions cannot do:\n` +
      `  it follows the URL a user is actually given and looks at what is there.`,
  );
  process.exit(1);
}
console.log("create page: serves the create flow and the pinned contract");

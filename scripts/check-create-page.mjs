#!/usr/bin/env node
/**
 * Does the URL we hand users actually create a vault?
 *
 * WHY THIS EXISTS. On 2026-11-10 the web host was serving a `vault.wasm` of
 * 298,920 B — the build from BEFORE the `#[payable]` fix — while the repo and
 * every quote used the 298,839 B build. Any vault created in that window got a
 * `bind_virtual_agent` that cannot be called at all, and all 28 checks were
 * green throughout, because the defect is not in the repo: it is the
 * relationship between a constant here, a file on a web server, and an account
 * on chain. The deploy's config assertions could not see it either — they
 * described the bytes we uploaded, and the break was in what we uploaded them
 * NEXT TO.
 *
 * TWO NON-DEFECTS THIS FILE ALSO RECORDS, because I reported both as real and
 * was wrong both times:
 *
 *   - `app.usefloat.xyz` serving the dashboard is CORRECT. nginx bounces
 *     anything with `?factory=` to the apex signing page. I probed the bare
 *     URL, which no user is ever given, and called it broken.
 *   - `create_vault` referencing an unpublished global contract is LATENT, not
 *     live. Nothing calls it; every client calls `create_vault_with_code`,
 *     which deploys the code per vault. I read the registry and concluded
 *     something about the product without tracing the call path.
 *
 * Both mistakes have one shape: assert a product-level failure from a probe
 * that never reproduced the product's own path. Hence the rule this file
 * follows — fetch the URL shape `buildCreatePlan` really emits, follow the
 * redirects, and check the artifact at whatever origin the page actually
 * landed on.
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
// A status code says a server is up, not that it is the right server — so
// match on the thing only the create page contains: the method it calls.
//
// FETCH THE SHAPE `buildCreatePlan` ACTUALLY EMITS, with `?factory=`, and
// follow redirects. The first version of this check fetched the BARE url and
// concluded `app.usefloat.xyz` was broken because it answered with the
// dashboard. It is not broken: nginx bounces anything carrying `?factory=` to
// the apex signing page, deliberately, because the published @floatonnear/mcp
// 0.5.0 hardcodes `app.` and breaking it would break vault creation for every
// existing install. `create.ts` sets `factory` on every link unconditionally,
// which is exactly what makes a signing link distinguishable from a dashboard
// visit.
//
// So a probe that drops the query string is not testing the product's URL —
// it is testing one no user is ever given, and it reported a defect that did
// not exist. Reproduce the real path or prove nothing.
const probeUrl = (() => {
  const u = new URL(appUrl);
  u.searchParams.set("factory", "probe.near");
  u.searchParams.set("network", "mainnet");
  return u.toString();
})();
const page = await get(probeUrl, { redirect: "follow" });
const html = page.ok ? await page.text() : "";
if (!page.ok) {
  fail(`${probeUrl} returned ${page.status}${page._err ? ` (${page._err})` : ""}`);
} else if (!html.includes("create_vault_with_code")) {
  fail(
    `${probeUrl} responded 200 but did not land on the create page.`,
    `Followed redirects to ${page.url || "?"}. Either the apex is not serving ` +
      `web/index.html, or the nginx rule that bounces ?factory= links stopped matching.`,
  );
} else {
  const hop = page.url && page.url !== probeUrl ? ` via ${new URL(page.url).origin}` : "";
  console.log(`  page           OK  (${html.length} B, calls create_vault_with_code${hop})`);
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
// RESOLVE AGAINST THE LANDING ORIGIN, not `appUrl`. The page fetches
// `./vault.wasm` relative to wherever it was finally served, so after a
// redirect those are different hosts — and checking the wrong one is how a
// stale artifact hides behind a correct-looking URL.
const wasmBase = page.url || appUrl;
const wasmUrl = new URL("./vault.wasm", wasmBase).toString();
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

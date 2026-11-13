#!/usr/bin/env node
/**
 * Publish the npm packages, then PROVE the registry serves the repo's bytes.
 *
 * WHY THIS EXISTS. On 2026-11-13 the registry was serving a `create-float`
 * whose version was 0.8.1 and whose CODE was older than this repo's 0.8.1 —
 * published once, then edited without a bump. Nothing caught it, because every
 * check compared the repo to itself. It surfaced only when a teardown was run
 * through npx and the output did not match the source anyone had read.
 *
 * So "published" is not asserted from a successful `npm publish`. It is
 * asserted by DOWNLOADING the tarball and diffing the files that matter
 * against the working tree. A publish that reports success and serves stale
 * bytes is exactly the failure this repo keeps re-learning:
 * `check-live-docs.mjs` for the skill host, `check-mcp-live.mjs` for the MCP,
 * now this one for npm.
 *
 *   node scripts/publish-and-verify.mjs            # publish, then verify
 *   node scripts/publish-and-verify.mjs --verify   # verify only, no publish
 *
 * NOT IN `verify-all`, deliberately: it needs the network and a live registry,
 * and it fails for reasons a working tree cannot fix.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LF = String.fromCharCode(10);
const VERIFY_ONLY = process.argv.includes("--verify");
const ROOT = resolve(import.meta.dirname, "..");

/**
 * The packages, and the ONE file in each whose contents prove the publish
 * carried this repo's code. Chosen because each is the file that was actually
 * wrong or fixed, not an arbitrary sample.
 */
const PACKAGES = [
  {
    dir: "packages/mcp",
    name: "@floatonnear/mcp",
    // Built output, so it is compared by a SUBSTRING that only the fix emits
    // rather than byte-for-byte (tsc output is stable but not a contract).
    builtProof: {
      file: "dist/server.js",
      mustContain: ["resolveKeyringPath", "retireRole", "Nothing was written"],
    },
    // mcp ships SKILL.md too, copied at `prepack` from the repo root — same
    // refresh-only-on-publish trap that left create-float 0.8.1 with a guide
    // 49 lines behind.
    sourceProof: ["SKILL.md"],
  },
  {
    dir: "packages/create-float",
    name: "@floatonnear/create-float",
    // Shipped as SOURCE, so this is an exact byte comparison.
    //
    // SKILL.md IS THE ONE THAT WAS ACTUALLY STALE. It is copied in at
    // `prepack`, so it refreshes ONLY on a publish — published 0.8.1 carried a
    // copy 49 lines behind, missing the corrected deposit quote, which makes a
    // wallet refuse the funding transaction. The .mjs files were fine; a
    // verifier that checked only code would have reported this package clean.
    sourceProof: ["SKILL.md", "bin/float-exit.mjs", "bin/create-float.mjs"],
  },
];

/** Run a command, returning stdout. NEVER redirects — see the npx memory. */
function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd: cwd ?? ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

function localVersion(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).version;
}

/**
 * AUTH IS CHECKED FIRST AND LOUDLY.
 *
 * `npm publish` with a dead token fails deep in the output with an E401 that
 * reads like a permissions problem on the package. The token being merely
 * EXPIRED — present in ~/.npmrc, so it looks like you are logged in — is the
 * state this machine was actually in.
 */
function requireAuth() {
  try {
    const who = run("npm", ["whoami"]).trim();
    console.log(`npm user: ${who}`);
    return who;
  } catch {
    console.error(
      `NOT LOGGED IN TO npm.${LF}` +
        `  A token may still be present in ~/.npmrc — that is what makes this` +
        `${LF}  look like a permissions error rather than an expired login.${LF}` +
        `${LF}  Fix:  npm login${LF}` +
        `  Then re-run this script.`,
    );
    process.exit(1);
  }
}

/** Download the published tarball and return a map of path -> contents. */
function fetchPublished(name, version) {
  const tmp = mkdtempSync(join(tmpdir(), "float-pub-"));
  try {
    run("npm", ["pack", `${name}@${version}`, "--pack-destination", tmp], tmp);
    const tgz = run("node", ["-e", `console.log(require('fs').readdirSync(${JSON.stringify(tmp)})[0])`]).trim();
    run("tar", ["-xzf", join(tmp, tgz), "-C", tmp]);
    return { dir: join(tmp, "package"), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

let problems = 0;

if (!VERIFY_ONLY) requireAuth();

for (const pkg of PACKAGES) {
  const version = localVersion(pkg.dir);
  console.log(`${LF}=== ${pkg.name} ${version} ===`);

  let published;
  try {
    published = run("npm", ["view", `${pkg.name}@${version}`, "version"]).trim();
  } catch {
    published = null;
  }

  if (!VERIFY_ONLY && published === version) {
    console.log(`  already on the registry at ${version} — skipping publish`);
  } else if (!VERIFY_ONLY) {
    console.log(`  publishing…`);
    try {
      // --access public: these are SCOPED packages, which npm would otherwise
      // default to restricted on a first publish.
      //
      // --otp is passed through when given. A code is valid for ~30 seconds,
      // so with two packages the second publish may need a fresh one; the
      // EOTP handler below says so rather than leaving it a mystery.
      const otpArg = (process.argv.find((a) => a.startsWith("--otp=")) ?? "").slice(6);
      run(
        "npm",
        ["publish", "--access", "public", ...(otpArg ? ["--otp", otpArg] : [])],
        join(ROOT, pkg.dir),
      );
      console.log(`  publish command returned ok`);
    } catch (e) {
      /**
       * THE TAIL, NOT THE HEAD.
       *
       * npm writes its entire tarball-contents listing to STDERR as `npm
       * notice` lines, then the actual error last. Slicing the first 400
       * characters showed nothing but the file list and buried an `EOTP`
       * completely — the publish looked like it failed for an unknown reason
       * when npm had said exactly what was wrong.
       */
      const err = String(e.stderr ?? e.message);
      const meaningful = err
        .split(LF)
        .filter((l) => l.trim() && !/^npm notice/.test(l))
        .slice(-12)
        .join(LF);
      console.error(`  PUBLISH FAILED:${LF}${meaningful}`);

      if (/EOTP|one-time password/i.test(err)) {
        console.error(
          `${LF}  This account has 2FA on publishing, so a one-time code is required and` +
            `${LF}  no script can generate it for you. Publish this one directly:` +
            `${LF}` +
            `${LF}      cd ${join(ROOT, pkg.dir)}` +
            `${LF}      npm publish --access public --otp=XXXXXX` +
            `${LF}` +
            `${LF}  Codes expire in ~30s, so get a FRESH one per package. Then run:` +
            `${LF}      node scripts/publish-and-verify.mjs --verify`,
        );
      }
      problems += 1;
      continue;
    }
  }

  /**
   * THE REGISTRY LAGS. `npm view` serves stale metadata for minutes after a
   * publish — already recorded in this project's memory — so a single read
   * that disagrees is not yet evidence of failure.
   */
  let seen = null;
  for (let i = 0; i < 12; i++) {
    try {
      seen = run("npm", ["view", `${pkg.name}@${version}`, "version"]).trim();
    } catch {
      seen = null;
    }
    if (seen === version) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  if (seen !== version) {
    console.error(`  registry still does not serve ${version} (saw ${seen ?? "nothing"})`);
    problems += 1;
    continue;
  }
  console.log(`  registry serves ${version}`);

  // ---- The part that matters: are the BYTES ours?
  let got;
  try {
    got = fetchPublished(pkg.name, version);
  } catch (e) {
    console.error(`  could not download the tarball: ${String(e.message).slice(0, 200)}`);
    problems += 1;
    continue;
  }

  try {
    for (const rel of pkg.sourceProof ?? []) {
      const mine = readFileSync(join(ROOT, pkg.dir, rel), "utf8");
      const theirs = existsSync(join(got.dir, rel)) ? readFileSync(join(got.dir, rel), "utf8") : null;
      if (theirs === null) {
        console.error(`  MISSING from the published tarball: ${rel}`);
        problems += 1;
      } else if (mine !== theirs) {
        console.error(
          `  STALE: published ${rel} differs from the repo` +
            `${LF}      repo ${mine.length} bytes, published ${theirs.length} bytes` +
            `${LF}      This is the 0.8.1 defect: same version, different code.` +
            `${LF}      Bump the version and publish again — npm will not let you overwrite.`,
        );
        problems += 1;
      } else {
        console.log(`  ok  ${rel} is byte-identical`);
      }
    }

    if (pkg.builtProof) {
      const { file, mustContain } = pkg.builtProof;
      const theirs = existsSync(join(got.dir, file)) ? readFileSync(join(got.dir, file), "utf8") : null;
      if (theirs === null) {
        console.error(`  MISSING from the published tarball: ${file}`);
        problems += 1;
      } else {
        for (const needle of mustContain) {
          if (theirs.includes(needle)) console.log(`  ok  published ${file} contains "${needle}"`);
          else {
            console.error(`  published ${file} is MISSING "${needle}" — it is not this build`);
            problems += 1;
          }
        }
      }
    }
  } finally {
    got.cleanup();
  }
}

console.log("");
if (problems) {
  console.error(`BROKEN: ${problems} problem(s). The registry does not serve this repo's code.`);
  process.exit(1);
}
console.log(`All packages published and VERIFIED from the registry — not from a success message.`);

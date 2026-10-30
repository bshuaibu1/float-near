import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The three packages a new user is told to `npx`, and the manifest facts that
 * decide whether that command can work at all.
 *
 * Every assertion here is a real failure from the 2026-10-30 publish attempt.
 * All of them were invisible to `npm pack` — the tarballs installed fine and the
 * bins linked — because `pack` does not apply publish-time normalization and
 * cannot know what npx will look for.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, "..", "..");

const SHIPPED = ["create-float", "mcp", "float-adapter"];

const manifest = (dir) => JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8"));

test("none of the shipped packages is private — a private package 404s for every user", () => {
  // mcp and float-adapter were both `private: true` while the wizard's own
  // closing banner, SKILL.md and the README all told users to npx them.
  for (const dir of SHIPPED) {
    assert.notEqual(manifest(dir).private, true, `packages/${dir} is private and cannot publish`);
  }
});

test("a scoped package has a bin matching its SCOPE-STRIPPED name, which is what npx runs", () => {
  // The rule that bit us: `npx @floatonnear/mcp` does not look for a bin named
  // after the full package. It strips the scope and looks for "mcp".
  //
  // On 2026-10-30 the package declared only "near-vault-mcp", so the command in
  // the wizard's own banner could never have resolved an executable — and
  // float-adapter had no bin field at all. Both were invisible to `npm pack`,
  // which links whatever bins exist without caring what npx will ask for.
  for (const dir of SHIPPED) {
    const m = manifest(dir);
    const stripped = m.name.replace(/^@[^/]+\//, "");
    assert.ok(m.bin, `packages/${dir} has no bin — npx ${m.name} cannot run anything`);
    assert.ok(
      Object.hasOwn(m.bin, stripped),
      `packages/${dir} needs a bin named "${stripped}" for \`npx ${m.name}\` to work; ` +
        `has ${Object.keys(m.bin).join(", ")}`,
    );
  }
});

test("no bin path carries a ./ prefix — npm rewrites it at publish time", () => {
  // `npm publish` reported:
  //   "bin[mcp]" script name dist/server.js was invalid and removed
  // which reads like the bin was dropped. It is actually npm normalizing
  // "./dist/server.js" to "dist/server.js" — confirmed by running `npm pkg fix`
  // on a scratch copy, which rewrites the value and keeps both keys.
  //
  // Writing the normalized form means publish has nothing to auto-correct, so
  // the alarming warning disappears and what ships is exactly what is in the
  // file. create-float never produced the warning because it already did this.
  for (const dir of SHIPPED) {
    for (const [name, path] of Object.entries(manifest(dir).bin ?? {})) {
      assert.ok(
        !path.startsWith("./"),
        `packages/${dir} bin["${name}"] = "${path}" — drop the ./ so npm does not rewrite it`,
      );
    }
  }
});

test("every package restricts what it ships with a files allowlist", () => {
  // Without `files`, npm ships the whole directory: src/, tests, tsconfig.
  for (const dir of SHIPPED) {
    const f = manifest(dir).files;
    assert.ok(Array.isArray(f) && f.length, `packages/${dir} has no files[] and would ship everything`);
  }
});

test("a package whose bin lives in dist/ rebuilds it on prepack", () => {
  // Neither TS package had a prepack, so `npm publish` would ship whatever
  // dist/ happened to be lying around — the same staleness bug the wasm guard
  // exists to prevent, one directory over.
  for (const dir of SHIPPED) {
    const m = manifest(dir);
    const needsBuild = Object.values(m.bin ?? {}).some((p) => p.includes("dist/"));
    if (!needsBuild) continue;
    assert.ok(
      (m.scripts ?? {}).prepack,
      `packages/${dir} ships a built bin but has no prepack to rebuild it`,
    );
  }
});

test("bin targets that are committed (not built) actually exist on disk", () => {
  // create-float's bins are plain .mjs in git, so a typo is checkable here.
  // dist/ targets are deliberately not checked: they are a build product and
  // asserting their presence would just mean "someone ran build recently",
  // which is the kind of check that passes for the wrong reason.
  for (const dir of SHIPPED) {
    for (const [name, p] of Object.entries(manifest(dir).bin ?? {})) {
      if (p.includes("dist/")) continue;
      assert.ok(
        existsSync(join(PACKAGES, dir, p)),
        `packages/${dir} bin["${name}"] points at ${p}, which does not exist`,
      );
    }
  }
});

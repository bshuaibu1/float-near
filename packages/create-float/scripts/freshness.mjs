/**
 * Is the contract on disk actually the contract in the source tree?
 *
 * bundle-wasm.mjs copies a wasm into res/ so a published create-float needs no
 * Rust toolchain. It interrogated that artifact for a test-clock symbol and for
 * panic_utf8 — both good checks — but never compared it against the SOURCE.
 *
 * Measured 2026-10-30: three generations of artifact were on disk at once.
 *
 *   res/vault.wasm        (what publishing would ship) : no NEAR_BUDGET, no PARENT_COOLDOWN
 *   target/near/vault.wasm (what prepack copies)       : NEAR_BUDGET,    no PARENT_COOLDOWN
 *   contracts/vault/src/                               : both
 *
 * So `npm publish` would have shipped real users a vault with no NEAR spending
 * ceiling (F2) and a cooldown that ignores ancestors (F3), reporting success.
 *
 * Two independent checks, because each is blind to what the other catches.
 */

/**
 * CONTENT — the ground-truth check.
 *
 * A reason code is a string literal inside the compiled wasm, because that is
 * how the contract names its own refusals. So "does this binary know about
 * PARENT_COOLDOWN" is answerable from the bytes themselves, with no metadata to
 * trust. That matters: the lesson of [[revision-file-lies-about-what-is-deployed]]
 * is that a file claiming to describe an artifact goes stale silently, while the
 * artifact cannot lie about its own contents.
 *
 * Only SHOUTED arms are codes. `Rail => "intents"` is a label that never appears
 * in the wasm as a code, and matching it would make the guard cry stale forever.
 */
export function missingCodes(typesSrc, wasmBytes) {
  const codes = new Set();
  for (const m of typesSrc.matchAll(/=>\s*"([A-Z][A-Z0-9_]+)"/g)) codes.add(m[1]);
  return [...codes].filter((c) => !wasmBytes.includes(Buffer.from(c))).sort();
}

/**
 * MTIME — the backstop.
 *
 * Content cannot see a change that adds no reason code: the F4 off-by-one was a
 * comparison and a comment, invisible to the check above. Any edit at all moves
 * an mtime, so this catches the rest.
 *
 * Strictly newer. Filesystem timestamps are coarse and a build that finishes in
 * the same millisecond as the last edit is fine; failing it would make the guard
 * fire on every fast machine for no reason.
 */
export function staleSources(wasmMtimeMs, sources) {
  return sources.filter((s) => s.mtimeMs > wasmMtimeMs).map((s) => s.path);
}

/**
 * Both checks, reported together.
 *
 * Every problem, not the first one — a publisher fixing them one rebuild at a
 * time learns nothing the second time that it could not have learned at once.
 */
export function freshnessProblems({ typesSrc, wasmBytes, wasmMtimeMs, sources }) {
  const problems = [];

  const missing = missingCodes(typesSrc, wasmBytes);
  if (missing.length) {
    problems.push(
      `the contract does not answer ${missing.length} reason code(s) the source defines: ${missing.join(", ")}`,
    );
  }

  const stale = staleSources(wasmMtimeMs, sources);
  if (stale.length) {
    problems.push(`${stale.length} source file(s) are newer than the contract: ${stale.join(", ")}`);
  }

  return problems;
}

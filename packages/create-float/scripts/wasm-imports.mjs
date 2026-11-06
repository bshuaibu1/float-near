/**
 * What host functions does a wasm module actually IMPORT?
 *
 * Pure: no CLI, no argv, no process.exit. That is the point of the file. The
 * previous home for this parser (repo-root scripts/wasm-imports.mjs) ran its
 * CLI at module scope and exited 1 when argv was empty, so importing it
 * terminated the caller — the same failure args.mjs documents for parseArgs,
 * reproduced in a second file. It now delegates here.
 *
 * Why the import section and not a byte search: a host-function name also
 * appears in the name section, in debug info, and in string data, so a grep hit
 * proves only that the bytes occur SOMEWHERE. Asking "is this function
 * imported" can only be answered from the import section.
 *
 * MEASURED 2026-10-30, both artifacts built from the same source:
 *
 *   cargo near build   40 env imports, incl. panic_utf8 and sha256
 *   plain cargo build  38 env imports, panic_utf8 and sha256 ABSENT
 *
 * That difference is why it matters. Without panic_utf8 the contract still
 * runs, but near-sdk-env compiles the local panic branch, and every one of this
 * vault's 44 reason codes arrives as "WebAssembly trap: An `unreachable`
 * opcode was executed" instead of "INVALID_CONFIG: label ...".
 *
 * A trap worth recording, because it produced a wrong conclusion in this
 * session: `target/wasm32-unknown-unknown/release/vault.wasm` is NOT a
 * plain-cargo artifact. cargo-near builds there first, WITH --cfg near, and
 * then wasm-opts into target/near/vault/. Comparing those two paths compares
 * cargo-near against itself and shows identical import sets.
 */

/** LEB128 unsigned. Returns [value, bytesRead]. */
function uleb(buf, off) {
  let result = 0n,
    shift = 0n,
    n = 0;
  for (;;) {
    const byte = buf[off + n];
    if (byte === undefined) throw new Error("truncated LEB128");
    result |= BigInt(byte & 0x7f) << shift;
    n++;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 63n) throw new Error("LEB128 too long");
  }
  return [Number(result), n];
}

const KIND = { 0: "func", 1: "table", 2: "memory", 3: "global", 4: "tag" };

/**
 * Parse a module's import section.
 *
 * THROWS on anything that is not a wasm module. "Could not be parsed" must not
 * be reportable as "imports nothing", because a publish guard reading the
 * latter would wave garbage through.
 */
export function parseImports(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) throw new Error("not wasm");
  const version = buf.readUInt32LE(4);

  let off = 8;
  const out = [];
  const sections = [];
  while (off < buf.length) {
    const id = buf[off];
    off += 1;
    const [size, n] = uleb(buf, off);
    off += n;
    const end = off + size;
    sections.push({ id, size });

    if (id === 2) {
      let p = off;
      const [count, cn] = uleb(buf, p);
      p += cn;
      for (let i = 0; i < count; i++) {
        const [mlen, mn] = uleb(buf, p);
        p += mn;
        const module = buf.subarray(p, p + mlen).toString("utf8");
        p += mlen;
        const [flen, fn] = uleb(buf, p);
        p += fn;
        const field = buf.subarray(p, p + flen).toString("utf8");
        p += flen;
        const kind = buf[p];
        p += 1;
        if (kind === 0) {
          const [, k] = uleb(buf, p);
          p += k;
        } else if (kind === 1) {
          p += 1;
          const [, l] = uleb(buf, p);
          p += l;
          if (buf[p - 1 - l] === 0x01) {
            const [, m] = uleb(buf, p);
            p += m;
          }
        } else if (kind === 2) {
          const fl = buf[p];
          p += 1;
          const [, l] = uleb(buf, p);
          p += l;
          if (fl === 0x01) {
            const [, m] = uleb(buf, p);
            p += m;
          }
        } else if (kind === 3) {
          p += 1;
          p += 1;
        } else throw new Error(`unhandled import kind ${kind}`);
        out.push({ module, field, kind: KIND[kind] ?? kind });
      }
    }
    off = end;
  }
  return { version, imports: out, sections };
}

/** Just the imported FUNCTIONS, which is what a host-function question means. */
export function funcImports(buf) {
  return parseImports(buf).imports.filter((i) => i.kind === "func");
}

/** Does this module import the named host function? */
export function importsHostFn(buf, field) {
  return funcImports(buf).some((i) => i.field === field);
}

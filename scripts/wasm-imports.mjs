#!/usr/bin/env node
/**
 * List a wasm module's REAL imports, by parsing the import section.
 *
 * Why this exists rather than `grep -c panic_utf8 file.wasm`: a grep hit proves
 * only that the byte sequence appears SOMEWHERE in the file. Host-function
 * names also appear in the name section, in debug info, and in string data, so
 * a grep can report an import that is not imported — and, on a stripped
 * binary, can miss nothing at all while looking identical. The question "do
 * these two artifacts import the same host functions?" can only be answered
 * from the import section itself.
 *
 * Usage: node scripts/wasm-imports.mjs <a.wasm> [b.wasm]
 *        With two files, prints the set difference.
 */
import { readFileSync } from "node:fs";

/** LEB128 unsigned. Returns [value, bytesRead]. */
function uleb(buf, off) {
  let result = 0n, shift = 0n, n = 0;
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

export function imports(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error(`${path}: not wasm`);
  const version = buf.readUInt32LE(4);

  let off = 8;
  const out = [];
  const sections = [];
  while (off < buf.length) {
    const id = buf[off]; off += 1;
    const [size, n] = uleb(buf, off); off += n;
    const end = off + size;
    sections.push({ id, size });

    if (id === 2) {
      // Import section: count, then (module, field, kind, ...)
      let p = off;
      const [count, cn] = uleb(buf, p); p += cn;
      for (let i = 0; i < count; i++) {
        const [mlen, mn] = uleb(buf, p); p += mn;
        const module = buf.subarray(p, p + mlen).toString("utf8"); p += mlen;
        const [flen, fn] = uleb(buf, p); p += fn;
        const field = buf.subarray(p, p + flen).toString("utf8"); p += flen;
        const kind = buf[p]; p += 1;
        // Skip the kind-specific descriptor.
        if (kind === 0) { const [, k] = uleb(buf, p); p += k; }                 // typeidx
        else if (kind === 1) { p += 1; const [, l] = uleb(buf, p); p += l;      // table: reftype+limits
          if (buf[p - 1 - l] === 0x01) { const [, m] = uleb(buf, p); p += m; } }
        else if (kind === 2) { const fl = buf[p]; p += 1;                        // memory: limits
          const [, l] = uleb(buf, p); p += l;
          if (fl === 0x01) { const [, m] = uleb(buf, p); p += m; } }
        else if (kind === 3) { p += 1; p += 1; }                                 // global: valtype+mut
        else throw new Error(`unhandled import kind ${kind}`);
        out.push({ module, field, kind: KIND[kind] ?? kind });
      }
    }
    off = end;
  }
  return { version, imports: out, sections };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/wasm-imports.mjs <a.wasm> [b.wasm]");
  process.exit(1);
}

const parsed = files.map((f) => {
  const r = imports(f);
  const names = r.imports.filter((i) => i.kind === "func").map((i) => `${i.module}.${i.field}`);
  console.log(`\n=== ${f}`);
  console.log(`    wasm version   : ${r.version}`);
  console.log(`    sections       : ${r.sections.length} (ids: ${[...new Set(r.sections.map((s) => s.id))].join(",")})`);
  console.log(`    function imports: ${names.length}`);
  const byModule = {};
  for (const n of names) {
    const m = n.split(".")[0];
    (byModule[m] ??= []).push(n.slice(m.length + 1));
  }
  for (const [m, fs] of Object.entries(byModule)) {
    console.log(`    module "${m}": ${fs.length}`);
    for (const f of fs.sort()) console.log(`        ${f}`);
  }
  return new Set(names);
});

if (parsed.length === 2) {
  const [a, b] = parsed;
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  console.log(`\n=== DIFF`);
  console.log(`    in both        : ${[...a].filter((x) => b.has(x)).length}`);
  console.log(`    only in ${files[0]}: ${onlyA.length}${onlyA.length ? "\n        " + onlyA.join("\n        ") : ""}`);
  console.log(`    only in ${files[1]}: ${onlyB.length}${onlyB.length ? "\n        " + onlyB.join("\n        ") : ""}`);
  console.log(`    VERDICT        : ${onlyA.length === 0 && onlyB.length === 0 ? "IDENTICAL import sets" : "DIFFERENT import sets"}`);
}

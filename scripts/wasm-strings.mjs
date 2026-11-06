#!/usr/bin/env node
/**
 * What is in the data section, and how much of it is text we chose?
 *
 * The vault's data section is 35,441 bytes = 3.544 NEAR burned per published
 * global version. Unlike the code section, a good share of it is string
 * literals the contract's own source decides: panic messages, reason codes,
 * serde field names, and the human-readable half of every `fail(...)` call.
 *
 * That makes it the one part of the artifact where a size saving is editable
 * rather than architectural. This counts the bytes so the trade is priced
 * before anyone argues about it: at 1e20 yocto/byte, 1,000 bytes of prose is
 * 0.1 NEAR per version.
 *
 * It does NOT recommend shortening reason codes. Those are the contract's
 * stable API — SKILL.md tells agents to match on them literally — and the
 * human-readable suffix is what makes a refusal diagnosable. The point is to
 * know the price, not to assume it is worth paying.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
const MIN = Number(process.argv[3] ?? 8);
if (!file) {
  console.error("usage: wasm-strings.mjs <wasm> [min-length]");
  process.exitCode = 2;
} else {
  const buf = readFileSync(file);
  const uleb = (b, at) => {
    let v = 0,
      shift = 0,
      n = 0;
    for (;;) {
      const byte = b[at + n];
      v += (byte & 0x7f) * 2 ** shift;
      n += 1;
      if (!(byte & 0x80)) break;
      shift += 7;
    }
    return [v, n];
  };

  // Locate the data section (id 11) rather than scanning the whole file, so the
  // figures describe the section the cost table attributes them to.
  let off = 8;
  let data = null;
  while (off < buf.length) {
    const id = buf[off];
    const [size, n] = uleb(buf, off + 1);
    const payloadAt = off + 1 + n;
    if (id === 11) data = buf.subarray(payloadAt, payloadAt + size);
    off = payloadAt + size;
  }
  if (!data) {
    console.error("no data section found");
    process.exitCode = 1;
  } else {
    // Printable ASCII runs.
    const found = [];
    let cur = [];
    for (const byte of data) {
      if (byte >= 0x20 && byte < 0x7f) cur.push(byte);
      else {
        if (cur.length >= MIN) found.push(Buffer.from(cur).toString("ascii"));
        cur = [];
      }
    }
    if (cur.length >= MIN) found.push(Buffer.from(cur).toString("ascii"));

    const textBytes = found.reduce((s, x) => s + x.length, 0);
    const near = (b) => (b / 1e4).toFixed(4);
    console.log(`data section ${data.length} bytes = ${near(data.length)} NEAR burned`);
    console.log(`printable runs >= ${MIN} chars: ${found.length} strings, ${textBytes} bytes = ${near(textBytes)} NEAR`);
    console.log(`  ${((textBytes / data.length) * 100).toFixed(1)}% of the data section is text`);
    console.log("");

    // Group by what the string plausibly is, so the editable part is separable
    // from the part that comes from dependencies.
    const isReason = (s) => /^[A-Z][A-Z0-9_]{3,}$/.test(s.trim());
    const buckets = { "REASON_CODES (stable API)": [], "messages / prose": [], "other (deps, fmt, paths)": [] };
    for (const s of found) {
      if (isReason(s)) buckets["REASON_CODES (stable API)"].push(s);
      else if (/^[a-z][a-z0-9 ,.'`:;=\-()\/]{11,}$/i.test(s) && / /.test(s))
        buckets["messages / prose"].push(s);
      else buckets["other (deps, fmt, paths)"].push(s);
    }
    for (const [k, v] of Object.entries(buckets)) {
      const b = v.reduce((s, x) => s + x.length, 0);
      console.log(`  ${k.padEnd(28)} ${String(v.length).padStart(5)} strings  ${String(b).padStart(6)} B  ${near(b)} NEAR`);
    }

    console.log("");
    console.log("  longest 15 strings — the editable end of the cost:");
    for (const s of [...found].sort((a, b) => b.length - a.length).slice(0, 15)) {
      console.log(`    ${String(s.length).padStart(4)} B  ${JSON.stringify(s.slice(0, 96))}`);
    }
  }
}

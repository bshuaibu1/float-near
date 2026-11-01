#!/usr/bin/env node
/**
 * Where are a contract's bytes? A section-by-section breakdown.
 *
 * WHY IT MATTERS NOW. Publishing a global contract burns 1e20 yocto PER BYTE —
 * measured on mainnet — so the vault's 299,620 bytes cost 29.962 NEAR, and the
 * relationship is exactly linear: 10 KB cut is 1 NEAR saved. Under `CodeHash`
 * every version is a fresh burn, so shrinking AFTER the first publish means
 * paying twice. That makes "which bytes are not load-bearing" a question with a
 * price attached.
 *
 * The distinction this is built to expose: a `custom` section (id 0) carries
 * names, producer metadata or debug info that execution IGNORES, so removing it
 * cannot change behaviour. Bytes in `code` (id 10) are the contract, and
 * shrinking those is real work with real risk.
 *
 * Parses the binary rather than trusting a tool's summary, in the same spirit
 * as wasm-imports.mjs: a size claim about a shipped artifact should come from
 * the artifact.
 */
import { readFileSync } from "node:fs";

const NAMES = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "datacount",
};

const file = process.argv[2];
if (!file) {
  console.error("usage: wasm-sections.mjs <wasm>");
  process.exitCode = 2;
} else {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x6d736100) {
    console.error(`${file} is not a wasm module (bad magic)`);
    process.exitCode = 1;
  } else {
    /** LEB128 unsigned, returning [value, bytesRead]. */
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

    let off = 8; // magic + version
    const rows = [];
    while (off < buf.length) {
      const id = buf[off];
      const [size, n] = uleb(buf, off + 1);
      const headerLen = 1 + n;
      const payloadAt = off + headerLen;
      let label = NAMES[id] ?? `unknown(${id})`;
      if (id === 0) {
        // A custom section's payload starts with its own name.
        const [nameLen, nn] = uleb(buf, payloadAt);
        const name = buf.subarray(payloadAt + nn, payloadAt + nn + nameLen).toString("utf8");
        label = `custom "${name}"`;
      }
      rows.push({ id, label, total: headerLen + size });
      off = payloadAt + size;
    }

    const total = buf.length;
    rows.sort((a, b) => b.total - a.total);

    // TWO RATES, TEN TIMES APART, AND THEY ARE EASY TO CONFUSE.
    //
    // Normal per-account storage staking is 1e19 yocto/byte, so NEAR = bytes/1e5.
    // Publishing a GLOBAL contract burns 1e20 yocto/byte — measured on mainnet —
    // so NEAR = bytes/1e4.
    //
    // The first version of this file used /1e5 under a heading that said "to
    // publish globally", and reported the 299,620-byte vault at 2.996 NEAR
    // instead of 29.962. Exactly the 10x this project had just spent two
    // measurements establishing, thrown away in the unit conversion. Both rates
    // are printed now, labelled, because the comparison IS the point.
    const globalNear = (b) => (b / 1e4).toFixed(5); // burned, 1e20/byte
    const stakeNear = (b) => (b / 1e5).toFixed(5); // staked, 1e19/byte

    console.log(`${file}  ${total} bytes`);
    console.log(`  publish globally: ${globalNear(total)} NEAR BURNED  (1e20/byte, measured on mainnet)`);
    console.log(`  deploy normally:  ${stakeNear(total)} NEAR staked, per vault, refundable`);
    console.log("");
    console.log("  section              bytes      %   burned if global");
    console.log("  -------------------- ---------- ----- ----------------");
    for (const r of rows) {
      const pct = ((r.total / total) * 100).toFixed(1);
      console.log(
        `  ${r.label.padEnd(20)} ${String(r.total).padStart(10)} ${pct.padStart(4)}% ${globalNear(r.total).padStart(13)}`,
      );
    }

    // What is safely removable: custom sections never affect execution.
    const strippable = rows.filter((r) => r.id === 0).reduce((s, r) => s + r.total, 0);
    console.log("");
    console.log(`  custom sections (execution ignores these): ${strippable} bytes = ${globalNear(strippable)} NEAR`);
    if (strippable === 0) {
      console.log(`  -> nothing free to strip; any reduction means changing the CODE`);
    } else {
      console.log(`  -> removable with no behaviour change, saving ${globalNear(strippable)} NEAR per publish`);
    }
    console.log("");
    console.log(`  every 10 KB cut saves exactly 1 NEAR per published version`);
    const code = rows.find((r) => r.id === 10);
    if (code) {
      console.log("");
      console.log(`  code section is ${((code.total / total) * 100).toFixed(1)}% of the artifact —`);
      console.log(`  that is the floor unless the contract itself gets smaller.`);
    }
  }
}

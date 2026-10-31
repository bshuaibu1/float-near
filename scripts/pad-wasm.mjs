// Pad a wasm to a target size with a CUSTOM section (id 0), which execution
// ignores but which counts toward the deployed byte length. A second size with
// no behaviour change, so SIZE is the only variable between the two runs.
import { readFileSync, writeFileSync } from "node:fs";

const [src, dst, wantStr] = process.argv.slice(2);
const want = Number(wantStr);
const base = readFileSync(src);
const name = Buffer.from("pad");
const payloadLen = want - base.length - 5;
if (payloadLen < 0) throw new Error(`${src} is already ${base.length} bytes, cannot pad to ${want}`);

const leb = (n) => {
  const o = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    o.push(b);
  } while (n);
  return Buffer.from(o);
};

const sec = Buffer.concat([
  Buffer.from([0x00]), // custom section id
  leb(payloadLen + 1 + name.length),
  Buffer.from([name.length]),
  name,
  Buffer.alloc(payloadLen, 0x41),
]);
const out = Buffer.concat([base, sec]);
writeFileSync(dst, out);
console.log(`${dst}: ${out.length} bytes (from ${base.length})`);

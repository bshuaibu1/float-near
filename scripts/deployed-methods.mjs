#!/usr/bin/env node
/**
 * Which methods does the DEPLOYED contract actually expose?
 *
 * Source is not evidence. `float.test015.near` has been running the same
 * artifact since before several of this repo's features existed, and the
 * owner `withdraw` carries a comment calling it "a path that should have
 * existed from the start" — which is how a method that was ADDED LATER reads.
 * Planning a teardown around a method the deployed bytes do not export would
 * fail at the worst possible moment: after the USDC was supposed to be out.
 *
 * near-sdk compiles every public method to an `extern "C"` symbol, so the
 * wasm EXPORT SECTION is the authoritative list. This parses it rather than
 * grepping the binary for strings, because a method name can appear in a data
 * section (a log line, an error message) without being callable — and this is
 * exactly the kind of check that must not confuse "the word is in the file"
 * with "the function is reachable".
 *
 * READ ONLY.
 */
import { JsonRpcProvider } from "near-api-js";

const RPC = process.env.RPC ?? "https://free.rpc.fastnear.com";
const ACCOUNT = process.env.ACCOUNT ?? "float.test015.near";
const WANT = (process.env.WANT ?? "withdraw,request_payment,set_node_caps,add_node,get_config")
  .split(",")
  .filter(Boolean);

const p = new JsonRpcProvider({ url: RPC });
const code = Buffer.from(
  (await p.viewContractCode({ contractId: ACCOUNT, blockQuery: { finality: "final" } })).code_base64,
  "base64",
);

// ---- minimal wasm walk to the export section (id 7) --------------------------
if (code.readUInt32LE(0) !== 0x6d736100) throw new Error("not a wasm module");
let o = 8;
const uleb = () => {
  let r = 0, s = 0, b;
  do {
    b = code[o++];
    r |= (b & 0x7f) << s;
    s += 7;
  } while (b & 0x80);
  return r >>> 0;
};

const exports = [];
while (o < code.length) {
  const id = code[o++];
  const size = uleb();
  const end = o + size;
  if (id === 7) {
    const count = uleb();
    for (let i = 0; i < count; i++) {
      const nameLen = uleb();
      const name = code.slice(o, o + nameLen).toString("utf8");
      o += nameLen;
      const kind = code[o++];
      uleb(); // index
      if (kind === 0) exports.push(name); // 0 = function
    }
    break;
  }
  o = end;
}

exports.sort();
console.log(`\n  ${ACCOUNT}`);
console.log(`  ${code.length} B, ${exports.length} exported functions\n`);

const set = new Set(exports);
let missing = 0;
for (const w of WANT) {
  const has = set.has(w);
  if (!has) missing++;
  console.log(`  ${has ? "YES" : "NO "}  ${w}`);
}

console.log(`\n  all exported methods:`);
for (const e of exports) {
  if (e === "memory" || e.startsWith("__")) continue;
  console.log(`    ${e}`);
}
console.log();
process.exit(missing === 0 ? 0 : 1);

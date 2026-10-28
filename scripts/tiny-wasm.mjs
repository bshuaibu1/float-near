#!/usr/bin/env node
/**
 * Emit a minimal valid NEAR contract, for measuring the COST OF AN ACTION
 * rather than the cost of a contract.
 *
 * Why hand-built. The question is what `UseGlobalContractAction` charges a
 * user. Answering it with the real vault would mean a global deploy of 280,249
 * bytes, and NEP-591 prices that at 10x storage staking — ~28 NEAR, burned.
 * The action's cost does not depend on what the code DOES, so the honest
 * instrument is the smallest valid module that can be deployed: ~49 bytes, a
 * ~0.005 NEAR burn, and nothing else moving.
 *
 * The module exports `memory` and a single no-op `hello() -> ()`. That is
 * enough to be deployable and callable, which is all the experiment needs.
 *
 * Usage: node scripts/tiny-wasm.mjs <out.wasm>
 */
import { writeFileSync } from "node:fs";

const section = (id, payload) => Buffer.concat([
  Buffer.from([id]), Buffer.from([payload.length]), payload,
]);

const str = (s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, "utf8")]);

const wasm = Buffer.concat([
  Buffer.from([0x00, 0x61, 0x73, 0x6d]),       // magic \0asm
  Buffer.from([0x01, 0x00, 0x00, 0x00]),       // version 1

  // Type: one signature, () -> ()
  section(1, Buffer.from([0x01, 0x60, 0x00, 0x00])),

  // Function: one function, of type 0
  section(3, Buffer.from([0x01, 0x00])),

  // Memory: one memory, min 1 page. NEAR's prepare step expects a contract to
  // provide its own linear memory.
  section(5, Buffer.from([0x01, 0x00, 0x01])),

  // Export: "memory" (mem 0) and "hello" (func 0). A NEAR method must be an
  // exported () -> () function; that is exactly func 0.
  section(7, Buffer.concat([
    Buffer.from([0x02]),
    str("memory"), Buffer.from([0x02, 0x00]),
    str("hello"), Buffer.from([0x00, 0x00]),
  ])),

  // Code: one body, no locals, immediate `end`.
  section(10, Buffer.from([0x01, 0x02, 0x00, 0x0b])),
]);

const out = process.argv[2];
if (!out) { console.error("usage: node scripts/tiny-wasm.mjs <out.wasm>"); process.exit(1); }
writeFileSync(out, wasm);
console.log(`${out}: ${wasm.length} bytes`);
console.log(`  storage stake at 1e19/byte : ${(wasm.length * 1e19 / 1e24).toFixed(6)} NEAR`);
console.log(`  global deploy at 10x       : ${(wasm.length * 1e20 / 1e24).toFixed(6)} NEAR (burned)`);

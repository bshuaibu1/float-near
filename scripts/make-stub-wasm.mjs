#!/usr/bin/env node
/**
 * Hand-build the two smallest possible global contracts, so the factory's
 * promise batch can be verified on testnet for pennies.
 *
 * WHY THIS EXISTS. The factory cannot be exercised without a PUBLISHED global
 * contract, and publishing the real vault costs 299,620 x 1e20 = 29.962 NEAR —
 * measured, not estimated. The testnet pool holds 0.38 NEAR free. Even a
 * minimal near-sdk contract is ~100 KB, which is ~10 NEAR at the global rate,
 * so "just use a stub contract" does not work either: near-sdk is the floor.
 *
 * Raw wasm has no floor. A NEAR contract method is just an exported function
 * with signature () -> (), and a module containing one is 33 bytes — 0.0033
 * NEAR to publish globally, four orders of magnitude cheaper than the vault.
 *
 * TWO STUBS, because the two paths worth testing need opposite outcomes:
 *
 *   stub-new.wasm   exports `new`, which returns immediately.
 *                   -> the batch SUCCEEDS. Verifies CreateAccount, Transfer,
 *                      UseGlobalContract issued from inside a contract, and
 *                      that function_call reaches the newly created account.
 *
 *   tiny.wasm       exports nothing (the existing 49-byte file).
 *                   -> `new` is MethodNotFound, so the batch FAILS. Verifies
 *                      the refund path, which is the one that silently costs a
 *                      user ~0.1 NEAR if it is broken.
 *
 * What these CANNOT verify is the vault itself: that its parent-init exemption
 * accepts the factory, and that a configured vault comes out the far end. That
 * needs the real artifact published globally and is gated behind REAL_VAULT=1
 * in validate-factory-testnet.mjs.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** A section: id byte, then LEB128 length, then payload. */
const section = (id, payload) => Buffer.concat([Buffer.from([id]), leb(payload.length), payload]);

function leb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

/** A module exporting one no-op function under `name`. */
function moduleExporting(name) {
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  // type: one func type, () -> ()
  const types = section(1, Buffer.from([0x01, 0x60, 0x00, 0x00]));
  // function: one function, of type 0
  const funcs = section(3, Buffer.from([0x01, 0x00]));
  // export: one export, `name`, kind 0 (func), index 0
  const nameBytes = Buffer.from(name, "ascii");
  const exports = section(
    7,
    Buffer.concat([
      Buffer.from([0x01, nameBytes.length]),
      nameBytes,
      Buffer.from([0x00, 0x00]),
    ]),
  );
  // code: one body — no locals, then `end`
  const code = section(10, Buffer.from([0x01, 0x02, 0x00, 0x0b]));
  return Buffer.concat([header, types, funcs, exports, code]);
}

const out = resolve(ROOT, ".demo", "stub-new.wasm");
const mod = moduleExporting("new");
writeFileSync(out, mod);
console.log(`${out}`);
console.log(`  ${mod.length} bytes  =  ${(mod.length / 1e4).toFixed(4)} NEAR to publish globally`);
console.log(`  exports: new  (no-op, returns immediately)`);

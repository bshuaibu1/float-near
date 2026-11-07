import { test } from "node:test";
import assert from "node:assert/strict";

import { stubWasm, resolveVaultSigner } from "../bin/float-exit.mjs";

/**
 * `float exit` is the only path a user has to get their deposit back, and the
 * version published in 0.4.0 could not refund anyone. Five defects, each
 * verified against a live vault; the two tested here are the two that are pure
 * functions, and they are the two that decide whether the money comes back at
 * all.
 *
 * The other three (signing `withdraw` as the vault, deleting agent
 * sub-accounts, no purge/shrink) are sequencing bugs in an async flow that
 * needs a chain. They are covered by the proven sequence in
 * scripts/teardown-vault.mjs, run 3x against live vaults.
 */

test("resolveVaultSigner uses the OWNER's key when it is full-access on the vault", () => {
  // THE BUG THAT MADE THE OLD VERSION USELESS. A factory vault has exactly one
  // full-access key — the owner's, installed by the factory during `new`. The
  // old version looked only for a `<vault>.json` credential, did not find one,
  // and told the user their stake was "unrecoverable". It was not.
  const r = resolveVaultSigner({
    vaultKeys: [
      { public_key: "ed25519:OWNER", access_key: { permission: "FullAccess" } },
      {
        public_key: "ed25519:AGENT",
        access_key: { permission: { GasKeyFunctionCall: { balance: "1" } } },
      },
    ],
    ownerPublicKey: "ed25519:OWNER",
    ownerSecret: "ed25519:OWNERSECRET",
    vaultSecret: null,
  });
  assert.equal(r.secret, "ed25519:OWNERSECRET");
  assert.equal(r.via, "owner");
  // A gas key is NOT full-access and must never be counted as one.
  assert.equal(r.fullAccessCount, 1);
});

test("resolveVaultSigner falls back to a standalone vault credential", () => {
  // The CLI wizard does generate one, so this path stays.
  const r = resolveVaultSigner({
    vaultKeys: [{ public_key: "ed25519:SOMEONEELSE", access_key: { permission: "FullAccess" } }],
    ownerPublicKey: "ed25519:OWNER",
    ownerSecret: "ed25519:OWNERSECRET",
    vaultSecret: "ed25519:VAULTSECRET",
  });
  assert.equal(r.secret, "ed25519:VAULTSECRET");
  assert.equal(r.via, "vault-file");
});

test("resolveVaultSigner prefers the owner key over a stale vault credential", () => {
  // Both present. The owner's key is the one the factory actually installed;
  // a leftover <vault>.json may be from a different generation of the vault.
  const r = resolveVaultSigner({
    vaultKeys: [{ public_key: "ed25519:OWNER", access_key: { permission: "FullAccess" } }],
    ownerPublicKey: "ed25519:OWNER",
    ownerSecret: "ed25519:OWNERSECRET",
    vaultSecret: "ed25519:STALE",
  });
  assert.equal(r.secret, "ed25519:OWNERSECRET");
});

test("resolveVaultSigner refuses when nothing can sign, rather than guessing", () => {
  // A vault with no reachable full-access key genuinely cannot be emptied:
  // it cannot deploy, cannot withdraw from a gas key, cannot delete itself.
  // Returning null makes the caller say so instead of shrinking the account,
  // which would free the stake into something nobody can empty.
  const r = resolveVaultSigner({
    vaultKeys: [
      { public_key: "ed25519:OTHER", access_key: { permission: "FullAccess" } },
      { public_key: "ed25519:FC", access_key: { permission: { FunctionCall: {} } } },
    ],
    ownerPublicKey: "ed25519:OWNER",
    ownerSecret: "ed25519:OWNERSECRET",
    vaultSecret: null,
  });
  assert.equal(r.secret, null);
  assert.equal(r.via, null);
  assert.equal(r.fullAccessCount, 1);
});

test("resolveVaultSigner does not treat a gas key as able to sign", () => {
  // A NEP-611 gas key cannot sign DeployContract or DeleteAccount. Counting
  // one as full-access would make the tool promise a refund it cannot deliver.
  const r = resolveVaultSigner({
    vaultKeys: [
      {
        public_key: "ed25519:OWNER",
        access_key: { permission: { GasKeyFunctionCall: { balance: "100" } } },
      },
    ],
    ownerPublicKey: "ed25519:OWNER",
    ownerSecret: "ed25519:OWNERSECRET",
    vaultSecret: null,
  });
  assert.equal(r.secret, null);
  assert.equal(r.fullAccessCount, 0);
});

test("stubWasm is the exact 33-byte module, byte for byte", () => {
  // Pinned against scripts/make-stub-wasm.mjs, whose output was deployed to a
  // live mainnet vault to take it from 308,281 B to a size DeleteAccount
  // would accept. Generated rather than shipped as a file, because a
  // published package cannot reach the repo's .demo/ directory — so this test
  // is the only thing stopping the two drifting apart.
  const b = stubWasm();
  assert.equal(b.length, 33);
  assert.equal(
    b.toString("hex"),
    "0061736d0100000001040160000003020100070701036e657700000a040102000b",
  );
});

test("stubWasm is a valid wasm module that exports `new`", () => {
  const b = stubWasm();
  // Magic + version, or the chain rejects the deploy.
  assert.deepEqual([...b.subarray(0, 8)], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  // The export name has to be `new`: the factory's batch calls it, and a
  // module exporting nothing makes that MethodNotFound.
  assert.ok(b.includes(Buffer.from("new", "ascii")));
  // And it really parses — a hand-built module that WebAssembly rejects would
  // fail only at deploy time, after the tokens had already moved.
  assert.ok(WebAssembly.validate(b), "stub is not a valid wasm module");
});

test("stubWasm is deterministic", () => {
  // It is embedded rather than read from disk precisely so it cannot drift;
  // that argument only holds if it is a pure function.
  assert.equal(stubWasm().toString("hex"), stubWasm().toString("hex"));
});

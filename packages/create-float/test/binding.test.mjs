import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBinding } from "../bin/float-relay.mjs";

// Pinned against bytes emitted BY THE RUST STRUCT, not by this encoder --
// see binding_bytes_are_stable_for_the_js_encoder in contracts/vault/src/tests.rs.
// A self-generated fixture would prove only that the encoder is consistent
// with itself, which is exactly the bug this guards against: a mismatch makes
// every signature fail to verify and is indistinguishable from a wrong key.
const RUST_BYTES =
  "0f0000007661756c742e746573742e6e6561720700000000000000d202964900000000050000007265712d310e000000757364632e746573742e6e65617200e1f50500000000000000000000000003000000626f6202000000686900";

test("the JS encoder reproduces the Rust binding byte for byte", () => {
  const js = encodeBinding({
    vault: "vault.test.near",
    nonce: 7,
    deadlineNs: 1234567890,
    requestId: "req-1",
    token: "usdc.test.near",
    amount: 100000000n,
    recipient: "bob",
    memo: "hi",
    route: "NearDirect",
  }).toString("hex");
  assert.equal(js, RUST_BYTES);
});

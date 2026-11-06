import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffLinks } from "../bin/handoff.mjs";

/**
 * Links for the things a human still has to do, and for checking the rest.
 *
 * WHAT THIS IS *NOT*. Outlayer's pattern is a URL into their own hosted app
 * with the amount, token and recipient pre-baked — `app.outlayer.ai/wallet/
 * fund?to=…&amount=…`. Float cannot do that: there is no hosted Float app for
 * a NEAR vault. The `usefloat.xyz` domains vendored into apps/dashboard were
 * checked on 2026-10-29 and all three are UNREACHABLE, and that dashboard's
 * skill.md is the Solana product's (Phantom, Solscan, float_pay to a Solana
 * address). Emitting links there would send users somewhere that cannot help
 * them, which is worse than printing a command.
 *
 * The funding handoff is also largely MOOT now: the wizard registers and funds
 * the vault itself. What is left for a human is acquiring the token in the
 * first place, and being able to SEE what the wizard did rather than trust the
 * output scrolling past.
 *
 * So every destination here is one that exists and was verified live, and
 * every link carries a sentence saying what it is for. That second rule is
 * Outlayer's, and it is the good part: "a bare URL from an agent asking for
 * account access is what a phishing attempt looks like."
 */

const base = {
  vault: "float.test015.near",
  owner: "test015.near",
  token: "usdc.near",
  network: "mainnet",
  canFundFromOwner: true,
  agentIds: [],
};

test("every link carries a reason — never a bare URL", () => {
  for (const l of handoffLinks(base)) {
    assert.ok(l.why && l.why.length > 10, `${l.label} has no explanation`);
    assert.ok(l.url.startsWith("https://"), `${l.label} is not https`);
  }
});

test("the vault is linked on the explorer, so the user can verify rather than trust", () => {
  const l = handoffLinks(base).find((x) => x.url.includes("float.test015.near"));
  assert.ok(l, "the vault should be linked");
  assert.equal(l.url, "https://explorer.near.org/accounts/float.test015.near");
});

test("testnet uses the testnet explorer, not mainnet's", () => {
  // Linking a testnet account to the mainnet explorer shows "account does not
  // exist", which reads as "the wizard failed".
  const l = handoffLinks({ ...base, network: "testnet", vault: "v.me.testnet" })
    .find((x) => x.url.includes("v.me.testnet"));
  assert.equal(l.url, "https://explorer.testnet.near.org/accounts/v.me.testnet");
});

test("agent accounts are linked too, each one", () => {
  const ls = handoffLinks({ ...base, agentIds: ["r1.float.test015.near", "r2.float.test015.near"] });
  for (const id of ["r1.float.test015.near", "r2.float.test015.near"]) {
    assert.ok(ls.some((l) => l.url.endsWith(`/accounts/${id}`)), `${id} not linked`);
  }
});

test("NO LINK EVER CARRIES A SECRET", () => {
  // The whole category of mistake this guards: a key, seed phrase or signature
  // in a query string ends up in browser history, server logs and referrers.
  // Outlayer's rule, worth copying verbatim: the pages encrypt in the browser
  // "precisely so that nobody — you, us, the page — holds the value".
  const ls = handoffLinks({
    ...base,
    agentIds: ["r1.float.test015.near"],
    // Deliberately passed to prove they cannot leak into a URL even if a caller
    // hands them over.
    agentSecret: "ed25519:4rBrHt9c6cCDaWpJcKqnyS8sB7FsKqKgbzMHJ3YfNkTq",
    seedPhrase: "correct horse battery staple",
  });
  for (const l of ls) {
    assert.doesNotMatch(l.url, /ed25519:/, `${l.label} leaks a key`);
    assert.doesNotMatch(l.url, /correct horse/, `${l.label} leaks a seed phrase`);
    assert.doesNotMatch(l.url, /secret|private|seed|mnemonic/i, `${l.label} smells of a secret`);
  }
});

test("when the owner cannot fund, a way to GET the token is offered", () => {
  const ls = handoffLinks({ ...base, canFundFromOwner: false });
  assert.ok(
    ls.some((l) => /get|acquire|bridge|swap/i.test(l.label)),
    "should offer somewhere to obtain the token",
  );
});

test("when the owner CAN fund, no acquire-tokens link is shown", () => {
  // The wizard already funded it. Telling them to go buy more is noise.
  const ls = handoffLinks({ ...base, canFundFromOwner: true });
  assert.ok(!ls.some((l) => /get|acquire|bridge|swap/i.test(l.label)));
});

test("on testnet no cross-chain acquisition is suggested — Intents is mainnet-only", () => {
  // packages/mcp/src/quote.ts:27. Sending a testnet user to a mainnet swap UI
  // wastes their time and teaches them the product is broken.
  const ls = handoffLinks({ ...base, network: "testnet", canFundFromOwner: false });
  assert.ok(!ls.some((l) => l.url.includes("near-intents.org")));
});

test("links are stable and de-duplicated", () => {
  const ls = handoffLinks({ ...base, agentIds: ["r1.float.test015.near", "r1.float.test015.near"] });
  const urls = ls.map((l) => l.url);
  assert.equal(new Set(urls).size, urls.length, "a duplicate link is clutter");
});

test("the token is named by SYMBOL, not by its account id", () => {
  // Found by rendering with the real mainnet token. Circle USDC on NEAR is
  // `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, so
  // "Get <account id>" is a 64-character hex string in a sentence meant to
  // help. The wizard already read the symbol from ft_metadata at step 2.
  const ls = handoffLinks({
    ...base,
    token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    symbol: "USDC",
    canFundFromOwner: false,
  });
  const get = ls.find((l) => /^Get /.test(l.label));
  assert.equal(get.label, "Get USDC");
  assert.doesNotMatch(get.why, /17208628/, "the raw id does not belong in prose either");
});

test("with no symbol available it falls back to the account id rather than printing undefined", () => {
  const ls = handoffLinks({ ...base, token: "usdc.near", symbol: undefined, canFundFromOwner: false });
  assert.equal(ls.find((l) => /^Get /.test(l.label)).label, "Get usdc.near");
});

import { describe, it, expect } from "vitest";
import { isUnavailable } from "./unavailable.js";

/**
 * THE BUG THIS EXISTS TO HAVE CAUGHT, measured live on 2026-11-09.
 *
 * `/v1/resolve` ended both of its chain reads with `.catch(() => null)` and
 * `.catch(() => false)`, so a transient RPC failure became a STATEMENT OF
 * FACT:
 *
 *   vault_id_for threw  -> vault: null  -> "No legal vault id for that
 *                                          account. An implicit account (64
 *                                          hex characters) cannot have one."
 *   accountExists threw -> exists:false -> "you do not have a vault yet"
 *
 * Both were sent with HTTP 200, so the dashboard proxy — which deliberately
 * does not cache a FAILURE — cached them as answers for the life of the
 * process.
 *
 * It was not hypothetical and it was not rare. Six identical calls against a
 * running adapter returned four correct answers and two `vault: null`s,
 * because the adapter's own background refusal-follower saturates its RPC
 * budget and competes with request handling. `exists` flickered false->true
 * across the same run.
 *
 * The user-visible result is the worst possible one: somebody who OWNS a
 * populated vault is shown the create-one empty state and invited to create a
 * vault that already exists.
 *
 * "The chain said no" and "I could not ask the chain" are different answers
 * and must never share a code path.
 */
describe("isUnavailable", () => {
  it("treats an RPC HTTP failure as UNAVAILABLE, not as an answer", () => {
    // The exact shape viewFunction throws: `RPC <url> returned HTTP 429`.
    for (const code of [429, 500, 502, 503, 504, 408]) {
      expect(
        isUnavailable(new Error(`RPC https://test.rpc.fastnear.com returned HTTP ${code}`)),
        `HTTP ${code}`,
      ).toBe(true);
    }
  });

  it("treats a transport error as UNAVAILABLE", () => {
    for (const m of [
      "fetch failed",
      "getaddrinfo ENOTFOUND test.rpc.fastnear.com",
      "connect ECONNREFUSED 127.0.0.1:3030",
      "The operation was aborted due to timeout",
      "socket hang up",
      "ETIMEDOUT",
    ]) {
      expect(isUnavailable(new Error(m)), m).toBe(true);
    }
  });

  it("treats a DEPRECATED-endpoint refusal as UNAVAILABLE", () => {
    // rpc.testnet.near.org answers -429 with this. Measured 2026-11-09.
    expect(
      isUnavailable(new Error("WARNING! THIS ENDPOINT IS DEPRECATED! STOP USING IT NOW!")),
    ).toBe(true);
  });

  it("does NOT treat a contract panic as unavailable — that IS an answer", () => {
    // A BAD_LABEL panic or an UnknownAccount means the chain replied. Calling
    // that "unavailable" would retry forever instead of reporting it.
    for (const m of [
      "Smart contract panicked: BAD_LABEL: a label must be 1-16 characters of a-z or 0-9",
      "account flatdata6673.testnet does not exist while viewing",
      "MethodNotFound",
      "wasm execution failed",
    ]) {
      expect(isUnavailable(new Error(m)), m).toBe(false);
    }
  });

  it("does not crash on a non-Error throw", () => {
    // `throw "string"` is legal, and a classifier that assumes .message turns
    // a small bug into an unhandled one.
    expect(isUnavailable("fetch failed")).toBe(true);
    expect(isUnavailable(undefined)).toBe(false);
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable({ nope: 1 })).toBe(false);
  });

  it("is case-insensitive, because providers do not agree on casing", () => {
    expect(isUnavailable(new Error("Fetch Failed"))).toBe(true);
    expect(isUnavailable(new Error("rpc https://x returned http 429"))).toBe(true);
  });

  it("does NOT classify a 4xx that is a real refusal as unavailable", () => {
    // 400 means the request was wrong — retrying sends the same wrong request.
    // 429 is the exception and is listed above deliberately.
    expect(isUnavailable(new Error("RPC https://x returned HTTP 400"))).toBe(false);
    expect(isUnavailable(new Error("RPC https://x returned HTTP 404"))).toBe(false);
  });

  it("recognises a THROTTLE that arrives as HTTP 200 with a JSON error body", () => {
    // The case that broke the live dashboard. fastnear answers a rate limit
    // with 200 and `{"code": -429, "message": "Rate limits exceeded..."}`, so
    // `r.ok` is true and nothing downstream looks like a transport failure.
    // accountExists then throws this, and it matched nothing:
    expect(
      isUnavailable(
        new Error(
          "could not determine whether flatdata6673-testnet.fac.floatv4.testnet exists: " +
            "Rate limits exceeded. For higher rate limits get a subscription at https://fastnear.com",
        ),
      ),
    ).toBe(true);
  });

  it("treats 'could not determine whether' as uncertainty, always", () => {
    // accountExists returns false WITHOUT throwing for a real absence, so it
    // only ever throws when it cannot tell. That wording is never a verdict.
    expect(isUnavailable(new Error("could not determine whether x.near exists: whatever"))).toBe(true);
  });

  it("still calls a genuine UNKNOWN_ACCOUNT an answer, not an outage", () => {
    // This one must NOT be unavailable: it is the real "no such account",
    // which is how the create-one empty state is reached legitimately.
    expect(isUnavailable(new Error("UNKNOWN_ACCOUNT"))).toBe(false);
  });

  it("recognises the bare rate-limit wordings providers use", () => {
    for (const m of ["Rate limits exceeded", "rate limit reached", "Too Many Requests", "error -429"]) {
      expect(isUnavailable(new Error(m)), m).toBe(true);
    }
  });
});

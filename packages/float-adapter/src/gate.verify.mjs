/**
 * Exercise the adapter's auth gate across the cases the public deploy depends on.
 *
 * Reads the TypeScript via the compiled dist so this needs no loader, and so it
 * tests the artifact the server actually runs rather than a parallel compile.
 */
import { authorize } from "../dist/gate.js";

const CASES = [
  { method: "GET", path: "/v1/dashboard", token: undefined, authHeader: undefined,
    want: true, label: "read, no token configured" },
  { method: "POST", path: "/v1/owner-plan", token: undefined, authHeader: undefined,
    want: true, label: "owner-plan, no token (it signs nothing)" },
  { method: "POST", path: "/v1/pay", token: undefined, authHeader: undefined,
    want: false, label: "PAY, no token configured -> cannot spend" },
  { method: "POST", path: "/v1/pay", token: "s3cret", authHeader: undefined,
    want: false, label: "PAY, token configured, none presented" },
  { method: "POST", path: "/v1/pay", token: "s3cret", authHeader: "Bearer wrong",
    want: false, label: "PAY, wrong token presented" },
  { method: "POST", path: "/v1/pay", token: "s3cret", authHeader: "Bearer s3cret",
    want: true, label: "PAY, correct token presented" },
  /**
   * "GATED" MEANS SUBJECT TO THE TOKEN CHECK, NOT ALWAYS DENIED.
   *
   * The first version of this case presented a CORRECT token and expected a
   * refusal, then reported the code as wrong when it allowed the request —
   * which was the right behaviour. An omitted path must not be treated as the
   * `SIGNS_NOTHING` exemption; it still has to satisfy the token. Both halves
   * are asserted, because only the pair distinguishes "gated" from "denied".
   */
  { method: "POST", path: undefined, token: undefined, authHeader: undefined,
    want: false, label: "path omitted, no token -> SHUT (not treated as exempt)" },
  { method: "POST", path: undefined, token: "s3cret", authHeader: "Bearer s3cret",
    want: true, label: "path omitted, correct token -> passes the gate it was held to" },
  { method: "POST", path: "/v1/owner-plan/extra", token: undefined, authHeader: undefined,
    want: false, label: "owner-plan PREFIX does not inherit the exemption" },
];

let bad = 0;
for (const c of CASES) {
  const r = authorize({ method: c.method, path: c.path, authHeader: c.authHeader, token: c.token });
  const ok = Boolean(r.ok) === c.want;
  if (!ok) bad += 1;
  console.log(
    `  ${ok ? "ok  " : "BAD "} ${(r.ok ? "OPEN" : `SHUT ${r.status}`).padEnd(9)} ${c.label}`,
  );
}

console.log(
  bad === 0
    ? `${String.fromCharCode(10)}  all ${CASES.length} gate cases behave as designed`
    : `${String.fromCharCode(10)}  ${bad} case(s) WRONG`,
);
if (bad) process.exitCode = 1;

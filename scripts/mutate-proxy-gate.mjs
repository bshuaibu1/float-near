/**
 * Mutation check for the dashboard proxy's gate.
 *
 * WHY THIS SUITE EXISTS AT ALL. The adapter's gate was changed from
 * per-METHOD to per-ROUTE so a hosted, token-less box could still offer owner
 * actions. The proxy IN FRONT of it was left gating by method, so
 * `/v1/owner-plan` was refused 503 here and never reached the adapter: the fix
 * was real and completely bypassed. Nothing in any suite noticed, because the
 * decision was three inline `if`s in a Next.js route handler that no test
 * could reach. It was caught by running a token-less stack locally and curling
 * it — which is not a thing that happens on every change.
 *
 * So the decision moved to lib/proxy-gate.ts and these are the mutants that
 * must not survive. M1 and M2 are the sharpest: they are the two shapes of the
 * original bug, in both directions.
 *
 * Mutating a hosted security boundary needs the revert to be exact, so the
 * byte-identical check at the end is load-bearing, not decoration.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const p = "apps/dashboard/lib/proxy-gate.ts";
const orig = readFileSync(p, "utf8");

const MUTANTS = [
  {
    name: "M1 the allowlist is empty, so owner actions die on a token-less public box",
    from: 'const SIGNS_NOTHING: ReadonlySet<string> = new Set(["v1/owner-plan"]);',
    to: "const SIGNS_NOTHING: ReadonlySet<string> = new Set([]);",
  },
  {
    name: "M2 /v1/pay joins the allowlist, so the internet can spend from the vault",
    from: 'const SIGNS_NOTHING: ReadonlySet<string> = new Set(["v1/owner-plan"]);',
    to: 'const SIGNS_NOTHING: ReadonlySet<string> = new Set(["v1/owner-plan", "v1/pay"]);',
  },
  {
    name: "M3 a missing token is forwarded anyway, so /v1/pay reaches the adapter unauthenticated",
    from: "  if (!input.hasToken) {",
    to: "  if (false) {",
  },
  {
    name: "M4 the token is attached to the open route too, re-coupling it to a secret",
    from: '    return { kind: "forward", attachToken: false, mayResolveVault: true };\n  }\n\n  if (!input.hasToken) {',
    to: '    return { kind: "forward", attachToken: true, mayResolveVault: true };\n  }\n\n  if (!input.hasToken) {',
  },
  {
    name: "M5 /v1/pay may resolve a vault, so one vault's key is asked to spend from another's",
    from: '  return { kind: "forward", attachToken: true, mayResolveVault: false };',
    to: '  return { kind: "forward", attachToken: true, mayResolveVault: true };',
  },
  {
    name: "M6 prefix matching, so /v1/owner-plan/anything inherits the exemption",
    from: "  if (SIGNS_NOTHING.has(input.path)) {",
    to: "  if ([...SIGNS_NOTHING].some((r) => input.path.startsWith(r))) {",
  },
  {
    name: "M7 the method is not normalised, so a lowercase verb is treated as mutating",
    from: "  const method = input.method.toUpperCase();",
    to: "  const method = input.method;",
  },
];

let survived = 0;
for (const m of MUTANTS) {
  if (!orig.includes(m.from)) {
    console.log(`  SKIP (pattern absent)  ${m.name}`);
    survived++;
    continue;
  }
  writeFileSync(p, orig.replace(m.from, m.to));
  let verdict;
  try {
    execSync("npx vitest run lib/proxy-gate.test.ts", {
      cwd: "apps/dashboard",
      stdio: "pipe",
    });
    verdict = "SURVIVED <-- NOT COVERED";
    survived++;
  } catch {
    verdict = "killed";
  }
  console.log(`  ${verdict.padEnd(22)} ${m.name}`);
}

writeFileSync(p, orig);
const identical = readFileSync(p, "utf8") === orig;
console.log(`  reverted byte-identical: ${identical}`);
if (!identical) process.exit(1);

/**
 * Remove the last Solana surface from the dashboard.
 *
 * `/link` and `/auth/callback` are from Solana Float, the previous CUSTODIAL
 * product. The flow was: CLI POSTs /v1/link-sessions, opens the browser, the
 * user signs a MESSAGE with Phantom, and the server then provisions their
 * wallet and treasury via Dynamic.
 *
 * NEAR Float deliberately does not do this. From docs/DESIGN-browser-signing-flow.md:
 *
 *   "The backend is load-bearing there because Solana Float is custodial."
 *
 *   "The CLI polls the chain rather than our API. The moment a link-session
 *    API sits in that path, every onboarding inherits our uptime. That is a
 *    real guarantee to give away for convenience we do not need."
 *
 * So /v1/link-sessions 404s because it was never meant to be built, and the
 * page has been rendering that error to anyone who found the URL.
 *
 * Measured cost of keeping them: /link was 240 kB First Load JS and
 * /auth/callback 233 kB, against 103-121 kB for every other route - they were
 * the two heaviest pages in the app, entirely because of the Phantom SDK.
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

// --- 1. the routes --------------------------------------------------------
for (const dir of ["apps/dashboard/app/link", "apps/dashboard/app/auth"]) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`  removed ${dir}`);
  }
}

// --- 2. they were listed as public routes --------------------------------
{
  const p = "apps/dashboard/components/app-shell.tsx";
  const raw = readFileSync(p, "utf8");
  const crlf = raw.includes(CRLF);
  let s = raw.split(CRLF).join(LF);
  const from = 'const PUBLIC_PATHS = ["/link", "/auth/callback", "/setup"];';
  const to = [
    "// /link and /auth/callback were here too. Both were Solana-era: they",
    "// connected a Phantom wallet so a custodial backend could provision an",
    "// account. NEAR Float has no such backend, by design.",
    'const PUBLIC_PATHS = ["/setup"];',
  ].join(LF);
  if (!s.includes(from)) throw new Error("PUBLIC_PATHS not found in the expected shape");
  s = s.replace(from, to);
  writeFileSync(p, crlf ? s.split(LF).join(CRLF) : s);
  console.log("  app-shell: PUBLIC_PATHS trimmed");
}

// --- 3. the dependencies --------------------------------------------------
{
  const p = "apps/dashboard/package.json";
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  const drop = ["@phantom/browser-sdk", "@phantom/react-sdk", "@solana/spl-token"];
  const removed = [];
  for (const d of drop) {
    if (pkg.dependencies?.[d]) {
      delete pkg.dependencies[d];
      removed.push(d);
    }
    if (pkg.devDependencies?.[d]) {
      delete pkg.devDependencies[d];
      removed.push(d);
    }
  }
  writeFileSync(p, JSON.stringify(pkg, null, 2) + LF);
  console.log(`  package.json: dropped ${removed.join(", ")}`);
}

// --- 4. scripts that only existed to edit /link --------------------------
for (const f of ["scripts/link-visible-polling.mjs", "scripts/link-stopped-message.mjs"]) {
  if (existsSync(f)) {
    rmSync(f);
    console.log(`  removed ${f}`);
  }
}

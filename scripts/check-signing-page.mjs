/**
 * Does the signing page actually serve?
 *
 * WHAT STARTED THIS. Wiring a real signature through the /agents freeze
 * ended at a dead tab: "Sign in wallet" pointed at 127.0.0.1:8080 with
 * nothing listening. Every piece was individually tested and the JOIN between
 * them was not, which is the whole reason "it has never had a real signature
 * through it" was worth saying out loud.
 *
 * WHAT THIS CAN AND CANNOT CATCH, because the difference matters and the
 * honest version is narrower than it sounds:
 *
 *   It CANNOT tell you nobody started the server. That is the state the
 *   original defect was in, and it is a property of someone's machine at a
 *   moment, not of the repo. A build gate has no business asserting it.
 *
 *   It CAN tell you the server would fail if you did start it: a syntax
 *   error in serve.mjs, a missing font, a MIME type the browser will refuse,
 *   a filename that drifted. Those are repo facts, and every one of them
 *   produces the same symptom as a dead port.
 *
 * So it boots the real server on an ephemeral port, asks it for the page and
 * every local asset the page references, and shuts it down. No fixtures, no
 * mock: the thing being tested is the thing that runs.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PAGE = resolve(ROOT, "web", "index.html");

/** An OS-assigned free port, so a run never collides with a live stack. */
function freePort() {
  return new Promise((ok, no) => {
    const s = createServer();
    s.on("error", no);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok || res.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

/**
 * Every local asset the page asks for.
 *
 * Parsed OUT OF THE PAGE rather than listed here. A hardcoded list silently
 * stops covering a font the moment someone adds one, and the font is exactly
 * what went missing last time: the page falls back to the system stack and
 * looks almost right, which is the failure that started the redesign.
 */
function localAssets() {
  const html = readFileSync(PAGE, "utf8");
  const out = new Set();
  for (const m of html.matchAll(/url\("([^"]+)"\)/g)) out.add(m[1]);
  for (const m of html.matchAll(/(?:src|href)="(?!https?:|\/\/|#|data:)([^"]+)"/g)) {
    out.add(m[1].replace(/^\.\//, ""));
  }
  return [...out];
}

const EXPECT_TYPE = {
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const problems = [];
const port = await freePort();

const child = spawn(process.execPath, ["web/serve.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d));

try {
  if (!(await waitForPort(port))) {
    problems.push(`the server never came up on :${port}${stderr ? `\n       ${stderr.trim()}` : ""}`);
  } else {
    // 1. The page itself.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const body = await res.text();
    if (!res.ok) problems.push(`GET / returned HTTP ${res.status}`);
    // Must-contain, not just 200: a static server happily returns an empty
    // file, and "the port answered" is not "the page is there".
    if (!/<h1 id="title">/.test(body)) problems.push("GET / did not return the signing page");
    if (!/OWNER_METHODS/.test(body)) problems.push("the page has no owner-method whitelist");

    // 2. Every asset it references, with the type the browser needs. A woff2
    //    served as text/html fetches fine and renders nothing.
    for (const asset of localAssets()) {
      if (!existsSync(resolve(ROOT, "web", asset))) {
        problems.push(`${asset} is referenced by the page but missing from web/`);
        continue;
      }
      const r = await fetch(`http://127.0.0.1:${port}/${asset}`);
      if (!r.ok) {
        problems.push(`${asset} -> HTTP ${r.status}`);
        continue;
      }
      const ext = asset.slice(asset.lastIndexOf("."));
      const want = EXPECT_TYPE[ext];
      const got = (r.headers.get("content-type") || "").split(";")[0];
      if (want && got !== want) problems.push(`${asset} served as "${got}", browser needs "${want}"`);
    }
  }
} finally {
  child.kill();
}

/**
 * 3. STATIC: the two ends must agree on a port.
 *
 * The dashboard builds links against SIGN_BASE and the server binds PORT.
 * Nothing connects them, so changing one leaves every "Sign in wallet" link
 * pointing at a port nobody is on - which is the dead tab again, this time
 * caused by the repo rather than by a human forgetting.
 */
const signSrc = readFileSync(resolve(ROOT, "apps/dashboard/lib/sign-link.ts"), "utf8");
const serveSrc = readFileSync(resolve(ROOT, "web/serve.mjs"), "utf8");
const signPort = signSrc.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
const servePort = serveSrc.match(/process\.env\.PORT \?\? (\d+)/)?.[1];
if (!signPort) problems.push("could not find the dashboard's default sign URL");
if (!servePort) problems.push("could not find serve.mjs's default port");
if (signPort && servePort && signPort !== servePort) {
  problems.push(
    `the dashboard links to :${signPort} but serve.mjs defaults to :${servePort}`,
  );
}

if (problems.length) {
  for (const p of problems) console.log(`  BROKEN  ${p}`);
  console.log(`${problems.length} problem(s) with the signing page`);
  process.exit(1);
}
console.log(
  `  signing page serves, ${localAssets().length} asset(s) resolve, ports agree on :${signPort}`,
);

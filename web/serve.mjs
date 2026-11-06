#!/usr/bin/env node
/**
 * Serve the create page locally, with the contract beside it.
 *
 * A plain static server because the page is plain static: the whole browser
 * flow is designed to need no backend, and starting one here would hide
 * whether that is actually true. If this can serve it, GitHub Pages can.
 *
 * The one thing it must get right is the wasm: a 294 KB binary served with the
 * wrong content type still fetches, but shipping a server that lies about
 * types invites a later bug in whatever copies it.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const HERE = resolve(import.meta.dirname);
const ROOT = resolve(HERE, "..");
/**
 * 8080, NOT 8787.
 *
 * 8787 belongs to the float-adapter — it is the port every dashboard page
 * defaults to (`NEXT_PUBLIC_FLOAT_API_URL`), and `deploy-vps.sh` deploys the
 * adapter there. This page squatted it for a while and nothing broke only
 * because the two were never run together; the moment the dashboard came up
 * it would have been talking to a static file server instead of the API, and
 * the symptom would have been every panel empty rather than a port error.
 *
 * This page is the newcomer, so this page moves.
 */
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".wasm": "application/wasm",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  // The Float mark. Without a type the browser sniffs, and a logo that
  // sometimes renders and sometimes downloads is the kind of thing that
  // looks like a broken page rather than a missing header.
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  /**
   * Geist, self-hosted.
   *
   * The dashboard renders in Geist; this page rendered in the system stack.
   * So the screen where someone is asked to SIGN looked like a different
   * product from the one they arrived from, and visual discontinuity is what
   * people are trained to read as phishing.
   *
   * From web/fonts rather than a CDN, deliberately: this page loads no
   * external resource at all, and a signing surface is the last place to
   * start. 200 KB of woff2 is a fair price for that.
   */
  ".woff2": "font/woff2",
};

// The contract is NOT copied into web/ — it is read from the package that
// ships it, so the page cannot serve a stale artifact while create-float
// ships a different one. One source of bytes.
const WASM = join(ROOT, "packages", "create-float", "res", "vault.wasm");
if (!existsSync(WASM)) {
  console.error(`FATAL: ${WASM} not found.`);
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let file;
  if (url.pathname === "/vault.wasm") file = WASM;
  else if (url.pathname === "/" || url.pathname === "/index.html") file = join(HERE, "index.html");
  else file = join(HERE, url.pathname.replace(/^\//, ""));

  if (!file.startsWith(HERE) && file !== WASM) {
    res.writeHead(403).end("no");
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}).listen(PORT, () => {
  const bytes = readFileSync(WASM).length;
  console.log(`\n  create page   http://127.0.0.1:${PORT}/`);
  console.log(`  contract      ${bytes} bytes (${(bytes / 1024).toFixed(0)} KB), served from`);
  console.log(`                packages/create-float/res/vault.wasm`);
  console.log(`\n  testnet:  http://127.0.0.1:${PORT}/?network=testnet&factory=<factory-account>`);
  console.log(`\n  The factory is REQUIRED. A wallet refuses a DeployContract action`);
  console.log(`  from a dApp (measured in Meteor), so the 294 KB contract travels as`);
  console.log(`  an ARGUMENT to an ordinary method call instead.`);
  console.log(`\n  Ctrl-C to stop.\n`);
});

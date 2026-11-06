/**
 * Render the /agents freeze action as a signing link instead of a command to
 * copy into a terminal.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

const p = "apps/dashboard/app/agents/page.tsx";
const raw = readFileSync(p, "utf8");
const WAS_CRLF = raw.includes(CRLF);
let s = raw.split(CRLF).join(LF);

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

const OLD = [
  "          {plan && (",
  '            <div className="mt-4 bg-card border border-line rounded-xl shadow-[0_1px_2px_rgba(17,17,17,0.04)] p-4">',
  '              <div className="mb-2 flex items-center justify-between">',
  '                <p className="text-[11px] font-semibold text-ink">',
  "                  {plan.label}",
  "                </p>",
  "                <button",
  "                  onClick={() => {",
  "                    void navigator.clipboard.writeText(plan.cli);",
  "                    setCopied(true);",
  "                    setTimeout(() => setCopied(false), 2000);",
  "                  }}",
  '                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2 py-1 text-[11px] font-medium text-ink transition-colors hover:bg-chip"',
  "                >",
  "                  {copied ? <Check size={11} /> : <Copy size={11} />}",
  '                  {copied ? "Copied" : "Copy"}',
  "                </button>",
  "              </div>",
  "              <pre",
  '                className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[10.5px] leading-5 text-muted">',
  "                {plan.cli}",
  "              </pre>",
  '              <p className="mt-2 text-[11px] text-muted">',
  "                Owner methods are never signed by this dashboard — it can only ever hold an agent",
  "                key.",
  "              </p>",
  "            </div>",
  "          )}",
].join(LF);

const NEW = [
  "          {planError && (",
  '            <p className="mt-4 text-[12px]" style={{ color: "#9F2F2D" }}>',
  "              {planError}",
  "            </p>",
  "          )}",
  "",
  "          {/* A LINK, not a command.",
  "              This panel used to print a near-cli invocation ending in",
  "              `sign-with-keychain`, which reads the local keychain. The owner",
  "              of this vault keeps their key in a browser wallet, so following",
  "              that instruction meant exporting a private key to disk - the",
  "              exact trade this product exists to remove. The link carries the",
  "              same payload to a page that holds the wallet connection and",
  "              refuses unless get_config().owner matches. */}",
  "          {plan && (",
  '            <div className="mt-4 bg-card border border-line rounded-xl shadow-[0_1px_2px_rgba(17,17,17,0.04)] p-4">',
  '              <div className="flex flex-wrap items-baseline gap-x-2">',
  '                <p className="text-[13px] font-semibold text-ink">{plan.label}</p>',
  '                <span className="font-mono text-[10.5px] text-faint">',
  "                  {plan.payload.methodName}",
  "                </span>",
  "              </div>",
  "",
  "              {/* The human diff. The raw args stay available but collapsed:",
  '                  {"node_id":1,"frozen":true} is precise and unreadable. */}',
  '              <p className="mt-1.5 flex flex-wrap items-baseline gap-1.5 text-[12px]">',
  '                <span className="text-muted">Status</span>',
  '                <span className="text-faint line-through">{plan.from}</span>',
  '                <span className="text-faint">{"->"}</span>',
  '                <span className="font-medium text-ink">{plan.to}</span>',
  "              </p>",
  "",
  '              <details className="mt-2">',
  '                <summary className="cursor-pointer text-[11px] text-faint hover:text-muted">',
  "                  Exact arguments",
  "                </summary>",
  '                <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-chip p-2.5 font-mono text-[10.5px] leading-5 text-muted">',
  "                  {JSON.stringify(plan.payload.args, null, 2)}",
  "                </pre>",
  "              </details>",
  "",
  '              <div className="mt-3 flex flex-wrap items-center gap-2">',
  "                <a",
  '                  href={signLink(plan.payload, info?.network ?? "testnet")}',
  '                  target="_blank"',
  '                  rel="noopener noreferrer"',
  '                  className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"',
  "                >",
  "                  Sign in wallet",
  "                  <ExternalLink size={12} />",
  "                </a>",
  "                <button",
  "                  onClick={() => {",
  '                    void navigator.clipboard.writeText(signLink(plan.payload, info?.network ?? "testnet"));',
  "                    setCopied(true);",
  "                    setTimeout(() => setCopied(false), 2000);",
  "                  }}",
  '                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-card px-2.5 py-2 text-[11px] font-medium text-ink transition-colors hover:bg-chip"',
  "                >",
  "                  {copied ? <Check size={11} /> : <Copy size={11} />}",
  '                  {copied ? "Copied" : "Copy link"}',
  "                </button>",
  "              </div>",
  '              <p className="mt-2.5 text-[11px] leading-5 text-faint">',
  "                The signing page checks the wallet you connect owns this vault.",
  "              </p>",
  "            </div>",
  "          )}",
].join(LF);

must(OLD, NEW, "plan panel");

writeFileSync(p, WAS_CRLF ? s.split(LF).join(CRLF) : s);
console.log(`  /agents renders a signing link (CRLF preserved: ${WAS_CRLF})`);

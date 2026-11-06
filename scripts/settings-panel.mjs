/**
 * Render the prepared pause, and retire the email field.
 *
 * The email input POSTed to a handler that ignores the body and hardcodes
 * notificationEmail to null - a POST and a GET return byte-identical JSON -
 * yet the button turned green and said "Saved". Nothing anywhere stores an
 * address, so there is no notification to receive. A control that cannot work
 * is worse than an absent one: it buys trust it cannot honour.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;

const p = "apps/dashboard/app/settings/page.tsx";
const raw = readFileSync(p, "utf8");
const crlf = raw.includes(CRLF);
let lines = raw.split(CRLF).join(LF).split(LF);

const find = (re, what, from = 0) => {
  const i = lines.findIndex((l, idx) => idx >= from && re.test(l));
  if (i < 0) throw new Error(`not found: ${what}`);
  return i;
};

// --- 1. the signing panel, after the danger-zone card ---------------------
{
  // The card closes with two dedenting divs right before the wrapper's close.
  const anchor = find(/Prepare pause/, "prepare button");
  // Walk forward to the end of the danger-zone card: the line `        </div>`
  // that closes it, which is followed by a blank line and `      </div>`.
  let i = anchor;
  while (i < lines.length && !/^        <\/div>$/.test(lines[i])) i++;
  if (i >= lines.length) throw new Error("danger card close not found");

  lines.splice(
    i + 1,
    0,
    "",
    "        {/* A LINK, not a claim.",
    "            The button above no longer performs anything - it prepares a",
    "            transaction. Nothing is paused until this is signed, and saying",
    "            so is the entire point: the version this replaced reported",
    "            success without sending a single request that worked. */}",
    "        {pausePlan && (",
    '          <div className="mt-4 rounded-lg border border-line bg-card p-4">',
    '            <p className="text-[13px] font-semibold text-ink">Ready to sign</p>',
    '            <p className="mt-1 text-[12px] text-muted">',
    "              {pausePlan.summary ?? pausePlan.methodName}",
    "            </p>",
    '            <div className="mt-3 flex flex-wrap items-center gap-2">',
    "              <a",
    "                href={signLink(pausePlan, network)}",
    '                target="_blank"',
    '                rel="noopener noreferrer"',
    '                className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3.5 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"',
    "              >",
    "                Sign in wallet",
    "                <ExternalLink size={12} />",
    "              </a>",
    "              <button",
    "                onClick={() => setPausePlan(null)}",
    '                className="text-[12px] text-muted transition-colors hover:text-ink"',
    "              >",
    "                Cancel",
    "              </button>",
    "            </div>",
    '            <p className="mt-2.5 text-[11px] leading-5 text-faint">',
    "              Nothing is paused until this is signed. The signing page checks the wallet",
    "              you connect owns this vault.",
    "            </p>",
    "          </div>",
    "        )}",
  );
}

// --- 2. retire the email row ----------------------------------------------
{
  const secStart = find(/<Section title="Account"/, "account section");
  let secEnd = secStart;
  while (secEnd < lines.length && !/<\/Section>/.test(lines[secEnd])) secEnd++;
  if (secEnd >= lines.length) throw new Error("account section close not found");

  const indent = lines[secStart].match(/^\s*/)[0];
  lines.splice(
    secStart,
    secEnd - secStart + 1,
    `${indent}{/* The email field is gone.`,
    `${indent}    It POSTed to /v1/settings, whose handler ignores the body and`,
    `${indent}    returns notificationEmail: null - a POST and a GET produce`,
    `${indent}    byte-identical JSON. Nothing stored an address, so no`,
    `${indent}    notification could ever arrive, yet the button went green and`,
    `${indent}    said "Saved". A control that cannot work is worse than an`,
    `${indent}    absent one: it buys trust it cannot honour. */}`,
    `${indent}<Section title="Account" description="Who owns this vault.">`,
    `${indent}  <Row label="Owner" description="The only account that can change a policy or pause the vault." last>`,
    `${indent}    <span className="font-mono text-[12px] text-ink">{ownerWallet || "-"}</span>`,
    `${indent}  </Row>`,
    `${indent}</Section>`,
  );
}

writeFileSync(p, crlf ? lines.join(LF).split(LF).join(CRLF) : lines.join(LF));
console.log("  settings: signing panel added, email field retired");

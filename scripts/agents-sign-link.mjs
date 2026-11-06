/**
 * Replace the /agents CLI string with a signing link.
 *
 * The page's freeze action rendered `plan.cli`:
 *
 *     near contract call-function as-transaction <vault> freeze_node
 *       json-args '...' prepaid-gas '100.0 Tgas'
 *       attached-deposit '1 yoctoNEAR'
 *       sign-as <YOUR-OWNER-ACCOUNT> network-config testnet
 *       sign-with-keychain send
 *
 * `sign-with-keychain` reads the local near-cli keychain. This vault's owner
 * is work12.testnet, whose key lives in a browser wallet - there is no
 * credential for it under ~/.near-credentials, which was checked. So the only
 * owner action on this page could not be performed by the owner without first
 * exporting a private key to disk, which is the one thing this product exists
 * to make unnecessary.
 *
 * /policies already fixed this. This brings /agents to the same place, using
 * the SAME tested module rather than a third copy.
 */
import { readFileSync, writeFileSync } from "node:fs";

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const CRLF = CR + LF;

const p = "apps/dashboard/app/agents/page.tsx";
const raw = readFileSync(p, "utf8");

/**
 * This file is CRLF while the rest of the dashboard is LF - measured, after a
 * multi-line anchor silently failed to match. Normalise for editing and write
 * back in the file's own style, so the diff stays the lines actually changed
 * rather than every line in the file.
 *
 * CR and LF are built from char codes, not typed as escapes: this script has
 * already been generated through a shell heredoc once, and the escapes did
 * not survive the trip.
 */
const WAS_CRLF = raw.includes(CRLF);
let s = raw.split(CRLF).join(LF);

function must(from, to, what) {
  if (!s.includes(from)) throw new Error(`not found: ${what}`);
  s = s.replace(from, to);
}

// --- imports --------------------------------------------------------------
must(
  [
    'import { Check, Copy } from "lucide-react";',
    'import AgentAvatar from "@/components/smoothui/agent-avatar";',
  ].join(LF),
  [
    'import { Check, Copy, ExternalLink } from "lucide-react";',
    'import AgentAvatar from "@/components/smoothui/agent-avatar";',
    'import { signLink, type OwnerPayload } from "@/lib/sign-link";',
    'import { treeLabel } from "@/lib/tree-label";',
  ].join(LF),
  "imports",
);

// --- the doc comment should stop describing the old behaviour -------------
must(
  [
    " * Freeze is the one mutating action kept, because it maps to a real contract",
    " * method (`freeze_node`). Like every owner method it produces a command for the",
    " * owner to run rather than being signed here.",
  ].join(LF),
  [
    " * Freeze is the one mutating action kept, because it maps to a real contract",
    " * method (`freeze_node`). It is never signed here - this dashboard can only",
    " * ever hold an agent key - so it produces a LINK to the signing page, which",
    " * holds the wallet connection and refuses unless get_config().owner matches.",
    " *",
    " * It used to print a near-cli command instead. That instruction ended in",
    " * `sign-with-keychain`, so following it required the owner's key on disk;",
    " * for an owner whose key is in a browser wallet it was simply impossible.",
  ].join(LF),
  "doc comment",
);

// --- state shape -----------------------------------------------------------
must(
  "  const [plan, setPlan] = useState<{ cli: string; label: string } | null>(null);",
  [
    "  const [plan, setPlan] = useState<{",
    "    payload: OwnerPayload;",
    "    label: string;",
    "    from: string;",
    "    to: string;",
    "  } | null>(null);",
    "  const [planError, setPlanError] = useState<string | null>(null);",
  ].join(LF),
  "plan state",
);

// --- the builder -----------------------------------------------------------
must(
  [
    "        const body = (await res.json()) as { cli?: string; error?: string };",
    "        if (!res.ok || !body.cli) throw new Error(body.error ?? `HTTP ${res.status}`);",
    "        setPlan({",
    "          cli: body.cli,",
    '          label: `${frozen ? "Freeze" : "Unfreeze"} ${(a.displayName ?? a.agentId).trim()}`,',
    "        });",
    "      } catch (e) {",
    "        setPlan({",
    '          cli: e instanceof Error ? e.message : "Could not build the command.",',
    '          label: "Error",',
    "        });",
    "      }",
  ].join(LF),
  [
    "        const body = (await res.json()) as {",
    "          payload?: OwnerPayload;",
    "          error?: string;",
    "        };",
    "        if (!res.ok || !body.payload) throw new Error(body.error ?? `HTTP ${res.status}`);",
    "        setPlan({",
    "          payload: body.payload,",
    "          // treeLabel, not a raw trim: displayName carries the branch glyph",
    "          // and a non-breaking indent for children, and both would end up",
    "          // in the sentence the owner reads before signing.",
    '          label: `${frozen ? "Freeze" : "Unfreeze"} ${treeLabel(a.displayName, a.agentId)}`,',
    '          from: frozen ? "Active" : "Frozen",',
    '          to: frozen ? "Frozen" : "Active",',
    "        });",
    "        setPlanError(null);",
    "      } catch (e) {",
    "        setPlan(null);",
    '        setPlanError(e instanceof Error ? e.message : "Could not prepare the transaction.");',
    "      }",
  ].join(LF),
  "buildFreeze body",
);

writeFileSync(p, WAS_CRLF ? s.split(LF).join(CRLF) : s);
console.log(`  /agents freeze now builds a payload (CRLF preserved: ${WAS_CRLF})`);

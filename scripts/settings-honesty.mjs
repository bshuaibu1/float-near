/**
 * Replace two /settings controls that reported success while doing nothing.
 *
 * MEASURED against the running adapter:
 *
 *   POST /v1/settings            -> 200 {"ownerWallet":"...","notificationEmail":null}
 *   POST /v1/agents/node-1/kill  -> 404 {"error":"no such endpoint"}
 *
 * The settings handler ignores the request body and hardcodes
 * notificationEmail to null, so no email is stored anywhere - a POST and a GET
 * return byte-identical JSON. The kill route is one of the six Solana-era
 * endpoints the NEAR adapter never implemented.
 *
 * Both reported success regardless, because neither checked `res.ok`: the kill
 * button fired N requests through Promise.all, discarded every response, and
 * set "Done".
 *
 * "Kill all agents" is an EMERGENCY STOP, which makes it the worst control in
 * the product to have lying - the moment someone reaches for it is the moment
 * they most need to believe it. It becomes the real thing: `set_paused(true)`,
 * one transaction, vault-wide, reversible from /policies.
 *
 * LINE-BASED, located by content. The file aligns its `=` with runs of spaces
 * (`const [killError, setKillError]     = ...`), and literal anchors guessed
 * at that whitespace twice and failed.
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

// --- 1. imports -----------------------------------------------------------
{
  const i = find(/^import \{.*\} from "react";$/, "react import");
  lines.splice(
    i + 1,
    0,
    'import { ExternalLink } from "lucide-react";',
    'import { signLink, type OwnerPayload } from "@/lib/sign-link";',
  );
}

// --- 2. state -------------------------------------------------------------
{
  const i = find(/const \[killError, setKillError\]/, "killError state");
  lines.splice(
    i + 1,
    0,
    "  // The prepared pause, and the network its signing link needs.",
    "  const [pausePlan, setPausePlan] = useState<OwnerPayload | null>(null);",
    '  const [network, setNetwork] = useState("testnet");',
  );
}

// --- 3. learn the network ------------------------------------------------
{
  const i = find(/\.catch\(\(\) => \{\}\);/, "settings fetch tail");
  lines.splice(
    i + 1,
    0,
    "",
    "  // The signing link has to name the right network.",
    "  useEffect(() => {",
    '    fetch(`${API_BASE_URL}/v1/vault-info`, { cache: "no-store" })',
    "      .then((r) => (r.ok ? r.json() : null))",
    "      .then((d: { network?: string } | null) => {",
    "        if (d?.network) setNetwork(d.network);",
    "      })",
    "      .catch(() => {});",
    "  }, []);",
  );
}

// --- 4. killAll -> preparePause -------------------------------------------
{
  const start = find(/const killAll = async \(\) => \{/, "killAll");
  // Its closing line is the first `  };` at that indent after the start.
  let end = start;
  while (end < lines.length && lines[end] !== "  };") end++;
  if (end >= lines.length) throw new Error("killAll terminator not found");

  lines.splice(
    start,
    end - start + 1,
    "  /**",
    "   * Prepare the real emergency stop.",
    "   *",
    "   * This used to POST /v1/agents/:id/kill for every active agent. That",
    "   * endpoint returns 404 - one of the Solana-era routes the NEAR adapter",
    "   * never served - and the handler discarded every response, so the button",
    '   * reported "Done" while nothing had been stopped.',
    "   *",
    "   * `set_paused(true)` is the genuine equivalent and strictly stronger:",
    "   * one transaction, refuses every payment vault-wide including the root's,",
    "   * and reversible from /policies.",
    "   */",
    "  const preparePause = async () => {",
    "    setKilling(true);",
    "    setKillError(null);",
    "    try {",
    "      const res = await fetch(`${API_BASE_URL}/v1/owner-plan`, {",
    '        method: "POST",',
    '        headers: { "content-type": "application/json" },',
    '        body: JSON.stringify({ action: "pause", paused: true }),',
    "      });",
    "      const body = (await res.json()) as { payload?: OwnerPayload; error?: string };",
    "      // CHECKED. The previous version never looked at a response, which is",
    "      // exactly how a 404 rendered as success.",
    "      if (!res.ok || !body.payload) throw new Error(body.error ?? `HTTP ${res.status}`);",
    "      setPausePlan(body.payload);",
    "      setKillConfirm(false);",
    "    } catch (err) {",
    '      setKillError(err instanceof Error ? err.message : "Could not prepare the pause.");',
    "    } finally {",
    "      setKilling(false);",
    "    }",
    "  };",
  );
}

// --- 5. the kill button now prepares ---------------------------------------
{
  const i = find(/onClick=\{\(\) => void killAll\(\)\}/, "kill confirm button");
  lines[i] = lines[i].replace("void killAll()", "void preparePause()");
  const j = find(/\{killing \? "Killing…" : "Confirm"\}/, "confirm label");
  lines[j] = lines[j].replace('{killing ? "Killing…" : "Confirm"}', '{killing ? "Preparing…" : "Prepare pause"}');
}

// --- 6. honest copy for the danger zone ------------------------------------
{
  const i = find(/Kill all agents<\/p>|>Kill all agents</, "danger title");
  lines[i] = lines[i].replace("Kill all agents", "Pause all payments");
  const j = find(/Stop all agents from making payments immediately\./, "danger body");
  lines[j] = lines[j].replace(
    "Stop all agents from making payments immediately.",
    "Refuses every payment vault-wide until you unpause. One transaction for you to sign.",
  );
  const k = find(/These actions are irreversible\./, "danger subtitle");
  lines[k] = lines[k].replace(
    "These actions are irreversible.",
    "This takes effect only once you sign it, and can be undone from Policies.",
  );
}

writeFileSync(p, crlf ? lines.join(LF).split(LF).join(CRLF) : lines.join(LF));
console.log("  settings: kill switch now prepares a real set_paused(true)");

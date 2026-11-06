/**
 * Take `addRole` back out of the adapter's owner-plan.
 *
 * WHY, HAVING JUST PUT IT IN
 *
 * Nothing called it. `vault_add_role` in the MCP already does the whole job -
 * it generates the keypair, writes the secret to .float/agent-keys.json and
 * returns the unsigned payload - and the adapter can only ever do the second
 * half of that, because it must never touch the secret.
 *
 * So a dashboard page built on this could not say "create agent"; it could
 * only say "paste the public key of a keypair you made elsewhere". Two tools
 * for what one already does, and any browser-side keygen would put the secret
 * in browser memory and a Downloads folder - strictly worse than the MCP
 * writing it straight to disk.
 *
 * I argued it was worth keeping for API completeness. The numbers refuted
 * that: the MCP can plan TWELVE owner methods and this file exposed SEVEN.
 * owner-plan is demand-driven - it carries what the dashboard actually uses -
 * so an action with no caller is the odd one out, not the missing piece.
 *
 * WHAT STAYS
 *
 * UnknownActionError and the error-message fix. That bug was independent: the
 * handler caught every throw and reported `unknown action`, so a bad cooldown
 * or a duplicate recipient got the one message that cannot lead to a fix. It
 * was only visible because testing addRole's failure path happened to expose
 * it, but it was never about addRole.
 */
import { readFileSync, writeFileSync } from "node:fs";

const LF = String.fromCharCode(10);

// --- owner-plan.ts --------------------------------------------------------
{
  const p = "packages/float-adapter/src/owner-plan.ts";
  let s = readFileSync(p, "utf8");

  const must = (from, to, what) => {
    if (!s.includes(from)) throw new Error(`${p}: not found: ${what}`);
    s = s.replace(from, to);
  };

  must("  planAddRole," + LF, "", "import");

  // the request-type variant
  const tStart = s.indexOf('  | { action: "allocation"; strict?: boolean }');
  const tEnd = s.indexOf("export type OwnerPlanEnv");
  if (tStart < 0 || tEnd < 0) throw new Error("request type markers not found");
  const head = s.slice(0, tStart);
  const tail = s.slice(tEnd);
  s = head + '  | { action: "allocation"; strict?: boolean };' + LF + LF + tail;

  // the case
  const cStart = s.indexOf('    case "addRole":');
  const cEnd = s.indexOf("    default:", cStart);
  if (cStart < 0 || cEnd < 0) throw new Error("addRole case markers not found");
  s = s.slice(0, cStart) + s.slice(cEnd);

  writeFileSync(p, s);
  console.log("  owner-plan.ts: addRole removed, UnknownActionError kept");
}

// --- owner-plan.test.ts ---------------------------------------------------
{
  const p = "packages/float-adapter/src/owner-plan.test.ts";
  let s = readFileSync(p, "utf8");

  // the addRole describe block
  const dStart = s.indexOf("  /* ADD ROLE.");
  const dEnd = s.indexOf(
    '  it("REFUSES an unknown action rather than planning something arbitrary", () => {',
  );
  if (dStart < 0 || dEnd < 0) throw new Error("addRole block markers not found");
  s = s.slice(0, dStart) + s.slice(dEnd);

  // the error-distinction test used addRole as its example; re-anchor it on
  // cooldown, which validates through assertCooldown.
  const oldTest = s.slice(
    s.indexOf("  /**" + LF + "   * A VALIDATION failure is not an unknown action."),
  );
  const tStart = s.indexOf("  /**" + LF + "   * A VALIDATION failure is not an unknown action.");
  const tEnd = s.lastIndexOf("});");
  if (tStart < 0) throw new Error("distinction test not found");

  const NEW = [
    "  /**",
    "   * A VALIDATION failure is not an unknown action.",
    "   *",
    "   * The HTTP handler caught every throw from here and reported",
    "   * `unknown action: <name>`, so a negative cooldown, a duplicate",
    "   * recipient or an over-long list all told the caller the action did not",
    "   * exist - the one message that cannot help them.",
    "   */",
    '  it("distinguishes a bad ARGUMENT from an unknown ACTION", () => {',
    "    let thrown: unknown;",
    "    try {",
    '      planOwnerAction({ action: "cooldown", nodeId: 1, cooldownSec: -5 }, ENV);',
    "    } catch (e) {",
    "      thrown = e;",
    "    }",
    "    expect(thrown).toBeInstanceOf(Error);",
    "    expect(thrown).not.toBeInstanceOf(UnknownActionError);",
    "    expect(String((thrown as Error).message)).toMatch(/cooldown/i);",
    "  });",
    "});",
    "",
  ].join(LF);

  s = s.slice(0, tStart) + NEW;
  writeFileSync(p, s);
  console.log("  owner-plan.test.ts: addRole tests removed, distinction test re-anchored on cooldown");
}

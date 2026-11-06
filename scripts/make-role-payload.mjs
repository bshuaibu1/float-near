/**
 * Run `vault_add_role`'s own code path against a vault the MCP server is not
 * pointed at.
 *
 * WHY THIS EXISTS RATHER THAN CALLING THE TOOL. `vault_add_role` takes no
 * `vault` argument on purpose — it reads NEAR_VAULT_CONTRACT, so an agent
 * cannot be talked into provisioning a role on somebody else's vault. The
 * running server still points at a vault that no longer exists, and
 * restarting it is the user's to do, so this drives the SAME two functions
 * the tool composes: `generateAgentKey` then `planAddRole`.
 *
 * Deliberately NOT a reimplementation. Both are imported from the built
 * package, so the key file this writes and the payload it prints are exactly
 * what the tool would have produced — a hand-rolled copy is how the two
 * drift and the live proof stops testing the shipped path.
 *
 *   node scripts/make-role-payload.mjs <vault> <role> <dailyCap> <perTxCap>
 */
import { resolve } from "node:path";

import { generateAgentKey } from "../packages/mcp/dist/agent-key.js";
import { planAddRole } from "../packages/mcp/dist/payloads.js";
import { listRoles } from "../packages/mcp/dist/roles.js";

const ROOT = resolve(import.meta.dirname, "..");
const [, , VAULT, ROLE, DAILY, PERTX] = process.argv;
const TOKEN = process.env.TOKEN ?? "usdc.fakes.testnet";
const DECIMALS = Number(process.env.DECIMALS ?? "6");
const FUNDING = process.env.FUNDING_YOCTO ?? (12n * 10n ** 22n).toString(); // 0.12
const DIR = resolve(ROOT, ".float");

if (!VAULT || !ROLE || !DAILY || !PERTX) {
  console.error("usage: node scripts/make-role-payload.mjs <vault> <role> <dailyCap> <perTxCap>");
  process.exit(2);
}

// REFUSE A DUPLICATE ROLE BEFORE GENERATING A KEY, exactly as the tool does.
// The contract would happily create a second node with the same label, and
// the keyring indexes by role — so the first agent would stay bound and
// funded on chain with nothing able to select it.
const existing = listRoles({ agentKeysPath: resolve(DIR, "agent-keys.json") });
if (existing.some((r) => r.role === ROLE)) {
  console.error(`FATAL: a credential with role '${ROLE}' already exists.`);
  console.error(`  Filing a second would hide the first, which would remain bound`);
  console.error(`  and funded on chain. Known roles: ${existing.map((r) => r.role).join(", ")}`);
  process.exit(1);
}

const generated = generateAgentKey({ vault: VAULT, dir: DIR, role: ROLE });

let payload;
try {
  payload = planAddRole(
    VAULT,
    ROLE,
    [{ token: TOKEN, dailyCap: DAILY, perTxCap: PERTX, decimals: DECIMALS }],
    0,
    null, // inherit the root's payee allowlist
    generated.publicKey,
    FUNDING,
  );
} catch (e) {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
}

console.log(`role        ${ROLE}`);
console.log(`vault       ${VAULT}`);
console.log(`public key  ${generated.publicKey}`);
console.log(`credential  ${generated.keyringPath}  (secret NOT printed)`);
console.log();
console.log(`caps        ${DAILY} / day, ${PERTX} / tx of ${TOKEN}`);
console.log(`funding     ${(Number(FUNDING) / 1e24).toFixed(3)} NEAR to the agent's gas key`);
console.log();
console.log(`--- the owner signs this ---`);
console.log(JSON.stringify(payload, null, 2));

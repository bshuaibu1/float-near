#!/usr/bin/env node
/**
 * MCP server for the hierarchical budget vault.
 *
 * Trust model, which is the whole point of the split below:
 *
 *   READ tools      no key at all, raw JSON-RPC
 *   PAY tool        signs with the agent's RESTRICTED key — request_payment
 *                   on this vault only, no deposit possible
 *   PLAN tools      emit UNSIGNED payloads for the human's wallet; this
 *                   server never signs anything that changes policy
 *
 *   CREATE tool     needs no key and no vault. It reads the factory, works out
 *                   the address and the cost, and hands back a URL the user
 *                   approves in their own wallet.
 *
 * Configure with:
 *   NEAR_VAULT_CONTRACT        required by every tool EXCEPT vault_create
 *   NEAR_VAULT_RPC_URL         OPTIONAL. Defaults to the RPC for
 *                              NEAR_VAULT_NETWORK — free.rpc.fastnear.com on
 *                              mainnet, test.rpc.fastnear.com on testnet. It
 *                              used to default to the testnet URL regardless,
 *                              so every mainnet install read the wrong chain.
 *   NEAR_VAULT_TOKEN           default token for pay/budget calls
 *   NEAR_VAULT_TOKEN_DECIMALS  default 6
 *   NEAR_VAULT_AGENT_ID        only needed to PAY. Taken from the key file's
 *                              `account_id` when one is given.
 *   NEAR_VAULT_AGENT_KEY       only needed to PAY. The restricted key, inline.
 *   NEAR_VAULT_AGENT_KEY_FILE  PREFERRED over the inline value above: a PATH to
 *                              a ~/.near-credentials-shaped JSON file
 *                              ({"account_id","public_key","private_key"}) or a
 *                              bare key file. A path is not a secret, so the
 *                              routine act of reading this config to see which
 *                              vault is wired up stops printing a live private
 *                              key into a terminal and an agent transcript.
 *                              Same reason NEAR CLI signing in this repo uses
 *                              `sign-with-access-key-file`. If both are set the
 *                              FILE wins and the inline one is reported as
 *                              ignored on stderr.
 *   NEAR_VAULT_NETWORK         mainnet | testnet, default testnet
 *   NEAR_VAULT_FACTORY         only needed to CREATE. No mainnet default
 *                              exists on purpose — guessing it wrong would
 *                              send a real deposit somewhere unverified.
 *   NEAR_VAULT_APP_URL         only needed to CREATE, default
 *                              https://usefloat.xyz (the APEX — `app.` is the
 *                              dashboard and has no create flow)
 *
 * A user with NO vault can therefore run this server with nothing configured,
 * call `vault_create`, and be onboarded — which is the point. Every other tool
 * reports that NEAR_VAULT_CONTRACT is unset rather than guessing one.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { topUpFor, paymentsAfterTopUp } from "./gas-math.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fromBaseUnits, humaniseTreeNode, toBaseUnits, type TreeNode } from "./amounts.js";
import {
  DEFAULT_GAS_TGAS,
  planAddNode,
  planAddRole,
  planBindVirtualAgent,
  planUnbindVirtualAgent,
  planFreezeNode,
  planPurgeSettled,
  planSetCooldown,
  planSetNodeCaps,
  planSetPaused,
  planSetRecipients,
  toCliCommand,
  type OwnerPayload,
  planSetApprovalThreshold,
  planApprovePayment,
  planRejectPayment,
  planWithdraw,
} from "./payloads.js";
import {
  accountExists,
  rpcForNetwork,
  DEFAULT_RPC_URL,
  newRequestId,
  requireAgentKey,
  viewAccessKeys,
  viewAccount,
  viewFunction,
} from "./rpc.js";
import { AGENT_NODE_ID, generateAgentKey } from "./agent-key.js";
import { resolveKeySource } from "./key-file.js";
import { dirname } from "node:path";

import { listAgents, listRoles, selectRole } from "./roles.js";

/**
 * A decimal NEAR string to yoctoNEAR, without floating point.
 *
 * `Number("0.12") * 1e24` is 1.2000000000000001e23 — a figure that becomes a
 * deposit, so the drift lands on chain. Parsed as text instead.
 */
function toYoctoNear(n: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(n.trim());
  if (!m) throw new Error(`"${n}" is not a NEAR amount (digits, optional decimal point)`);
  return (BigInt(m[1]!) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0"))).toString();
}
import { buildCreatePlan, FACTORY_BY_NETWORK } from "./create.js";
import { buildRoute, sendRequestPayment, type RouteArg } from "./sign.js";
import { getQuote, signBinding, toBase64 } from "./quote.js";

/** How long a quote stays valid. Long enough to sign and send, short
 *  enough that a stale price is not honoured. */
const QUOTE_TTL_MS = 20 * 60 * 1000;

/**
 * Secrets, from a FILE where one is named. See key-file.ts for why.
 *
 * Resolved once at startup rather than per call, so a broken path is reported
 * in the client's server log at launch instead of only when someone tries to
 * pay.
 */
const agentKeySource = resolveKeySource({
  inline: process.env.NEAR_VAULT_AGENT_KEY,
  file: process.env.NEAR_VAULT_AGENT_KEY_FILE,
  inlineVar: "NEAR_VAULT_AGENT_KEY",
  fileVar: "NEAR_VAULT_AGENT_KEY_FILE",
});
const quoteSignerSource = resolveKeySource({
  inline: process.env.FLOAT_QUOTE_SIGNER_KEY,
  file: process.env.FLOAT_QUOTE_SIGNER_KEY_FILE,
  inlineVar: "FLOAT_QUOTE_SIGNER_KEY",
  fileVar: "FLOAT_QUOTE_SIGNER_KEY_FILE",
});

/**
 * STDERR, NEVER STDOUT. This process speaks JSON-RPC over stdout, so a single
 * stray `console.log` corrupts the stream and the client reports a protocol
 * error rather than the configuration problem being described. There is no
 * other `console.*` call in this file — that is deliberate, and this one is
 * `console.error` for the same reason.
 *
 * NAMES ONLY, never values: this goes to a log file the user may well paste.
 */
for (const note of [...agentKeySource.warnings, ...quoteSignerSource.warnings]) {
  console.error(`float: ${note}`);
}
// A named-but-unreadable key file is reported at startup AND again, with the
// same text, if someone tries to pay. The server must still start: reads,
// payload planning and `vault_create` need no key at all, and onboarding a user
// who has no vault yet is the whole point of this server being runnable with
// nothing configured.
for (const err of [agentKeySource.error, quoteSignerSource.error]) {
  if (err) console.error(`float: ${err}`);
}

/**
 * The network, resolved BEFORE `cfg` so the RPC can follow it.
 *
 * It used to be read inside the object literal, which meant `rpcUrl` could not
 * see it and fell back to a constant. See below.
 */
const NETWORK = process.env.NEAR_VAULT_NETWORK ?? "testnet";

const cfg = {
  vault: process.env.NEAR_VAULT_CONTRACT ?? "",
  /**
   * THE RPC FOLLOWS THE NETWORK. It did not, and that broke every mainnet
   * install.
   *
   * This was `process.env.NEAR_VAULT_RPC_URL ?? DEFAULT_RPC_URL`, and
   * `DEFAULT_RPC_URL` is the TESTNET endpoint. So a user who set
   * `NEAR_VAULT_NETWORK=mainnet` — the documented way to be on mainnet — and
   * did not also happen to set `NEAR_VAULT_RPC_URL` had all fourteen tools
   * that use `cfg.rpcUrl` querying TESTNET for a mainnet vault. Reads answered
   * "account does not exist" about an account holding 3.35 NEAR, and
   * `vault_pay` would have submitted a real payment to the wrong chain.
   *
   * Measured 2026-11-10 on test015-near.usefloat.near: `vault_config` and
   * `vault_tree` reported the vault missing while `vault_await_create` read
   * its config fine — the two tools differ only in that `vault_create` and
   * `vault_await_create` call `rpcForNetwork()` and everything else took this
   * constant.
   *
   * THAT ASYMMETRY ALSO DEFEATED THE DIAGNOSIS. The testnet theory was correct
   * and was "refuted" by testing it with `vault_await_create`, the one tool
   * immune to the bug — so the right answer was discarded on the strength of a
   * check that could not fail. Pick the probe that exercises the broken path,
   * not the convenient one.
   *
   * `rpcForNetwork` honours `NEAR_VAULT_RPC_URL` only when it applies to the
   * network in play, which is the behaviour `vault_create` already relied on.
   */
  rpcUrl: rpcForNetwork(NETWORK, {
    configuredNetwork: NETWORK,
    override: process.env.NEAR_VAULT_RPC_URL,
  }),
  token: process.env.NEAR_VAULT_TOKEN ?? "",
  decimals: Number(process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6"),
  // The credentials file carries the account as well as the key, so one path
  // can supply both halves. An explicit NEAR_VAULT_AGENT_ID still wins, and
  // `requireAgentKey` refuses the pair if the two disagree.
  agentId: process.env.NEAR_VAULT_AGENT_ID ?? agentKeySource.accountId,
  agentKey: agentKeySource.secret,
  agentKeyError: agentKeySource.error,
  agentKeyAccountId: agentKeySource.accountId,
  network: NETWORK,
  // Onboarding only. Both have safe defaults and neither is needed by any
  // tool that touches an existing vault.
  factory: process.env.NEAR_VAULT_FACTORY,
  // The APEX, where the create page actually lives — one hop instead of two.
  //
  // `app.` ALSO WORKS AND IS NOT A BUG. It serves the Next.js dashboard, but
  // nginx bounces anything carrying `?factory=` to the apex signing page, and
  // `buildCreatePlan` sets `factory` on every link unconditionally. That rule
  // exists because the published @floatonnear/mcp 0.5.0 hardcodes `app.`, and
  // breaking it would break vault creation for every existing install.
  // Verified 2026-11-10: `app.usefloat.xyz/?factory=…` → 200 at
  // `usefloat.xyz`, "Create your Float vault".
  //
  // So this is a small simplification, NOT a repair — an earlier version of
  // this comment claimed users were landing on the dashboard, which came from
  // probing the bare URL that nothing emits.
  //
  // Guarded by `scripts/check-create-page.mjs`, which fetches the real link
  // shape, follows redirects, and checks the wasm at the landing origin.
  appUrl: process.env.NEAR_VAULT_APP_URL ?? "https://usefloat.xyz",
  // The fleet keyring. Same default and same file the adapter reads — two
  // readers disagreeing about where credentials live is how an agent ends up
  // "configured" and unreachable.
  agentKeysPath: process.env.NEAR_VAULT_AGENT_KEYS ?? ".float/agent-keys.json",
};

function requireVault(): string {
  if (!cfg.vault) throw new Error("NEAR_VAULT_CONTRACT is not set");
  return cfg.vault;
}
function tokenFor(t?: string): string {
  const token = t ?? cfg.token;
  if (!token) throw new Error("no token given and NEAR_VAULT_TOKEN is not set");
  return token;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** Payload + summary + warnings + a runnable command, so approving needs no trust in this server. */
function renderPlan(p: OwnerPayload) {
  return json({
    action: p.methodName,
    summary: p.summary,
    warnings: p.warnings,
    unsigned_payload: {
      receiver_id: p.receiverId,
      method_name: p.methodName,
      args: p.args,
      gas_tgas: p.gasTgas,
      deposit_yocto: p.depositYocto,
    },
    approve_with: toCliCommand(p, cfg.network),
    note:
      "This server did NOT sign this. Review the summary, then run the command " +
      "or approve the payload in your wallet.",
  });
}

const limitShape = z
  .array(
    z.object({
      token: z.string(),
      dailyCap: z.string().describe('human units, e.g. "1000"'),
      perTxCap: z.string().describe('human units, e.g. "250"'),
      decimals: z.number().int().min(0).max(38).default(6),
    }),
  )
  .min(1);

// The name a client displays in its server list, so this string -- not the
// package name, not the config key -- is the product's label in the one place
// the product is visible. It was "near-vault": the repo's directory name,
// leaking outward as the user-facing identity while the config key create-float
// writes has always been `float`.
//
// The version stays a literal rather than being read from package.json at
// startup: a wrong relative path would break the server outright instead of
// merely reporting a stale version. server.smoke.test.ts asserts the two agree,
// so a bump cannot land with only one of them moved.
/**
 * WHAT THE AGENT READS BEFORE IT TOUCHES A TOOL.
 *
 * 23 tool descriptions tell a model what each CALL does and nothing about what
 * the product IS, when to reach for it, or which of the three trust lanes a
 * given task belongs in. The MCP `instructions` field is the one place that
 * can say so, and it is injected into the client's system prompt — which is
 * why servers that set it feel like the agent "already understands the
 * project", and why ours did not.
 *
 * Kept to what a model cannot infer from a tool list: the workflow order, the
 * fact that this server never signs policy, and the three refusals that are
 * answers rather than errors. Everything that IS inferable from a schema is
 * left to the schema.
 */
const INSTRUCTIONS = `Float gives an AI agent a spending budget that a smart contract enforces, on NEAR.
The agent's key can call exactly one method on exactly one contract: it cannot move tokens
directly, cannot raise its own limit, and cannot reach owner functions. Those are protocol-level
key restrictions, not policy checks.

Reach for these tools when the user wants to pay for something from an agent budget, set up or
change spending limits, see what an agent has spent, or wind a vault down.

THREE LANES, and the difference is the whole design:
  READ    vault_tree, vault_budget, vault_config, vault_roles, vault_request. No key, no risk.
  PAY     vault_pay. The ONLY tool that signs, and only with a restricted agent key.
  PLAN    vault_plan_*. These RETURN AN UNSIGNED PAYLOAD. This server never signs a policy
          change; the human approves it in their own wallet. Do not describe a plan as done.

WORKFLOW
  1. No vault yet? vault_create. It needs no key and no existing vault, and returns a URL the
     user approves in their own wallet. Never ask anyone for a private key or seed phrase.
  2. Look before acting: vault_tree shows the budget shape, vault_budget what is left today.
  3. Pay with vault_pay. Check the result: a refusal is a recorded outcome, not an exception.
  4. Change policy with a vault_plan_* tool, then hand the payload to the user to sign.
  5. Winding down is a CLI job, not a tool: npx -p @floatonnear/create-float float-exit. It returns the tokens,
     the gas-key balances and the storage deposit. vault_teardown_report says what is recoverable.

REFUSALS ARE ANSWERS. Report the reason code, do not retry blindly:
  DAILY_BUDGET         this agent's own cap is spent.
  PARENT_DAILY_BUDGET  a SIBLING drained the shared pool; this agent's own cap may look free.
  PER_TX_LIMIT         one payment was too large; splitting it may still be refused by the cap.
  NO_RECIPIENTS_SET    the node pays nobody yet; that is an owner decision, via vault_plan_set_recipients.

WORTH KNOWING
  Budgets are hierarchical: a payment charges every ancestor, so a vault-wide ceiling holds even
  when a child's cap looks free.
  An implicit account (a 64-character hex id) cannot own a vault at all. Tell the user to use a
  named account rather than retrying.
  Amounts are whole tokens in these tools (1.5 means 1.5 USDC), never base units.`;

const server = new McpServer({ name: "float", version: "0.6.6" }, { instructions: INSTRUCTIONS });

// ----------------------------------------------------------------- reads

/**
 * Wait for a create to land, and prove the result belongs to the user.
 *
 * WHY A TOOL AND NOT A SENTENCE IN THE NOTE. `vault_create` knows the derived
 * address before anything is signed, so "did it work?" is answerable from the
 * chain — yet the flow used to end at "approve it in your wallet", leaving the
 * human to read an account id back to an agent that already had it. That was
 * the clunkiest step in onboarding and it was a documentation gap, not a
 * technical limit.
 *
 * EXISTENCE IS NOT OWNERSHIP, and conflating them is the actual hazard here.
 * `derive_prefix` is not injective — `a.b.near` and `a-b.near` land on the same
 * id — so an account AT the derived address may belong to whoever created
 * first. Reporting "your vault is live" on existence alone would point a user's
 * agent at a stranger's money. So this reads `get_config` back and compares
 * `owner`, and reports THREE outcomes, never two: yours, someone else's, or
 * could-not-read. "I could not check" is not "it is yours".
 *
 * Polls rather than asking once, because a `final`-finality read immediately
 * after a write can be a whole transaction behind.
 */
server.tool(
  "vault_await_create",
  "After the user signs the create link, confirm the vault is live and VERIFY IT IS THEIRS. Reads the chain, so it needs no key. Call this instead of asking the user to paste their vault id back — vault_create already told you the address.",
  {
    vault: z
      .string()
      .optional()
      .describe(
        "the derived vault id, from vault_create's `confirm.vault`. OMIT IT if the user already created their vault and you never built the link — it is derived from `owner` via the factory's own vault_id_for view.",
      ),
    owner: z.string().describe("who it must belong to — compared against the vault's own get_config.owner"),
    network: z.enum(["mainnet", "testnet"]).optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .optional()
      .describe("how long to wait for the account to appear, default 90"),
  },
  async ({ vault, owner, network, timeoutSeconds }) => {
    const net = network ?? cfg.network;
    const rpc = rpcForNetwork(net, {
      configuredNetwork: cfg.network,
      override: process.env.NEAR_VAULT_RPC_URL,
    });

    // DERIVE IT WHEN THE CALLER HAS NO LINK TO QUOTE.
    //
    // A user who says "I already created it" never gave this server a plan to
    // read `confirm.vault` out of, and does not know their vault id — it is
    // derived, not chosen. Requiring it here left the agent with only one tool
    // that knows the derivation: `vault_create`. Measured 2026-11-10, that is
    // exactly what an agent did, and `vault_create` THREW — correctly —
    // "already exists and test015.near owns it". The agent then reported that
    // refusal to the user as "Confirmed ✅". It reached the right answer by
    // reinterpreting an error, which is luck, not a workflow.
    //
    // So adoption gets a first-class path: `owner` alone is enough. The
    // derivation comes from the factory's `vault_id_for` view, the same single
    // source `buildCreatePlan` uses and deliberately does not reimplement.
    let target = vault;
    if (!target) {
      const fac = cfg.factory ?? FACTORY_BY_NETWORK[net];
      if (!fac) {
        return text(
          `No factory is configured for ${net}, so the vault id cannot be derived. ` +
            `Pass \`vault\` directly, or set NEAR_VAULT_FACTORY.`,
        );
      }
      const derived = await viewFunction<string | null>(rpc, fac, "vault_id_for", {
        owner,
      }).catch(() => null);
      if (!derived) {
        return text(
          `${fac} could not derive a vault id for ${owner} on ${net}. Either the ` +
            `owner id is wrong, or it has no legal derived id (an implicit account ` +
            `has none — the derived name exceeds 64 characters).`,
        );
      }
      target = derived;
    }

    const deadline = Date.now() + (timeoutSeconds ?? 90) * 1000;

    let appeared = false;
    for (;;) {
      if (await accountExists(rpc, target).catch(() => false)) {
        appeared = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (!appeared) {
      return json({
        status: "NOT_YET",
        vault: target,
        instruction:
          `${target} does not exist yet. That is not a failure — the user may not have ` +
          `signed, or may have cancelled. Ask whether they approved it, and call this ` +
          `again. Do NOT tell them the vault is created.`,
      });
    }

    // THE OWNER READ IS THE POINT. Getting here only proves an account exists.
    const config = await viewFunction<{ owner?: string }>(rpc, target, "get_config", {}).catch(
      () => null,
    );

    if (!config || typeof config.owner !== "string") {
      return json({
        status: "UNVERIFIED",
        vault: target,
        instruction:
          `${target} exists but its get_config could not be read, so whether it is ${owner}'s ` +
          `is UNKNOWN — not assumed. It may not be a Float vault at all. Do not point an ` +
          `agent at it until this is resolved: near view ${target} get_config`,
      });
    }

    if (config.owner !== owner) {
      return json({
        status: "NOT_YOURS",
        vault: target,
        actualOwner: config.owner,
        instruction:
          `${target} exists but is owned by ${config.owner}, NOT ${owner}. The vault id ` +
          `derivation is not injective, so a different account can hold this address — ` +
          `whoever created it first. Do NOT configure anything against it. Create one ` +
          `under a label instead, which lands on a different address.`,
      });
    }

    return json({
      status: "LIVE",
      vault: target,
      owner: config.owner,
      config,
      nextSteps: [
        `Set NEAR_VAULT_CONTRACT=${target} so every other tool reads this vault.`,
        `vault_tree shows the budget; vault_budget shows what is left today.`,
        `Nothing can spend from it until an agent is bound with a budget — vault_add_role.`,
      ],
    });
  },
);

server.tool(
  "vault_tree",
  "Read the whole budget tree: every node, its caps, parent, bound agent account, cooldown and freeze state. No key required.",
  {},
  async () => {
    const tree = (await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {})) as TreeNode[];
    return json(
      Array.isArray(tree)
        ? tree.map((n) => humaniseTreeNode(n, { token: cfg.token, decimals: cfg.decimals }))
        : tree,
    );
  },
);

server.tool(
  "vault_budget",
  "Read one node's budget for a UTC day: cap, executed, in-flight (pending) and available, in human units. Omit `day` for today. No key required.",
  {
    nodeId: z.number().int().min(0),
    token: z.string().optional(),
    day: z.number().int().optional(),
  },
  async ({ nodeId, token, day }) => {
    const b = (await viewFunction(cfg.rpcUrl, requireVault(), "get_node_budget", {
      node_id: nodeId,
      token: tokenFor(token),
      day: day ?? null,
    })) as Record<string, string> | null;
    if (!b) {
      // "no limit for that token" ASSERTED THAT THE NODE EXISTS. Asked about
      // node 999 of a two-node vault it said the same thing, which sends a
      // user off to set a limit on a node that is not there. Two different
      // facts had one message.
      const missing = await assertNode(nodeId);
      if (missing) return text(noNodeForRead(nodeId, missing.known));
      const tree = (await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {}).catch(
        () => null,
      )) as { id: number; limits?: { token: string }[] }[] | null;
      const here = tree?.find((n) => n.id === nodeId)?.limits?.map((l) => l.token) ?? [];
      return text(
        `Node ${nodeId} exists but has no limit for ${tokenFor(token)}. ` +
          (here.length
            ? `It has limits for: ${here.join(", ")}.`
            : `It has no limits for any token, so it can pay nothing — set one with vault_plan_set_caps.`),
      );
    }
    const d = cfg.decimals;
    return json({
      node_id: nodeId,
      day: b.day,
      daily_cap: fromBaseUnits(BigInt(b.daily_cap!), d),
      executed: fromBaseUnits(BigInt(b.executed!), d),
      pending: fromBaseUnits(BigInt(b.pending!), d),
      available: fromBaseUnits(BigInt(b.available!), d),
    });
  },
);

server.tool(
  "vault_request",
  "Read one stored payment request: status, reason code, amount, the ancestor chain it charged, and the UTC day it was reserved against. No key required.",
  { requestId: z.string() },
  async ({ requestId }) => {
    const r = await viewFunction(cfg.rpcUrl, requireVault(), "get_request", {
      request_id: requestId,
    });
    // A BARE `null` IS AMBIGUOUS and this tool returned one. To a reader it is
    // indistinguishable from a failed call, and to an agent it is a value to
    // guess about rather than a fact to relay. Requests are also PURGEABLE, so
    // "not found" has two very different causes and the honest answer names
    // both instead of implying the payment never happened.
    if (r === null || r === undefined) {
      return text(
        `No request "${requestId}" on ${cfg.vault}. Either the id is wrong, or the ` +
          `request was settled and later removed by purge_settled — purging is how a ` +
          `vault reclaims storage, so an OLD successful payment can legitimately be gone. ` +
          `vault_tree and vault_budget still reflect what it spent.`,
      );
    }
    return json(r);
  },
);

server.tool(
  "vault_config",
  "Read vault config: owner, paused, strict-vs-overcommit allocation, node count, and clock mode. No key required.",
  {},
  async () => json(await viewFunction(cfg.rpcUrl, requireVault(), "get_config", {})),
);

server.tool(
  "vault_add_role",
  "Add a NEW departmental agent to an existing vault — e.g. a 'marketing' or 'news' agent with its own budget. Generates the agent's key, files it under the role name, and returns an UNSIGNED payload for the owner to approve. One FunctionCall creates the node, binds the key and installs its funded gas key. This server never signs it.",
  {
    role: z
      .string()
      .min(1)
      .max(48)
      .describe("the agent's name, e.g. \"marketing\". Used as the node label AND as the keyring index you later pass to vault_pay."),
    dailyCap: z.string().describe("daily spend cap in HUMAN units, e.g. \"25.00\""),
    perTxCap: z.string().describe("per-payment cap in HUMAN units, e.g. \"5.00\""),
    recipients: z
      .array(z.string())
      .optional()
      .describe("payee allowlist for this agent. Omitted means it inherits the nearest ancestor's list."),
    token: z.string().optional(),
    cooldownSec: z.number().int().min(0).optional(),
    fundingNear: z
      .string()
      .optional()
      .describe("NEAR for the agent's gas key. Default 0.12 (~160 payments measured). Minimum 0.06, because NEAR reserves prepaid gas up front."),
  },
  async ({ role, dailyCap, perTxCap, recipients, token, cooldownSec, fundingNear }) => {
    const vault = requireVault();

    // REFUSE A DUPLICATE ROLE BEFORE GENERATING A KEY. The contract would
    // happily create a second node with the same label, and the keyring would
    // index only the last one — so the first agent would still be bound and
    // funded on chain while becoming unreachable locally.
    if (listRoles(cfg).some((r) => r.role === role)) {
      return text(
        `This vault already has an agent with the role '${role}'. Roles index the ` +
          `keyring, so a second one would hide the first — which would stay bound and ` +
          `funded on chain with nothing able to select it. Pick another name, or use ` +
          `the existing agent.`,
      );
    }

    const fundingYocto = toYoctoNear(fundingNear ?? "0.12");
    // `nodeId: null` — NOT YET KNOWN. `add_role` creates the node inside the
    // contract, so its id does not exist until the transaction lands.
    const generated = generateAgentKey({
      vault,
      dir: dirname(cfg.agentKeysPath),
      role,
      nodeId: null,
    });

    let payload;
    try {
      payload = planAddRole(
        vault,
        role,
        [{ token: tokenFor(token), dailyCap, perTxCap, decimals: cfg.decimals }],
        cooldownSec ?? 0,
        recipients ?? null,
        generated.publicKey,
        fundingYocto,
      );
    } catch (e) {
      return text(String((e as Error).message));
    }

    return json({
      role,
      agent: {
        publicKey: generated.publicKey,
        credentialWrittenTo: generated.keyringPath,
      },
      payload,
      next: [
        `Have the owner approve this payload in their own wallet.`,
        `The node id is assigned by the contract and returned by the call; the ` +
          `credential is filed under the ROLE, so vault_pay({role:"${role}"}) works ` +
          `without it.`,
      ],
      warnings: [
        `Show the owner this public key and have them confirm it before signing: ${generated.publicKey}`,
        `The private key is at ${generated.keyringPath}. Do not print it.`,
      ],
    });
  },
);

server.tool(
  "vault_roles",
  "List the agents this server can sign as, by role. Use it before vault_pay when a vault has more than one agent — the signing key decides which budget is charged. No key material is returned.",
  {},
  async () =>
    json(
      // `listAgents`, NOT `listRoles`. The latter filters to entries carrying a
      // role, which is correct for SELECTION and wrong for REPORTING: a
      // creation-time agent from `bindAgent` has no role, so a working vault
      // with a funded gas key reported `[]` — indistinguishable from having no
      // agent at all, and the obvious next move is then the wrong one.
      listAgents(cfg).map((r) => ({
        role: r.role,
        nodeId: r.nodeId,
        agentId: r.agentId,
        ...(r.role === null
          ? {
              note:
                "No role name — created by vault_create({bindAgent:true}), which does not " +
                "name one. It can still sign; vault_pay selects it by nodeId or as the only " +
                "credential. Give it a name with vault_add_role if you want several agents.",
            }
          : {}),
      })),
    ),
);

// ------------------------------------------------------------- onboarding

server.tool(
  "vault_create",
  "For a user who has NO vault yet. Works out where their vault will live, exactly what it costs to create, and returns a URL they approve in their own wallet. Needs no key and no existing vault — this is the only tool that works before NEAR_VAULT_CONTRACT is set. This server never signs it.",
  {
    owner: z
      .string()
      .optional()
      .describe(
        "the account that will own the vault, e.g. alice.near. OMIT IT if you do not know the user's NEAR account — the link then derives everything from whichever wallet they connect, which is the normal case when onboarding someone new.",
      ),
    network: z.enum(["mainnet", "testnet"]).optional(),
    factory: z
      .string()
      .optional()
      .describe("override the factory; defaults to the known one for the network"),
    bindAgent: z
      .boolean()
      .optional()
      .describe(
        "generate an agent key and bind it in the SAME transaction, so one signature creates the vault and authorises you. Adds 0.12 NEAR of gas-key funding to the deposit. The user is shown the public key and must confirm it before signing. Requires `owner`, because the credential is filed under the vault id and that cannot be derived without one.",
      ),
      daily: z
      .string()
      .optional()
      .describe(
        "The root budget per UTC day, in HUMAN units of the token, e.g. \"25\" or \"100\" — not base units. PROPOSE a figure rather than interrogating the user; caps are changeable later with a signed vault_plan_set_caps. Page default when omitted: 25 (mainnet) / 100 (testnet).",
      ),
    perTx: z
      .string()
      .optional()
      .describe(
        "Maximum per single payment, HUMAN units. Must be <= daily or it can never bind, and must EXCEED the largest payment intended — cross-chain is EXACT_OUTPUT, so the vault is charged more than the payee receives and a cap of 5 refuses a round 5.00. Page default when omitted: 10 (mainnet) / 10 (testnet).",
      ),
    token: z
      .string()
      .optional()
      .describe(
        "the NEP-141 token the caps are denominated in. Defaults per network (USDC on mainnet). Caps are keyed PER TOKEN, so a wrong id silently gives the agent no budget for the token it actually pays in.",
      ),
    decimals: z
      .number()
      .int()
      .min(0)
      .max(24)
      .optional()
      .describe("the token's decimals, default 6. Wrong here scales every cap by a power of ten."),
    label: z
      .string()
      .optional()
      .describe(
        "optional vault label, 1-16 chars of a-z0-9. IT BECOMES PART OF THE ADDRESS (<prefix>-<label>.<factory>), so pass it only if the user wants a second vault or a specific name.",
      ),
},
  async ({ owner, network, factory, bindAgent, daily, perTx, token, decimals, label }) => {
    const net = network ?? cfg.network;
    const fac = factory ?? cfg.factory ?? FACTORY_BY_NETWORK[net];
    if (!fac) {
      // DELIBERATELY NOT A GUESS. A wrong mainnet default does not fail
      // safely — it takes a real signature for a real deposit into an account
      // nobody verified.
      return text(
        `No factory is configured for ${net}. Pass one as \`factory\`, or set ` +
          `NEAR_VAULT_FACTORY. There is deliberately no built-in mainnet default: ` +
          `guessing it wrong would send a real deposit somewhere unverified.`,
      );
    }
    // THE RPC MUST FOLLOW THE NETWORK, not the process's default. 0.6.0
    // resolved the right factory for `net` and then asked the testnet RPC
    // about it, so a mainnet request answered "usefloat.near does not exist"
    // about an account that does.
    const rpc = rpcForNetwork(net, {
      configuredNetwork: cfg.network,
      override: process.env.NEAR_VAULT_RPC_URL,
    });

    // Only ask the factory to derive an id when there IS an owner. With none,
    // the address is decided by whichever wallet signs, and inventing one here
    // would print a plausible address next to a real deposit figure.
    const config = await viewFunction<{
      required_deposit: string;
      paused: boolean;
      network: string;
    }>(rpc, fac, "get_config", {});
    const vaultId = owner
      ? await viewFunction<string | null>(rpc, fac, "vault_id_for", { owner })
      : null;

    const extra: string[] = [];
    if (config.network !== net) {
      extra.push(
        `The factory reports network "${config.network}" but you asked for ${net}; ` +
          `the vault will be initialised with "${config.network}".`,
      );
    }

    const exists = owner && vaultId ? await accountExists(rpc, vaultId) : false;

    /**
     * ASK THE EXISTING VAULT WHO OWNS IT, rather than inferring it from the
     * derivation that produced the id.
     *
     * `derive_prefix` replaces dots with hyphens and is NOT injective:
     * `a.b.near` and `a-b.near` both derive `a-b-near`, and the factory ships
     * a test asserting exactly that. So "an account exists at your derived id"
     * does not mean "it is yours" — and the message here used to say it did,
     * which would point the loser of a collision at the winner's vault.
     *
     * `null` on any failure, which the planner treats as a THIRD outcome.
     * Collapsing the error into "not yours" would be as wrong as collapsing it
     * into "yours": a vault that is merely unreadable right now is neither.
     */
    const existingOwner =
      exists && vaultId
        ? await viewFunction<{ owner?: string }>(rpc, vaultId, "get_config", {})
            .then((c) => c?.owner ?? null)
            .catch(() => null)
        : null;

    // AN AGENT NEEDS A VAULT ID, and not for the transaction — the page
    // derives that from the connected wallet. It is needed for the CREDENTIAL,
    // which the adapter files under the account the key signs as. A virtual
    // agent's key is a gas key ON the vault, so that account is the vault
    // itself, and without an owner there is nothing to derive it from.
    //
    // Refusing beats writing a record with a null account: such a record is
    // skipped in silence by `loadKeyring`, so the agent would appear set up
    // and simply never be found.
    if (bindAgent && !vaultId) {
      return text(
        `Binding an agent needs \`owner\`, because the agent's credential is filed ` +
          `under the vault id and that is derived from the owner. Call vault_create ` +
          `again with the user's NEAR account, or omit bindAgent and bind afterwards ` +
          `with vault_plan_bind_agent.`,
      );
    }

    let generated: ReturnType<typeof generateAgentKey> | null = null;
    if (bindAgent && vaultId) generated = generateAgentKey({ vault: vaultId });

    try {
      const plan = buildCreatePlan({
        owner: owner ?? "",
        ownerKnown: !!owner,
        vaultId,
        factory: fac,
        network: net,
        requiredDepositYocto: String(config.required_deposit),
        paused: config.paused,
        appUrl: cfg.appUrl,
        exists,
        existingOwner,
        agentPk: generated?.publicKey ?? null,
        // The interview answers, forwarded verbatim. Undefined stays undefined
        // so the PAGE's own defaults apply — substituting a default here would
        // mean two places deciding the same number, which is how the deposit
        // quote came to disagree with the page by 0.26 NEAR.
        daily,
        perTx,
        token,
        decimals,
        label,
      });
      return json({
        ...plan,
        // THE PUBLIC HALF ONLY. The secret is on disk; a tool response is a
        // transcript entry forever.
        agent: generated
          ? {
              publicKey: generated.publicKey,
              nodeId: AGENT_NODE_ID,
              credentialWrittenTo: generated.keyringPath,
              envWrittenTo: generated.envPath,
              ...(generated.backedUpTo ? { previousKeyringMovedTo: generated.backedUpTo } : {}),
            }
          : null,
        warnings: [
          ...extra,
          ...plan.warnings,
          ...(generated
            ? [
                `Show the user this agent key and ask them to confirm it matches what ` +
                  `the page displays before they approve: ${generated.publicKey}`,
                `The agent's private key is at ${generated.keyringPath}. It can only call ` +
                  `request_payment on this vault, inside the budget. Do not print it.`,
              ]
            : []),
        ],
      });
    } catch (e) {
      return text(String((e as Error).message));
    }
  },
);

// ------------------------------------------------------------------- pay

server.tool(
  "vault_pay",
  "Send a payment from the agent's node. Signs with the agent's RESTRICTED key, which can call only request_payment on this vault and cannot attach a deposit. The contract checks the per-tx cap, the daily cap at EVERY level of the budget tree, the cooldown and the payee allowlist before any value moves.",
  {
    amount: z.string().describe('human units, e.g. "12.50"'),
    recipient: z.string(),
    memo: z.string().max(256).default(""),
    token: z.string().optional(),
    requestId: z.string().optional().describe("omit to generate one"),
    rail: z
      .enum(["near", "intents"])
      .default("near")
      .describe(
        "near = NEP-141 transfer on NEAR, proves settlement. intents = cross-chain: the vault transfers on NEAR to a solver's one-time deposit address and the solver delivers on the destination chain. BOTH run the same hierarchical budget check and the same payee allowlist.",
      ),
    destinationAsset: z
      .string()
      .optional()
      .describe("1Click asset id for rail=intents. Defaults to USDC on Base."),
    role: z
      .string()
      .optional()
      .describe(
        "which agent pays, by role name — e.g. \"marketing\". Required once the vault has more than one agent, because the signing key decides which budget is charged. Omit it only when there is exactly one.",
      ),
  },
  async ({ amount, recipient, memo, token, requestId, rail, destinationAsset, role }) => {
    // WHICH KEY SIGNS *IS* WHICH BUDGET IS CHARGED. The contract resolves the
    // spending node from the signer, not from anything in the request body,
    // so picking the wrong key does not fail — it succeeds against someone
    // else's budget and surfaces later as a confusing balance.
    const creds = role === undefined ? requireAgentKey(cfg) : selectRole(cfg, role);
    const id = requestId ?? newRequestId();
    const vault = requireVault();

    let route: RouteArg = "near_direct";
    let amountIn = toBaseUnits(amount, cfg.decimals);

    if (rail === "intents") {
      // The agent cannot build this route. It needs a quote AND a signature
      // from the key the vault owner registered — and that key deliberately
      // does not live where agents run, because whoever holds it can bind any
      // deposit address to any payee. So this path only works when the MCP
      // server is the operator's own.
      const signerHex = quoteSignerSource.secret;
      if (!signerHex) {
        throw new Error(
          // A named-but-broken FILE is a cause; "the variable is unset" is a
          // description. Reporting the second when the first applies sends the
          // operator to set something they have already set.
          quoteSignerSource.error
            ? `rail=intents needs the quote signer, and the key file could not be read. ` +
              `${quoteSignerSource.error}`
            : "rail=intents needs FLOAT_QUOTE_SIGNER_KEY (32-byte hex), or " +
              "FLOAT_QUOTE_SIGNER_KEY_FILE pointing at a file that holds it. " +
              "That key binds a payee to a deposit address, so it belongs to the " +
              "vault operator, not to an agent. Without it the cross-chain rail is closed.",
        );
      }
      const sk = Uint8Array.from(Buffer.from(signerHex.replace(/^0x/, ""), "hex"));

      // EXACT_OUTPUT: `amount` is what the PAYEE receives. What leaves the
      // vault is the quote's amountIn, and that is what the budget is charged
      // — so the tree governs real outflow, not the nominal figure.
      const deadline = new Date(Date.now() + QUOTE_TTL_MS);
      const q = await getQuote({
        amountOut: toBaseUnits(amount, cfg.decimals),
        payee: recipient,
        refundTo: vault,
        destinationAsset,
        deadline,
      });
      amountIn = q.amountIn;

      const signature = signBinding(
        {
          vault,
          requestId: id,
          token: tokenFor(token),
          amount: q.amountIn,
          payee: recipient,
          depositAddress: q.depositAddress,
          deadlineNs: q.deadlineNs,
        },
        sk,
      );
      route = buildRoute("intents", {
        depositAddress: q.depositAddress,
        quoteDeadlineNs: q.deadlineNs.toString(),
        signature: toBase64(signature),
      });
    }

    const out = await sendRequestPayment({
      rpcUrl: cfg.rpcUrl,
      vault,
      agentId: creds.agentId,
      agentKey: creds.agentKey,
      requestId: id,
      token: tokenFor(token),
      amount: amountIn,
      recipient,
      memo,
      gasTgas: DEFAULT_GAS_TGAS,
      route,
    });
    return json(out);
  },
);

// ------------------------------------------------------- plans (unsigned)

server.tool(
  "vault_plan_add_node",
  "Build an UNSIGNED payload to create a budget node. Pass parent=null for the root. Not signed by this server.",
  {
    parent: z.number().int().min(0).nullable(),
    label: z.string(),
    limits: limitShape,
    cooldownSec: z.number().int().min(0).default(0),
    recipients: z.array(z.string()).nullable().default(null),
  },
  async ({ parent, label, limits, cooldownSec, recipients }) =>
    renderPlan(planAddNode(requireVault(), parent, label, limits, cooldownSec, recipients)),
);

/**
 * Refuse to build a signable payload for a node that does not exist.
 *
 * PLAN TOOLS HANDED OUT PAYLOADS FOR ANY `nodeId`. Measured 2026-11-10:
 * `vault_plan_set_caps({nodeId: 999})` against a two-node vault returned a
 * cheerful summary — "Set node 999 caps to … 1/day" — and a complete unsigned
 * transaction. The user approves it in their wallet, pays the gas, and the
 * CONTRACT rejects it. The cost is small and the experience is not: the only
 * signal anything was wrong arrives after a signature, from a layer the user
 * cannot read.
 *
 * A plan tool's entire job is to produce something safe to sign. "Safe to
 * sign" has to include "addresses something real".
 *
 * Costs one view call per plan. That is the right trade against a wasted
 * signature, and these are human-speed operations — nobody plans in a loop.
 *
 * Returns the node ids that DO exist, because "999 does not exist" without
 * them just prompts another guess.
 */
async function assertNode(nodeId: number): Promise<{ known: string } | null> {
  const tree = (await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {}).catch(
    () => null,
  )) as { id: number; label?: string }[] | null;
  // A failed READ must not block a plan: the chain being briefly unreachable
  // is not evidence the node is missing, and refusing here would turn a blip
  // into "your node does not exist".
  if (!Array.isArray(tree)) return null;
  if (tree.some((n) => n.id === nodeId)) return null;
  // RETURNS THE FACTS, NOT A SENTENCE. The first version returned prose and
  // the read path tried to reuse it by regex-stripping the signing clause,
  // which left "no node 999, Nodes: ...". Composing at the call site costs two
  // lines and cannot produce a mangled sentence.
  return { known: tree.map((n) => `${n.id}${n.label ? ` (${n.label})` : ""}`).join(", ") };
}

/** For a PLAN: the cost of getting this wrong is a wasted signature. */
const noNodeForPlan = (nodeId: number, known: string) =>
  `This vault has no node ${nodeId}, so that payload would be refused by the ` +
  `contract AFTER you signed and paid for it. Nodes: ${known}.`;

/** For a READ: nothing is at stake, so just say what exists. */
const noNodeForRead = (nodeId: number, known: string) =>
  `This vault has no node ${nodeId}. Nodes: ${known}.`;

server.tool(
  "vault_plan_set_caps",
  "Build an UNSIGNED payload to change a node's daily and per-payment caps. Not signed by this server.",
  { nodeId: z.number().int().min(0), limits: limitShape },
  async ({ nodeId, limits }) => {
    const bad = await assertNode(nodeId);
    return bad
      ? text(noNodeForPlan(nodeId, bad.known))
      : renderPlan(planSetNodeCaps(requireVault(), nodeId, limits));
  },
);

server.tool(
  "vault_plan_bind_agent",
  "Build an UNSIGNED payload binding a signing key to a node, so that key may spend from it. Generate the keypair yourself and pass only the public half. Many keys may share one node. Not signed by this server.",
  {
    nodeId: z.number().int().min(0),
    publicKey: z.string().describe("ed25519:..."),
  },
  async ({ nodeId, publicKey }) =>
    renderPlan(planBindVirtualAgent(requireVault(), nodeId, publicKey)),
);

server.tool(
  "vault_plan_unbind_agent",
  "Build an UNSIGNED payload revoking a signing key's authority to spend. Does NOT return any gas left in that key's NEP-611 gas key — withdraw from the gas key separately. Not signed by this server.",
  { publicKey: z.string().describe("ed25519:...") },
  async ({ publicKey }) => renderPlan(planUnbindVirtualAgent(requireVault(), publicKey)),
);

server.tool(
  "vault_plan_freeze",
  "Build an UNSIGNED payload to freeze or unfreeze a node. Freezing blocks the node AND its whole subtree. Not signed by this server.",
  { nodeId: z.number().int().min(0), frozen: z.boolean() },
  async ({ nodeId, frozen }) => {
    const bad = await assertNode(nodeId);
    return bad
      ? text(noNodeForPlan(nodeId, bad.known))
      : renderPlan(planFreezeNode(requireVault(), nodeId, frozen));
  },
);

server.tool(
  "vault_plan_set_recipients",
  "Build an UNSIGNED payload to set a node's payee allowlist. This REPLACES the inherited list rather than adding to it; pass null to inherit. Not signed by this server.",
  { nodeId: z.number().int().min(0), recipients: z.array(z.string()).nullable() },
  async ({ nodeId, recipients }) =>
    (async () => {
      const bad = await assertNode(nodeId);
      return bad
        ? text(noNodeForPlan(nodeId, bad.known))
        : renderPlan(planSetRecipients(requireVault(), nodeId, recipients));
    })(),
);

server.tool(
  "vault_plan_set_cooldown",
  "Build an UNSIGNED payload to set the minimum seconds between a node's payments. Not signed by this server.",
  { nodeId: z.number().int().min(0), cooldownSec: z.number().int().min(0) },
  async ({ nodeId, cooldownSec }) => {
    const bad = await assertNode(nodeId);
    return bad
      ? text(noNodeForPlan(nodeId, bad.known))
      : renderPlan(planSetCooldown(requireVault(), nodeId, cooldownSec));
  },
);

server.tool(
  "vault_pending_approval",
  "Look up a payment that is HELD awaiting the owner's approval. Returns null if there is no ticket for that id — already approved, already rejected, or never held.",
  { requestId: z.string().min(1) },
  async ({ requestId }) =>
    json(
      (await viewFunction(cfg.rpcUrl, requireVault(), "get_pending_approval", {
        request_id: requestId,
      })) ?? null,
    ),
);

server.tool(
  "vault_plan_set_approval_threshold",
  'Build an UNSIGNED payload requiring the owner\'s approval for payments above an amount at this node. A threshold sits INSIDE the caps and can only make the vault more conservative. `amount` is HUMAN units, the same convention as vault_pay — "0.25" is a quarter of a USDC. Pass amount null to remove the threshold. Not signed by this server.',
  {
    nodeId: z.number().int().min(0),
    // HUMAN units, matching vault_pay and vault_plan_set_caps. This took BASE
    // units until 2026-10-31 and was the only tool here that did — on the one
    // control that configures a safety gate, where the mistake fails OPEN. See
    // planSetApprovalThreshold in payloads.ts for the measurement.
    amount: z.string().min(1).nullable().describe('human units, e.g. "0.25" — NOT base units'),
    decimals: z.number().int().min(0).max(38).default(6),
  },
  async ({ nodeId, amount, decimals }) =>
    renderPlan(planSetApprovalThreshold(requireVault(), nodeId, amount, decimals)),
);

server.tool(
  "vault_plan_approve_payment",
  "Build an UNSIGNED payload to APPROVE a held payment, which sends it. Every limit is re-checked at approval, so it can still be refused. Not signed by this server.",
  { requestId: z.string().min(1) },
  async ({ requestId }) => renderPlan(planApprovePayment(requireVault(), requestId)),
);

server.tool(
  "vault_plan_reject_payment",
  "Build an UNSIGNED payload to REJECT a held payment. Nothing moves and the ticket is discarded. Not signed by this server.",
  { requestId: z.string().min(1) },
  async ({ requestId }) => renderPlan(planRejectPayment(requireVault(), requestId)),
);

server.tool(
  "vault_plan_pause",
  "Build an UNSIGNED payload to pause or resume the whole vault. Pausing halts every agent payment. Not signed by this server.",
  { paused: z.boolean() },
  async ({ paused }) => renderPlan(planSetPaused(requireVault(), paused)),
);

server.tool(
  "vault_plan_purge",
  "Build an UNSIGNED payload to delete settled payment records older than a UTC day. Spend totals are NOT refunded, but a deleted request id becomes reusable. Not signed by this server.",
  {
    beforeDay: z.number().int().min(0),
    limit: z.number().int().min(0).max(100).default(100),
  },
  async ({ beforeDay, limit }) => renderPlan(planPurgeSettled(requireVault(), beforeDay, limit)),
);

server.tool(
  "vault_plan_withdraw",
  "Build an UNSIGNED payload to move tokens OUT of the vault to any account. The owner approves it in their own wallet; this server never signs. This is the step that decides whether money survives a teardown: deleting a NEAR account does NOT return fungible tokens, so they must be moved first.",
  {
    amount: z
      .string()
      .describe(
        "HUMAN units, e.g. \"12.5\" for 12.5 USDC. Omit to withdraw the vault's entire balance, read from the token contract.",
      )
      .optional(),
    receiverId: z.string().describe("who receives the tokens, e.g. alice.testnet"),
    token: z.string().optional().describe("overrides NEAR_VAULT_TOKEN"),
  },
  async ({ amount, receiverId, token }) => {
    const vault = requireVault();
    const tok = tokenFor(token);

    /**
     * NO AMOUNT MEANS "ALL", READ FROM THE CHAIN — not a guess, and not a
     * figure the caller carried in. The balance is taken as the token's own
     * base-unit STRING and passed through untouched, because re-deriving it
     * through a float leaves dust and a vault with dust never reaches the
     * zero a delete needs.
     */
    let base: string;
    if (amount === undefined) {
      const bal = await viewFunction<string>(cfg.rpcUrl, tok, "ft_balance_of", {
        account_id: vault,
      });
      if (!/^\d+$/.test(String(bal))) {
        return text(
          `${tok} reported this vault's balance as ${JSON.stringify(bal)}, which is not a ` +
            `number. Refusing to build a withdrawal from a balance that cannot be read.`,
        );
      }
      if (BigInt(bal) === 0n) {
        return text(`${vault} holds no ${tok}. Nothing to withdraw.`);
      }
      base = String(bal);
    } else {
      // `toBaseUnits` returns a bigint; the payload carries base units as a
      // STRING, because that is what the contract's U128 arg expects.
      base = toBaseUnits(amount, cfg.decimals).toString();
    }

    return renderPlan(planWithdraw(vault, tok, base, receiverId, cfg.decimals));
  },
);

/**
 * WHY A QUOTE AND NOT A PLAN, which every other owner action here is.
 *
 * The rest of `vault_plan_*` returns an UNSIGNED payload the user approves in
 * their own wallet. A top-up cannot work that way: `transferToGasKey` is an
 * action on the VAULT account, so it needs a full-access key OF the vault —
 * and wallets IGNORE `signerId`, silently signing as the connected account and
 * returning SUCCESS while doing the wrong thing. Measured 2026-11-07 across
 * Meteor, Intear and the CLI connector alike.
 *
 * So this takes the shape `vault_teardown_report` already uses: read the
 * chain, do the arithmetic, hand over the exact command. The half an agent CAN
 * serve is the part a human cannot do in their head — which agent is low, what
 * a given amount buys, what a given payment count costs.
 */
server.tool(
  "vault_gas",
  "Read-only. How much gas each agent has left, and what topping one up would cost or buy. Needs no key and signs nothing. Use for 'is my agent about to run out?' and 'top up the marketing agent' — it returns the exact command, because a top-up must be signed BY THE VAULT and a browser wallet cannot do that.",
  {
    agent: z
      .string()
      .optional()
      .describe("a gas key's public key, or a node label like 'marketing'. Omit to list every agent."),
    payments: z.number().int().positive().optional().describe("quote the cost of this many MORE payments"),
    amountNear: z.string().optional().describe("or quote how many payments this much NEAR would buy"),
    tgas: z.number().int().optional().describe("gas per call (default 60, floor 50)"),
  },
  async ({ agent, payments, amountNear, tgas }) => {
    const vault = requireVault();
    const TG = tgas ?? 60;
    const keyList = await viewAccessKeys(cfg.rpcUrl, vault);
    const tree = await viewFunction<Array<{ id: number; label: string }>>(
      cfg.rpcUrl,
      vault,
      "get_tree",
      {},
    ).catch(() => [] as Array<{ id: number; label: string }>);

    // KEY -> NODE -> LABEL, so "top up marketing" can find the right key. The
    // vault identifies an agent BY ITS PUBLIC KEY (`pubkey_to_node`), which is
    // why each agent has its own: one shared key would be one node, and the
    // per-agent budgets would collapse into a single shared one.
    const rows = [];
    for (const k of keyList) {
      const gk = (k.access_key?.permission as { GasKeyFunctionCall?: { balance: string } })
        ?.GasKeyFunctionCall;
      if (!gk) continue;
      const node = await viewFunction<number | null>(cfg.rpcUrl, vault, "get_virtual_agent_node", {
        public_key: k.public_key,
      }).catch(() => null);
      rows.push({
        publicKey: k.public_key,
        nodeId: node,
        label: tree.find((t) => t.id === node)?.label ?? (node === 0 ? "root" : null),
        balanceNear: fromBaseUnits(BigInt(gk.balance), 24),
        paymentsLeft: paymentsAfterTopUp({ balance: BigInt(gk.balance), tgas: TG, amount: 0n }),
      });
    }

    if (rows.length === 0) {
      return json({
        vault,
        agents: [],
        note: "No gas keys on this vault, so no agent can transact. Add one with: npx -p @floatonnear/create-float float-agent",
      });
    }

    const picked = agent ? rows.find((r) => r.publicKey === agent || r.label === agent) : undefined;
    if (agent && !picked) {
      // NOT a silent fallback to the first agent. Quoting against the wrong
      // key prices a top-up for an agent the user did not name.
      return json({
        vault,
        error: "NO_SUCH_AGENT",
        asked: agent,
        agents: rows,
        note: "No gas key matches that public key or node label.",
      });
    }
    if (!picked) return json({ vault, tgas: TG, agents: rows });

    const bal = BigInt(
      (
        keyList.find((k) => k.public_key === picked.publicKey)!.access_key
          .permission as { GasKeyFunctionCall: { balance: string } }
      ).GasKeyFunctionCall.balance,
    );
    const add = amountNear
      ? toBaseUnits(amountNear, 24)
      : topUpFor({ balance: bal, tgas: TG, payments: payments ?? 50 });
    const after = paymentsAfterTopUp({ balance: bal, tgas: TG, amount: add });

    return json({
      vault,
      agent: picked,
      quote: {
        addNear: fromBaseUnits(add, 24),
        paymentsBefore: picked.paymentsLeft,
        paymentsAfter: after,
        gained: after - picked.paymentsLeft,
      },
      command:
        `npx -p @floatonnear/create-float float-topup --vault ${vault} --owner <YOUR-OWNER-ACCOUNT> ` +
        `--agent ${picked.publicKey} ` +
        `${amountNear ? `--amount ${amountNear}` : `--payments ${payments ?? 50}`} ` +
        `--network ${cfg.network}`,
      note:
        "A top-up is signed BY THE VAULT, so a browser wallet cannot do it — wallets ignore " +
        "signerId and sign as the connected account. Run the command with the owner's key on disk.",
    });
  },
);

server.tool(
  "vault_teardown_report",
  "Read-only. Report exactly what closing this vault would return, what it would strand, and the command that does it. Needs no key and signs nothing. Use this to answer 'can I close this vault and what do I get back?' before anyone exports anything.",
  {},
  async () => {
    const vault = requireVault();
    const tok = cfg.token;

    const [acct, keyList, config] = await Promise.all([
      viewAccount(cfg.rpcUrl, vault),
      viewAccessKeys(cfg.rpcUrl, vault),
      viewFunction<{ owner: string }>(cfg.rpcUrl, vault, "get_config", {}).catch(() => null),
    ]);

    const ftBase = tok
      ? await viewFunction<string>(cfg.rpcUrl, tok, "ft_balance_of", { account_id: vault }).catch(
          () => null,
        )
      : null;

    const stakeYocto = BigInt(acct.storage_usage) * 10n ** 19n;
    const freeYocto = BigInt(acct.amount) - stakeYocto;

    const gasKeys = keyList
      .map((k) => {
        const pm = k.access_key.permission as
          | string
          | { GasKeyFunctionCall?: { balance?: string }; GasKeyFullAccess?: { balance?: string } };
        const v =
          typeof pm === "object" ? (pm.GasKeyFunctionCall ?? pm.GasKeyFullAccess) : undefined;
        // The balance sits at the TOP level of the permission variant, not
        // under `gas_key_info` as near-api-js's shape suggests.
        return v?.balance !== undefined
          ? { publicKey: k.public_key, balanceYocto: String(v.balance) }
          : null;
      })
      .filter((x): x is { publicKey: string; balanceYocto: string } => x !== null);

    const gasTotal = gasKeys.reduce((a, g) => a + BigInt(g.balanceYocto), 0n);
    const fullAccess = keyList.filter((k) => k.access_key.permission === "FullAccess");

    /**
     * CAN ANYTHING SIGN AS THE VAULT? That is the whole question, and it is
     * not "does the owner exist".
     *
     * Every step that recovers the NEAR — emptying a gas key, deploying the
     * stub, the delete itself — needs a signature whose signer_id IS THE
     * VAULT. A browser wallet will not produce one: measured 2026-11-07,
     * Meteor silently signs as the connected account and reports success.
     * So the only route is a full-access key on disk, and a vault carrying
     * none is permanently unrecoverable beyond its tokens.
     */
    const signable = fullAccess.length > 0;

    const nearStr = (y: bigint) => (Number(y) / 1e24).toFixed(6);
    const tokenStr =
      ftBase && /^\d+$/.test(ftBase) ? fromBaseUnits(BigInt(ftBase), cfg.decimals) : null;

    return json({
      vault,
      owner: config?.owner ?? "(could not read get_config)",
      holds: {
        tokens: tokenStr === null ? "unknown — the token contract could not be read" : `${tokenStr} ${tok ?? ""}`.trim(),
        near_free: nearStr(freeYocto),
        near_storage_stake: nearStr(stakeYocto),
        gas_keys: gasKeys.map((g) => ({ ...g, near: nearStr(BigInt(g.balanceYocto)) })),
        gas_key_total_near: nearStr(gasTotal),
        storage_bytes: acct.storage_usage,
      },
      recoverable_now_by_an_owner_signature: {
        tokens: tokenStr ?? "unknown",
        how: "vault_plan_withdraw, approved in the owner's wallet. No key on disk needed.",
      },
      needs_a_full_access_key_on_disk: {
        near: nearStr(freeYocto + stakeYocto + gasTotal),
        why:
          "Emptying a gas key, shrinking the code and deleting the account all need a " +
          "signature whose signer_id is the VAULT. A browser wallet will not make one — " +
          "measured: Meteor ignores signerId and silently signs as the connected account.",
        possible: signable,
        detail: signable
          ? `${fullAccess.length} FullAccess key(s) on the vault. If one of them is the owner's, ` +
            `teardown-vault.mjs can sign with it.`
          : "NO FullAccess key on this vault. The NEAR is unrecoverable by anyone. Do not " +
            "shrink it: that frees the stake into an account nobody can empty, which is " +
            "worse than leaving it alone.",
      },
      never_recoverable: {
        warning:
          "DeleteKey on a funded gas key BURNS the balance and reports success — measured, " +
          "0.08322 NEAR as tokens_burnt. Always withdrawFromGasKey first. teardown-vault.mjs " +
          "does this and exits rather than continuing if it fails.",
      },
      command: signable
        ? `NETWORK=${cfg.network} VAULT=${vault} OWNER=${config?.owner ?? "<owner>"} ` +
          `TOKEN=${tok ?? "<token>"} node scripts/teardown-vault.mjs`
        : "(none — nothing can sign as this vault)",
      note:
        "Read-only. This server holds at most a restricted agent key and signed nothing. " +
        "Run the command yourself, after the token withdrawal has settled.",
    });
  },
);

await server.connect(new StdioServerTransport());

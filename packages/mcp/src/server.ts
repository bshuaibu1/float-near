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
  planSetStrictAllocation,
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
  RPC_BY_NETWORK,
  DEFAULT_RPC_URL,
  newRequestId,
  requireAgentKey,
  viewAccessKeys,
  viewAccount,
  viewFunction,
} from "./rpc.js";
import { AGENT_NODE_ID, generateAgentKey } from "./agent-key.js";
import { resolveKeySource } from "./key-file.js";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { listAgents, listRoles, listUnloadable, selectRole } from "./roles.js";
import { label as tokenLabel, tokenMeta, type TokenMeta } from "./token-meta.js";

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
import { explainOutcome } from "./explain.js";
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
 *
 * MAINNET IS THE DEFAULT, and it used to be testnet. The five CLIs all default
 * to `--network mainnet`, so an operator who ran `create-float` and then
 * started this server got a MAINNET vault being read by a TESTNET client, with
 * nothing anywhere saying so. The symptom is not an error: reads answer
 * "account does not exist" about an account holding real money, which reads as
 * "Float is broken" rather than "these two halves disagree".
 *
 * Testnet is still one env var away. The asymmetry was the bug, not the value.
 */
const NETWORK = process.env.NEAR_VAULT_NETWORK ?? "mainnet";

/**
 * An unrecognised network FAILS CLOSED.
 *
 * `rpcForNetwork` falls back to a testnet endpoint for any string it does not
 * know, and that fallback is pinned by a test, so it stays. But it means
 * `NEAR_VAULT_NETWORK=Mainnet` — a capital letter — would resolve to TESTNET
 * and answer mainnet questions about the wrong chain, confidently. That is the
 * exact failure this server already shipped once by a different route.
 *
 * So validate at the boundary rather than widening the fallback: a typo should
 * stop the server, not quietly move it to another chain.
 */
if (!Object.hasOwn(RPC_BY_NETWORK, NETWORK)) {
  console.error(
    `float: NEAR_VAULT_NETWORK is "${NETWORK}", which is not a network this server knows ` +
      `(${Object.keys(RPC_BY_NETWORK).join(", ")}). Refusing to start rather than guessing a ` +
      `chain — an unrecognised value would otherwise resolve to a testnet endpoint and answer ` +
      `questions about the wrong chain.`,
  );
  process.exit(1);
}

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

/**
 * NO VAULT IS THE COMMONEST STATE, SO THE MESSAGE HAS TO BE AN ONRAMP.
 *
 * This said "NEAR_VAULT_CONTRACT is not set" — true, and a dead end. Measured
 * 2026-11-12: an agent asked to pay someone got that from `vault_config` and
 * `vault_tree`, concluded the NEAR rail was unavailable, then searched three
 * unrelated wallets for something that could reach a `.near` address, and
 * finally asked the user to paste a contract id. It never suggested MAKING a
 * vault, because nothing in the failure told it that was possible without one.
 *
 * The WORKFLOW preamble already said "No vault yet? vault_create" and that was
 * not enough: at the moment of failure an agent reads the ERROR, not the
 * instructions it was handed at startup. So the routing belongs here.
 *
 * It is the FIRST thing a new install hits, and the product's answer is
 * genuinely good: `vault_create` needs no key, no existing vault and no
 * configuration. An error that does not say so turns the normal first step
 * into a support question.
 *
 * Names BOTH cases — "you have none" and "you have one this client does not
 * know about" — because the fix differs completely and the message cannot tell
 * which it is.
 */
function requireVault(): string {
  if (!cfg.vault) {
    throw new Error(
      "No vault is configured, so there is nothing to read yet. " +
        "If the user does not have a vault, call vault_create — it needs NO key, no existing " +
        "vault and no configuration, and returns a link they approve in their own wallet. That " +
        "is the normal first step, not an error. " +
        "If they DO have one, set NEAR_VAULT_CONTRACT to its address and restart the client " +
        "(servers are read once at startup); vault_create with an `owner` reports the address " +
        "the factory derives for them. " +
        "Do not go looking for another way to send money — no other rail can reach a NEAR vault.",
    );
  }
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

THE FULL GUIDE IS A RESOURCE: read "float://skill" when you need depth.
  It carries every refusal code and what to do about it, the teardown ORDER (which decides
  whether an agent's gas is recovered or BURNED), and which flows need a human signature.
  Read it before a first vault, before any teardown, and whenever a refusal is not
  self-explanatory. What follows here is only the shape.

WORKFLOW
  1. No vault yet? vault_create. It needs no key and no existing vault, and returns a URL the
     user approves in their own wallet. Never ask anyone for a private key or seed phrase.
  2. Look before acting: vault_tree shows the budget shape, vault_budget what is left today.
  3. Pay with vault_pay. Check the result: a refusal is a recorded outcome, not an exception.
  4. Change policy with a vault_plan_* tool, then hand the payload to the user to sign.
  5. Winding down is a CLI job, not a tool: npx -p @floatonnear/create-float float-exit. It returns the tokens,
     the gas-key balances and the storage deposit. vault_teardown_report says what is recoverable.

SPEAK LIKE A PERSON. NEVER SHOW A REASON CODE TO THE USER.
  vault_pay returns "say" -- a plain-English sentence with the real numbers in it -- plus
  "next_step" and "money_moved". RELAY "say". Add "next_step" if there is one. That is the
  whole reply; do not append the code, the request id, or the raw JSON.

  A user who asked to pay someone and got "PARENT_PER_TX_LIMIT" has been told nothing. The
  codes are precise and they do matter -- they are under "technical" for debugging, and you
  should quote them only if the user asks why, asks for detail, or is clearly a developer.

  Say this:   "That is too big for one payment -- the most per payment is 10 USDC, and this
               asked for 15. Nothing was sent. Send 10 USDC or less, or ask the vault owner
               to raise the limit."
  Not this:   "The payment was BLOCKED with reason_code PARENT_PER_TX_LIMIT."

  On success too: "Sent 0.25 USDC to alice.near. There is 24.75 USDC left to spend today."
  Not "status: SETTLED".

  REFUSALS ARE ANSWERS, not errors. Do not retry blindly -- a refused payment is the contract
  doing its job. "money_moved" tells you whether anything actually left the vault; never imply
  money moved when it is false, and never imply money is lost when a refusal was free.

WORTH KNOWING
  Budgets are hierarchical: a payment charges every ancestor, so a vault-wide ceiling holds even
  when a child's cap looks free.
  Understand the difference between DAILY_BUDGET and PARENT_DAILY_BUDGET even though you must
  not print either. DAILY_BUDGET means this agent spent its own allowance. PARENT_DAILY_BUDGET
  means a SIBLING drained the shared pool, so this agent's own cap can still read as fully
  available -- a user who checks their budget, sees room, and is told only "refused" will
  reasonably think the product is broken. Neither is fixed by retrying.
  An implicit account (a 64-character hex id) cannot own a vault at all. Tell the user to use a
  named account rather than retrying.
  Amounts are whole tokens in these tools (1.5 means 1.5 USDC), never base units.`;

const server = new McpServer({ name: "float", version: "0.10.2" }, { instructions: INSTRUCTIONS });

/**
 * THE FULL OPERATING GUIDE, AS AN MCP RESOURCE.
 *
 * SKILL.md is ~34 KB of operational knowledge: the refusal vocabulary, the
 * teardown ORDER (which is the difference between recovering an agent's gas
 * and burning it), what the three lanes mean, which flows need a human
 * signature. `instructions` cannot carry that — it is injected into the
 * client's system prompt, so it has a budget measured in paragraphs.
 *
 * The gap was being filled by accident. On a DEVELOPER machine you can install
 * SKILL.md as a Claude Code skill and it loads on demand; a real user has no
 * repo to install from, and most MCP clients have no skill mechanism at all.
 * So the depth existed for us and not for them, which is the wrong way round.
 *
 * A resource is the mechanism MCP already has for exactly this: the client
 * lists it, reads it when it decides to, and pays no system-prompt cost until
 * then. It ships INSIDE this package, so it cannot drift from the version of
 * the server being run — `prepack` copies the root SKILL.md, the same way
 * create-float does, so there is one source of bytes.
 *
 * NOT A TOOL, deliberately. A `float_guide` tool would work in every client
 * including those without resources, but it spends a slot in a list of 27 and
 * invites the model to call it speculatively. Clients without resource support
 * still get the instructions and the error messages, which is where the
 * load-bearing routing lives.
 */
{
  // Resolved from THIS file's location, so it works from dist/ at any depth
  // and does not depend on the process's working directory — a server is
  // started by a client from wherever that client happens to be.
  const guidePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "SKILL.md");

  server.registerResource(
    "float-guide",
    "float://skill",
    {
      title: "Float operating guide",
      description:
        "The full guide: every refusal code and what to do about it, the three lanes, the " +
        "teardown ORDER that decides whether an agent's gas is recovered or burned, and which " +
        "flows require a human signature. Read this before a first vault, before a teardown, " +
        "or whenever a refusal is not self-explanatory.",
      mimeType: "text/markdown",
    },
    async () => {
      /**
       * A MISSING GUIDE IS REPORTED, NOT FAKED. If the copy did not ship, say
       * so and name the cause — an empty resource that reads as "there is no
       * guidance" is worse than an error, because the agent proceeds.
       */
      if (!existsSync(guidePath)) {
        throw new Error(
          `the operating guide is missing from this install (${guidePath}). It is copied into ` +
            `the package by prepack; a published tarball should always contain it. Fall back to ` +
            `https://usefloat.xyz/skill.md, and fetch the RAW file — a summariser drops the ` +
            `exact commands.`,
        );
      }
      return {
        contents: [
          {
            uri: "float://skill",
            mimeType: "text/markdown",
            text: readFileSync(guidePath, "utf8"),
          },
        ],
      };
    },
  );
}

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
    const config = await viewFunction<{ owner?: string; vault_id?: string }>(
      rpc,
      target,
      "get_config",
      {},
    ).catch(() => null);

    /**
     * A `get_config` WITH AN OWNER IS NOT PROOF OF A VAULT.
     *
     * The FACTORY also exports `get_config`, and it also returns an `owner` —
     * so pointing this tool at `usefloat.near` with the factory's own owner
     * returned **LIVE**, and the next step it printed was
     * `NEAR_VAULT_CONTRACT=usefloat.near`. Every later read would then query a
     * factory for budgets it does not have.
     *
     * Measured 2026-11-12 on mainnet: the two shapes are cleanly separable --
     * a vault answers `vault_id, owner, network, paused, strict_allocation,
     * node_count, clock_mode`; the factory answers `owner, code_hash, network,
     * required_deposit, paused`. `vault_id` is the discriminator, and it is the
     * field whose presence means "I am the vault you are asking about".
     *
     * Checked BEFORE the owner comparison, because "this is not a vault" is a
     * different and more fundamental answer than "this vault is someone
     * else's", and reporting the latter about a factory would send someone
     * looking for a nonexistent rival owner.
     */
    if (config && typeof config.vault_id !== "string") {
      return json({
        status: "UNVERIFIED",
        vault: target,
        instruction:
          `${target} answers get_config but it is NOT a Float vault — a vault's config ` +
          `carries vault_id, and this one does not. The factory exports get_config too, ` +
          `with an owner field, so "it responded and the owner matched" is not proof. Do ` +
          `NOT set NEAR_VAULT_CONTRACT to it.`,
      });
    }

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

    /**
     * WHAT ACTUALLY STOPS THIS VAULT PAYING, read from the chain.
     *
     * The old `nextSteps` were a FIXED list ending "nothing can spend from it
     * until an agent is bound — vault_add_role". For a vault created with
     * `bindAgent` that is simply false: the agent is already bound, and the
     * real gate is that the vault holds no tokens. Measured 2026-11-13 — the
     * agent relaying it had to correct the tool in front of the user.
     *
     * Worse, nothing told the owner HOW to fund it, or that funding is a plain
     * wallet send to an address, or what that address is. This is the moment
     * they need it: they have just signed, they are looking at the result, and
     * the next thing standing between them and a working vault is money.
     *
     * So the steps are derived from live state instead of asserted. Three
     * reads, once, on a path that runs once per vault.
     */
    const rootToken = await (async () => {
      // THE TREE IS AUTHORITATIVE, not cfg.token: at creation time
      // NEAR_VAULT_CONTRACT is typically unset, so the configured token may be
      // empty while the vault plainly names one in its root limits.
      const tree = await viewFunction<{ id: number; limits?: { token: string }[] }[]>(
        rpc,
        target,
        "get_tree",
        {},
      ).catch(() => null);
      return tree?.find((n) => n.id === 0)?.limits?.[0]?.token;
    })();

    const meta = rootToken
      ? await tokenMeta(rpc, rootToken, (r, t) => viewFunction(r, t, "ft_metadata", {})).catch(
          () => null,
        )
      : null;
    const symbol = meta?.symbol ?? "the token";

    const [held, registered, agentKeys] = await Promise.all([
      rootToken
        ? viewFunction<string>(rpc, rootToken, "ft_balance_of", { account_id: target }).catch(
            () => null,
          )
        : Promise.resolve(null),
      rootToken
        ? viewFunction<unknown>(rpc, rootToken, "storage_balance_of", {
            account_id: target,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      viewAccessKeys(rpc, target)
        // Narrowed the same way vault_gas does: `permission` is a union and
        // only the gas-key arm carries this field.
        .then(
          (ks) =>
            ks.filter(
              (k) =>
                (k.access_key?.permission as { GasKeyFunctionCall?: unknown })
                  ?.GasKeyFunctionCall !== undefined,
            ).length,
        )
        .catch(() => null),
    ]);

    const empty = held !== null && BigInt(held) === 0n;

    const funding = {
      token: rootToken ?? null,
      symbol: rootToken ? symbol : null,
      balance: held === null ? null : fromBaseUnits(BigInt(held), meta?.decimals ?? cfg.decimals),
      /** `undefined` = could not read; `null` = read and NOT registered. */
      registeredOnToken: registered === undefined ? null : registered !== null,
      sendTo: target,
      howTo:
        `Funding is a plain send from the owner's own wallet: send ${symbol} to ${target}. ` +
        `This server cannot do it — the agent key cannot touch a token contract, which is the ` +
        `point of the product.`,
    };

    const nextSteps: string[] = [
      `Set NEAR_VAULT_CONTRACT=${target} so every other tool reads this vault.`,
    ];

    /**
     * UNREGISTERED IS NAMED FIRST, because it is the one that makes a transfer
     * FAIL rather than merely be impossible. Vaults created before the factory
     * registered them are still in this state; the fix is forward-only.
     */
    if (registered === null) {
      nextSteps.push(
        `REGISTER IT FIRST: ${target} is not registered on ${rootToken}, and a transfer to an ` +
          `unregistered account FAILS. The owner must call storage_deposit on the token with ` +
          `about 0.00125 NEAR attached and registration_only: true. Vaults created through the ` +
          `current factory are registered automatically; this one was not.`,
      );
    }

    if (empty) {
      nextSteps.push(
        `FUND IT: the vault holds no ${symbol}. Tell the owner to send ${symbol} to ${target} ` +
          `from their own wallet, and ASK how much they want to move. Nothing can be paid out ` +
          `until it has a balance — the budget caps what MAY be spent, not what exists.`,
      );
    }

    if (agentKeys === 0) {
      nextSteps.push(`No agent is bound yet, so nothing can authorise a payment — vault_add_role.`);
    }

    if (!empty && agentKeys !== 0 && registered !== null) {
      nextSteps.push(`Ready. vault_budget shows today's allowance; vault_pay makes a payment.`);
    } else {
      nextSteps.push(`vault_tree shows the budget shape; vault_budget shows what is left today.`);
    }

    return json({
      status: "LIVE",
      vault: target,
      owner: config.owner,
      config,
      funding,
      nextSteps,
    });
  },
);

/**
 * Resolve every token named in a tree, once, so output can say "USDC".
 *
 * Fetched in PARALLEL and deduplicated: a tree with five nodes sharing one
 * token must make one call, not five. `tokenMeta` caches for the process
 * lifetime, so the second `vault_tree` of a session makes none.
 */
async function metaFor(tokens: string[]): Promise<Map<string, TokenMeta | null>> {
  const unique = [...new Set(tokens)];
  const pairs = await Promise.all(
    unique.map(
      async (t) =>
        [
          t,
          await tokenMeta(cfg.rpcUrl, t, (rpc, token) =>
            viewFunction(rpc, token, "ft_metadata", {}),
          ),
        ] as const,
    ),
  );
  return new Map(pairs);
}

server.tool(
  "vault_tree",
  "Read the whole budget tree: every node, its caps, parent, bound agent account, cooldown and freeze state. No key required.",
  {},
  async () => {
    const tree = (await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {})) as TreeNode[];
    if (!Array.isArray(tree)) return json(tree);
    const meta = await metaFor(tree.flatMap((n) => n.limits?.map((l) => l.token) ?? []));

    /**
     * THE APPROVAL THRESHOLD WAS WRITE-ONLY.
     *
     * `vault_plan_set_approval_threshold` builds a payload to set one, and
     * `get_effective_threshold` has always existed on the contract — but
     * nothing read it back. So an owner could impose a rule and then had no
     * way to see it, and an agent could not warn "this payment will be HELD"
     * before making one. A policy you cannot read is a policy you cannot
     * trust.
     *
     * EFFECTIVE, not the node's own: a threshold INHERITS down the tree, so
     * the figure that actually governs a node may have been set on an
     * ancestor. Reporting the local one would under-report the rule in force.
     */
    const thresholds = await Promise.all(
      tree.map((n) =>
        viewFunction<string | null>(cfg.rpcUrl, requireVault(), "get_effective_threshold", {
          node_id: (n as { id: number }).id,
        }).catch(() => null),
      ),
    );

    return json(
      tree.map((n, i) => {
        const node = humaniseTreeNode(n, { token: cfg.token, decimals: cfg.decimals, meta });
        const raw = thresholds[i];
        if (raw === null || raw === undefined) return node;
        const tok = n.limits?.[0]?.token;
        const d = (tok ? meta.get(tok)?.decimals : undefined) ?? cfg.decimals;
        let human = String(raw);
        try {
          human = fromBaseUnits(BigInt(human), d);
        } catch {
          /* surface what the contract said */
        }
        return {
          ...node,
          approval_threshold: human,
          approval_note: `Payments above ${human} from this node are HELD until the owner approves them.`,
        };
      }),
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
    // The TOKEN's own decimals, not the configured guess. A vault may hold
    // caps for several tokens and only one of them is NEAR_VAULT_TOKEN.
    const tok = tokenFor(token);
    const meta = (await metaFor([tok])).get(tok) ?? null;
    const d = meta?.decimals ?? cfg.decimals;
    return json({
      node_id: nodeId,
      token: tokenLabel(tok, meta),
      /**
       * `day: 20768` MEANS NOTHING TO A PERSON. It is days since the Unix
       * epoch, which is the right key for a ledger and the wrong thing to
       * show someone asking what they have left. The number stays — it is
       * what the contract indexes by, and a support conversation needs it —
       * but the date leads, and the reset is stated because "daily" does not
       * say WHEN, and a budget that resets at midnight in a timezone you do
       * not live in is a surprise worth pre-empting.
       */
      date: new Date(Number(b.day) * 86_400_000).toISOString().slice(0, 10),
      day: b.day,
      resets: "00:00 UTC",
      daily_cap: fromBaseUnits(BigInt(b.daily_cap!), d),
      executed: fromBaseUnits(BigInt(b.executed!), d),
      pending: fromBaseUnits(BigInt(b.pending!), d),
      available: fromBaseUnits(BigInt(b.available!), d),
    });
  },
);

/**
 * THE ACTIVITY FEED, which nothing exposed.
 *
 * `list_requests` has been on the contract all along. The MCP had only
 * `vault_request(requestId)` — a lookup by an id you can obtain *only* from a
 * `vault_pay` response — so a user asking "what has my agent been spending
 * on?" had nothing but running totals. For the one question people ask most
 * about an autonomous spender, the answer was a number with no history behind
 * it.
 *
 * THE CAVEAT IS LOAD-BEARING AND THE CONTRACT SAYS SO ITSELF: a BLOCKED
 * request is never stored. The hot path returns the refusal as a value and
 * emits an event, deliberately, because storing rejected attempts would let
 * an agent inflate the vault's storage bill at will. So this feed shows
 * in-flight, settled and failed payments — and an agent that was refused
 * every time looks identical to one that never tried.
 *
 * Reporting that silently would be the worst kind of wrong: "no payments" is
 * exactly what a user wants to hear when the real answer is "twelve refusals
 * you cannot see here". So the caveat ships WITH the data, every time, rather
 * than in a doc nobody opens.
 */
server.tool(
  "vault_history",
  "The vault's payment activity, newest first: what was paid, to whom, when, and how each one ended. Use this for 'what has my agent been spending on?'. No key required. IMPORTANT: refused payments are NOT recorded here — the contract deliberately does not store them, so an agent that was blocked every time looks the same as one that never tried.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("how many to return, newest first. Default 20."),
    fromIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("skip this many of the newest, to page backwards through history."),
  },
  async ({ limit, fromIndex }) => {
    const rows = (await viewFunction(cfg.rpcUrl, requireVault(), "list_requests", {
      from_index: fromIndex ?? 0,
      limit: limit ?? 20,
    })) as Record<string, unknown>[] | null;

    if (!Array.isArray(rows)) return json(rows);

    const meta = await metaFor(rows.map((r) => String(r.token)));
    const payments = rows.map((r) => {
      const m = meta.get(String(r.token)) ?? null;
      const d = m?.decimals ?? cfg.decimals;
      let amount = String(r.amount);
      try {
        amount = fromBaseUnits(BigInt(amount), d);
      } catch {
        /* a figure the contract produced is a fact; surface it unchanged */
      }
      return {
        request_id: r.request_id,
        status: r.status,
        reason: r.reason_code,
        amount,
        token: tokenLabel(String(r.token), m),
        to: r.recipient,
        node_id: r.node_id,
        ...(r.memo ? { memo: r.memo } : {}),
        // Nanoseconds are what the contract stores and not what anyone reads.
        when: new Date(Number(BigInt(String(r.created_at_ns)) / 1_000_000n)).toISOString(),
        charged_on_utc_day: r.reserved_day,
      };
    });

    return json({
      count: payments.length,
      payments,
      not_shown:
        "REFUSED payments are not in this list. The contract does not store a blocked " +
        "request — that would let an agent grow the vault's storage bill by spamming " +
        "refusals — so it returns the reason to the caller and emits an event instead. " +
        "An empty list therefore means 'nothing was paid', NOT 'nothing was attempted'.",
      ...(payments.length === (limit ?? 20)
        ? { more: `Possibly more: pass fromIndex=${(fromIndex ?? 0) + payments.length}.` }
        : {}),
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
  async () => {
    const c = (await viewFunction(cfg.rpcUrl, requireVault(), "get_config", {})) as Record<
      string,
      unknown
    >;
    if (!c || typeof c !== "object") return json(c);

    /**
     * EXPLAIN THE HIERARCHY, because it is the whole product and nothing
     * showed it.
     *
     * `vault_tree` prints `child_cap_sum` and leaves the reader to work out
     * what it implies. The implication is the entire differentiator: budgets
     * are hierarchical, a payment charges every ancestor, and so a SIBLING
     * spending first can exhaust a shared pool while your own cap still reads
     * "25 of 25 available". That is the moment `PARENT_DAILY_BUDGET` arrives
     * and looks like a bug.
     *
     * `strict_allocation` is the switch that decides whether that can happen
     * at all, and as a bare boolean it told nobody anything — a reader cannot
     * tell whether `false` is the safe setting or the dangerous one.
     *
     * Computed from the TREE rather than restated from config, so the numbers
     * are the ones actually in force.
     */
    const tree = (await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {}).catch(
      () => null,
    )) as TreeNode[] | null;
    let allocation: Record<string, unknown> | undefined;
    const root = Array.isArray(tree) ? tree.find((n) => (n as { id?: number }).id === 0) : null;
    if (root) {
      const lim = root.limits?.[0];
      const sum = root.child_cap_sum?.[0];
      if (lim && sum) {
        const meta = (await metaFor([lim.token])).get(lim.token) ?? null;
        const d = meta?.decimals ?? cfg.decimals;
        const cap = BigInt(lim.daily_cap);
        const allocated = BigInt(sum[1]);
        const strict = c.strict_allocation === true;
        allocation = {
          token: tokenLabel(lim.token, meta),
          root_daily_cap: fromBaseUnits(cap, d),
          allocated_to_children: fromBaseUnits(allocated, d),
          unallocated: fromBaseUnits(cap > allocated ? cap - allocated : 0n, d),
          mode: strict ? "strict" : "overcommit",
          meaning: strict
            ? "Children's caps may not sum above the parent's, so each child's cap is " +
              "genuinely its own and a sibling cannot take it."
            : "Children's caps MAY sum above the parent's. A sibling that spends first can " +
              "exhaust the shared pool, and the others are then refused PARENT_DAILY_BUDGET " +
              "while their OWN cap still shows as available. That refusal is the design " +
              "working, not a fault.",
          ...(allocated >= cap && cap > 0n
            ? {
                note:
                  "Children are allocated the ENTIRE root budget, so any second agent would " +
                  "share this pool rather than add to it.",
              }
            : {}),
        };
      }
    }

    /**
     * AN OWNERSHIP TRANSFER IN FLIGHT WAS INVISIBLE.
     *
     * `get_pending_owner` exists and nothing read it. A two-step transfer is
     * the safe design — the new owner must accept — but a half-finished one
     * is exactly the state worth seeing, and `owner` alone shows the OLD
     * owner with no hint that control is mid-handover.
     */
    const pendingOwner = await viewFunction<string | null>(
      cfg.rpcUrl,
      requireVault(),
      "get_pending_owner",
      {},
    ).catch(() => null);

    return json({
      ...c,
      ...(pendingOwner
        ? {
            pending_owner: pendingOwner,
            ownership_note:
              `A transfer to ${pendingOwner} is IN FLIGHT. ${c.owner} still controls this ` +
              `vault until ${pendingOwner} accepts.`,
          }
        : {}),
      // A bare `clock_mode: "production"` invites the question it does not
      // answer. The test clock exists so integration tests can roll a UTC day
      // without waiting; seeing it on a real vault would be alarming.
      clock: c.clock_mode === "production" ? "real UTC time" : `TEST CLOCK (${c.clock_mode})`,
      ...(allocation ? { allocation } : {}),
    });
  },
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
  "List the agents this server can sign as, CROSS-CHECKED against the vault. Says which keys are actually installed and which are dead. Use it before vault_pay when a vault has more than one agent — the signing key decides which budget is charged. No key material is returned.",
  {},
  async () => {
    const vault = requireVault();

    /**
     * THE KEYRING IS A CLAIM. THE CHAIN IS THE FACT.
     *
     * This used to report `listAgents(cfg)` verbatim — role, nodeId and all —
     * straight out of the local file, without ever asking the vault whether it
     * had heard of those keys. So a keyring pointing at the wrong directory
     * reported a healthy, signable agent on node 1 that the vault had never
     * been told about, and `vault_pay` then signed with it and came back
     * NOT_VIRTUAL_AGENT.
     *
     * Measured 2026-11-13: that cost a user a whole session of forensics —
     * reading .claude.json by hand, diffing two keyring files, checking gas
     * balances — to find a single wrong path. The tool whose entire job is
     * "which agents can I sign as" was the one reporting the false positive,
     * which is why nothing caught it earlier.
     *
     * So every entry is now resolved against the vault:
     *   get_virtual_agent_node(pk)  -> the node the CHAIN binds it to, or null
     *   the access-key list         -> is a funded gas key actually installed
     *
     * And the INVERSE is reported too: a gas key on the vault that is not in
     * the keyring is an agent you cannot sign as. Both directions of the
     * disagreement matter, and only one of them was ever visible.
     */
    const local = listAgents(cfg);

    const onChainKeys = await viewAccessKeys(cfg.rpcUrl, vault)
      .then((ks) =>
        ks
          .map((k) => ({
            publicKey: k.public_key,
            gas: (
              k.access_key?.permission as {
                GasKeyFunctionCall?: { balance: string; receiver_id: string; method_names: string[] };
              }
            )?.GasKeyFunctionCall,
          }))
          .filter((k) => k.gas !== undefined),
      )
      .catch(() => null);

    const resolved = await Promise.all(
      local.map(async (r) => {
        if (!r.publicKey) {
          return {
            role: r.role,
            agentId: r.agentId,
            status: "UNVERIFIABLE",
            detail:
              "This keyring entry has no public key recorded, so the chain cannot be asked " +
              "about it. It predates the field. Re-create the agent with vault_add_role.",
          };
        }
        const node = await viewFunction<number | null>(cfg.rpcUrl, vault, "get_virtual_agent_node", {
          public_key: r.publicKey,
        }).catch(() => undefined);

        const installed = onChainKeys?.find((k) => k.publicKey === r.publicKey);
        const balance = installed?.gas?.balance;

        if (node === undefined) {
          return { role: r.role, agentId: r.agentId, status: "UNKNOWN", detail: "could not reach the chain" };
        }
        if (node === null) {
          return {
            role: r.role,
            agentId: r.agentId,
            publicKey: r.publicKey,
            status: "DEAD",
            detail:
              `This key is NOT bound on ${vault}. Signing with it returns NOT_VIRTUAL_AGENT. ` +
              `It is a key for a different vault, or left over from one that was torn down, or ` +
              `this client is reading the wrong keyring. Do NOT use it; vault_add_role creates ` +
              `one the vault will accept.`,
          };
        }
        return {
          role: r.role,
          agentId: r.agentId,
          nodeId: node,
          // The LOCAL nodeId is reported only when it disagrees, because a
          // disagreement means the file is stale and that is worth saying.
          ...(r.nodeId !== undefined && r.nodeId !== node
            ? { staleLocalNodeId: r.nodeId, note: "the keyring records a different node; the chain wins" }
            : {}),
          status: installed ? "USABLE" : "BOUND_BUT_NO_GAS_KEY",
          gasNear: balance ? fromBaseUnits(BigInt(balance), 24) : null,
          ...(installed
            ? {}
            : {
                detail:
                  "Bound to a node, so it may AUTHORISE a payment, but no gas key is installed " +
                  "on the vault, so it cannot SUBMIT one. float-agent installs and funds it.",
              }),
        };
      }),
    );

    const heldKeys = new Set(local.map((r) => r.publicKey).filter(Boolean));
    const unheld = (onChainKeys ?? [])
      .filter((k) => !heldKeys.has(k.publicKey))
      .map((k) => ({
        publicKey: k.publicKey,
        status: "ON_CHAIN_BUT_NO_LOCAL_KEY",
        detail:
          "The vault has this agent installed, but this client does not hold its private key, " +
          "so it cannot sign as it. It belongs to another machine or another client.",
      }));

    const unloadable = listUnloadable(cfg);
    const usable = resolved.filter((r) => r.status === "USABLE").length;

    return json({
      vault,
      usable,
      agents: resolved,
      ...(unheld.length ? { onChainWithoutLocalKey: unheld } : {}),
      // Entries the loader refuses to read. Reported rather than dropped, so
      // "I have a key but this shows nothing" is answerable.
      ...(unloadable.length ? { unreadableKeyringEntries: unloadable } : {}),
      ...(usable === 0
        ? {
            warning:
              `NO USABLE AGENT. vault_pay cannot succeed against ${vault} from this client. ` +
              `Every entry above is dead, unbound, or missing its gas key — the commonest cause ` +
              `is NEAR_VAULT_AGENT_KEYS pointing at a keyring for a different vault.`,
          }
        : {}),
    });
  },
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

    /**
     * HAND THE AGENT THE SENTENCE, do not hope it writes a good one.
     *
     * This used to `return json(out)` — just the contract's four fields — and
     * the instructions said "Report the reason code", so a user who asked to
     * pay someone got `PARENT_PER_TX_LIMIT` back. Correct, and useless to them.
     *
     * A good explanation needs NUMBERS the payment response never carried: the
     * per-payment cap, what is left today. So read them HERE, on the way out,
     * and only when they will be used. The budget read is one view call; the
     * caps come from the tree, fetched only when a limit actually fired.
     *
     * The code is NOT discarded — it moves under `technical`. Knowing exactly
     * which rule fired is a real asset (PARENT_DAILY_BUDGET meaning "a sibling
     * drained the shared pool" is something a flat policy model cannot say),
     * it is just not what a person wants first.
     */
    const o = out as { status?: string; reason_code?: string; node_id?: number };
    const limitFired = /PER_TX_LIMIT|DAILY_BUDGET/.test(o.reason_code ?? "");
    const settled = o.status === "SETTLED";
    const tok = tokenFor(token);

    // The token's own symbol and decimals, cached process-wide, so the sentence
    // says "USDC" and not a 64-character contract id.
    const meta = await tokenMeta(cfg.rpcUrl, tok, (rpc, t) =>
      viewFunction(rpc, t, "ft_metadata", {}),
    ).catch(() => null);
    const dec = meta?.decimals ?? cfg.decimals;

    let perTxCap: string | undefined;
    let available: string | undefined;
    let dailyCap: string | undefined;
    const nodeId = o.node_id;

    if (nodeId !== undefined && (limitFired || settled)) {
      // One view call, and it is the figure BOTH a success and a daily-cap
      // refusal want.
      const b = await viewFunction<{ daily_cap: string; available: string } | null>(
        cfg.rpcUrl,
        vault,
        "get_node_budget",
        { node_id: nodeId, token: tok },
      ).catch(() => null);
      if (b) {
        available = fromBaseUnits(BigInt(b.available), dec);
        dailyCap = fromBaseUnits(BigInt(b.daily_cap), dec);
      }

      if (limitFired) {
        // The SMALLEST per-payment cap from this node up is the one that bound.
        // Fetched only when a limit actually fired, so a settled payment pays
        // for one extra call and not two.
        type CapNode = {
          id: number;
          parent: number | null;
          limits?: { token: string; per_tx_cap: string }[];
        };
        const tree = await viewFunction<CapNode[]>(cfg.rpcUrl, vault, "get_tree", {}).catch(
          () => null,
        );
        if (tree) {
          const byId = new Map(tree.map((n) => [n.id, n]));
          let smallest: bigint | undefined;
          for (
            let cur = byId.get(nodeId);
            cur !== undefined;
            cur = cur.parent === null ? undefined : byId.get(cur.parent)
          ) {
            const lim = (cur.limits ?? []).find((l) => l.token === tok);
            if (!lim) continue;
            const v = BigInt(lim.per_tx_cap);
            if (smallest === undefined || v < smallest) smallest = v;
          }
          if (smallest !== undefined) perTxCap = fromBaseUnits(smallest, dec);
        }
      }
    }

    const explained = explainOutcome({
      status: o.status,
      reason_code: o.reason_code,
      amount,
      recipient,
      symbol: meta?.symbol ?? "tokens",
      perTxCap,
      available,
      dailyCap,
    });

    return json({
      say: explained.say,
      next_step: explained.next,
      money_moved: explained.moved,
      technical: out,
    });
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

/**
 * THE TOOL THAT WAS MISSING, and the gap had teeth.
 *
 * `vault_config` reports `strict_allocation` and now explains, at length,
 * that `overcommit` lets a sibling drain a shared pool and leave another
 * agent refused `PARENT_DAILY_BUDGET` with its own cap apparently free. The
 * payload builder `planSetStrictAllocation` has existed all along, and the
 * DASHBOARD exposes it as an owner action — but no MCP tool did.
 *
 * So the server described a mode worth changing and offered no way to change
 * it, through the one interface an agent can reach. Found by listing all 25
 * tools against the payload builders rather than by anyone hitting it.
 */
server.tool(
  "vault_plan_set_strict_allocation",
  "Build an UNSIGNED payload switching the vault between STRICT and OVERCOMMIT allocation. Strict refuses any change that would let children's caps sum above their parent's, so each child's budget is genuinely its own. Overcommit allows it, and then a sibling spending first can exhaust the shared pool — the others are refused PARENT_DAILY_BUDGET while their own cap still reads available. Read the current mode with vault_config. Not signed by this server.",
  {
    strict: z
      .boolean()
      .describe(
        "true = children may not be allocated more than their parent holds. false = they may, and siblings then compete for the pool.",
      ),
  },
  async ({ strict }) => renderPlan(planSetStrictAllocation(requireVault(), strict)),
);

server.tool(
  "vault_plan_pause",
  "Build an UNSIGNED payload to pause or resume the whole vault. Pausing halts every agent payment. Not signed by this server.",
  { paused: z.boolean() },
  async ({ paused }) => renderPlan(planSetPaused(requireVault(), paused)),
);

server.tool(
  "vault_plan_purge",
  "Build an UNSIGNED payload deleting SETTLED payment records older than a cutoff, to reclaim the vault's storage stake. Spend totals are NOT refunded — purging frees bytes, it does not restore budget. Give `beforeDate` as YYYY-MM-DD; `beforeDay` (a Unix day number) is accepted for exactness. Not signed by this server.",
  {
    /**
     * A DATE, because the raw form asked a human for a Unix day number.
     *
     * `beforeDay: 20768` is what the contract indexes by and is unusable as an
     * input: nobody knows today's number, and an off-by-one silently purges a
     * day more or less than intended — of records that are then gone. The same
     * figure was shown in `vault_budget` output and fixed there for the same
     * reason; this is the input side of it.
     *
     * `beforeDay` survives for callers that genuinely have one, and because a
     * test-clock vault's day is NOT derivable from the wall clock.
     */
    beforeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "beforeDate must be YYYY-MM-DD")
      .optional()
      .describe("purge records from strictly BEFORE this UTC date, e.g. 2026-10-01"),
    beforeDay: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("the raw Unix day number, if you have it. Overrides beforeDate."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("how many records at most, default 100. Large purges may exceed the gas limit."),
  },
  async ({ beforeDate, beforeDay, limit }) => {
    // EXACTLY ONE CUTOFF, and no default. A purge deletes records
    // irreversibly; guessing "today" for a caller who forgot the argument
    // would silently purge everything settled.
    if (beforeDay === undefined && beforeDate === undefined) {
      return text(
        `Give a cutoff: beforeDate "YYYY-MM-DD" (records strictly before it are removed), ` +
          `or beforeDay if you have the raw number. There is deliberately no default — ` +
          `a purge cannot be undone, and "today" would remove every settled record.`,
      );
    }
    let day = beforeDay;
    if (day === undefined) {
      const ms = Date.parse(`${beforeDate}T00:00:00Z`);
      if (Number.isNaN(ms)) return text(`"${beforeDate}" is not a real date.`);
      day = Math.floor(ms / 86_400_000);
    }
    return renderPlan(planPurgeSettled(requireVault(), day, limit ?? 100));
  },
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
    // "Send 42 out of the vault" reads the same whether 42 is part of the
    // balance or ALL of it, and those are different decisions: the second
    // empties the vault, can fail in-flight payments, and is the step before a
    // teardown. The signer sees a summary, not this code.
    let emptying = false;
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
      emptying = true;
    } else {
      // `toBaseUnits` returns a bigint; the payload carries base units as a
      // STRING, because that is what the contract's U128 arg expects.
      base = toBaseUnits(amount, cfg.decimals).toString();
    }

    const plan = planWithdraw(vault, tok, base, receiverId, cfg.decimals);
    if (emptying) {
      plan.warnings = [
        `This is the vault's ENTIRE ${tok} balance — it will hold zero afterwards. ` +
          `You did not name an amount, so the figure above was read from the chain.`,
        ...plan.warnings,
      ];
      plan.summary = `${plan.summary} (the ENTIRE balance)`;
    }
    return renderPlan(plan);
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
      /**
       * POINT AT THE USER-FACING CLI, not the repo's internal script.
       *
       * This emitted `NETWORK=… VAULT=… OWNER=… TOKEN=… CONFIRM_MAINNET=1
       * EXPECT_TOKENS=1 node scripts/teardown-vault.mjs` — six environment
       * variables, a path only someone who cloned the repo has, no dry run,
       * and a delete at the end. For the one action a user takes when they are
       * already nervous, that is the worst possible interface, and it is not
       * what the product ships.
       *
       * `float-exit` is the published CLI for exactly this, and it is better
       * in every way that matters here: two flags, `--dry-run`, numbered steps,
       * "would" phrasing for everything it has not done yet, and an explicit
       * "This is irreversible" before the delete. It works via npx, so it needs
       * no checkout. `--network` defaults to mainnet.
       *
       * I pointed at the internal script for a week and then spent a round
       * fixing ITS ergonomics — adding the missing CONFIRM_MAINNET and
       * EXPECT_TOKENS — when the friendly path already existed. Fixing the
       * hard road is not the same as checking whether the easy one is there.
       *
       * THE DRY RUN LEADS, deliberately. The destructive form is given second
       * and separately, so copying the first thing you see cannot delete a
       * vault.
       *
       * THE `-p` IS LOAD-BEARING. float-exit is a BIN of create-float, not a
       * package of its own, so invoking it by bare scoped name 404s on the
       * registry. `scripts/check-npx-commands.mjs` enforces this — and it
       * flagged THIS comment when the wrong form was written out as a
       * counter-example, which is the check working: it cannot tell a warning
       * from an instruction, and neither can someone copying a line out of a
       * file. So the bad form is described rather than spelled.
       */
      command: signable
        ? {
            first_look:
              `npx -p @floatonnear/create-float float-exit --owner ${config?.owner ?? "<owner>"} ` +
              `--vault ${vault}${cfg.network === "mainnet" ? "" : ` --network ${cfg.network}`} --dry-run`,
            then_for_real:
              `npx -p @floatonnear/create-float float-exit --owner ${config?.owner ?? "<owner>"} ` +
              `--vault ${vault}${cfg.network === "mainnet" ? "" : ` --network ${cfg.network}`}`,
            what_the_dry_run_shows:
              "Every step it WOULD take, the exact NEAR and tokens coming back, and which " +
              "account they go to — without touching anything. Run it first.",
            needs:
              `A full-access key for ${config?.owner ?? "the owner"} in ~/.near-credentials. ` +
              `The owner's key is already full-access ON the vault (the factory adds it at ` +
              `creation), so no separate vault key is needed.`,
          }
        : "(none — nothing can sign as this vault)",
      note:
        "Read-only. This server holds at most a restricted agent key and signed nothing. " +
        "Run the command yourself, after the token withdrawal has settled.",
    });
  },
);

await server.connect(new StdioServerTransport());

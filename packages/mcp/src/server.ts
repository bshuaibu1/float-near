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
 *   NEAR_VAULT_RPC_URL         default https://test.rpc.fastnear.com
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
 *                              https://app.usefloat.xyz
 *
 * A user with NO vault can therefore run this server with nothing configured,
 * call `vault_create`, and be onboarded — which is the point. Every other tool
 * reports that NEAR_VAULT_CONTRACT is unset rather than guessing one.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fromBaseUnits, toBaseUnits } from "./amounts.js";
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

import { listRoles, selectRole } from "./roles.js";

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

const cfg = {
  vault: process.env.NEAR_VAULT_CONTRACT ?? "",
  rpcUrl: process.env.NEAR_VAULT_RPC_URL ?? DEFAULT_RPC_URL,
  token: process.env.NEAR_VAULT_TOKEN ?? "",
  decimals: Number(process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6"),
  // The credentials file carries the account as well as the key, so one path
  // can supply both halves. An explicit NEAR_VAULT_AGENT_ID still wins, and
  // `requireAgentKey` refuses the pair if the two disagree.
  agentId: process.env.NEAR_VAULT_AGENT_ID ?? agentKeySource.accountId,
  agentKey: agentKeySource.secret,
  agentKeyError: agentKeySource.error,
  agentKeyAccountId: agentKeySource.accountId,
  network: process.env.NEAR_VAULT_NETWORK ?? "testnet",
  // Onboarding only. Both have safe defaults and neither is needed by any
  // tool that touches an existing vault.
  factory: process.env.NEAR_VAULT_FACTORY,
  appUrl: process.env.NEAR_VAULT_APP_URL ?? "https://app.usefloat.xyz",
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
const server = new McpServer({ name: "float", version: "0.4.0" });

// ----------------------------------------------------------------- reads

server.tool(
  "vault_tree",
  "Read the whole budget tree: every node, its caps, parent, bound agent account, cooldown and freeze state. No key required.",
  {},
  async () => json(await viewFunction(cfg.rpcUrl, requireVault(), "get_tree", {})),
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
    if (!b) return text(`node ${nodeId} has no limit for that token`);
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
  async ({ requestId }) =>
    json(await viewFunction(cfg.rpcUrl, requireVault(), "get_request", { request_id: requestId })),
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
      listRoles(cfg).map((r) => ({ role: r.role, nodeId: r.nodeId, agentId: r.agentId })),
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
  },
  async ({ owner, network, factory, bindAgent }) => {
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
    const rpc = cfg.rpcUrl;

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

server.tool(
  "vault_plan_set_caps",
  "Build an UNSIGNED payload to change a node's daily and per-payment caps. Not signed by this server.",
  { nodeId: z.number().int().min(0), limits: limitShape },
  async ({ nodeId, limits }) => renderPlan(planSetNodeCaps(requireVault(), nodeId, limits)),
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
  async ({ nodeId, frozen }) => renderPlan(planFreezeNode(requireVault(), nodeId, frozen)),
);

server.tool(
  "vault_plan_set_recipients",
  "Build an UNSIGNED payload to set a node's payee allowlist. This REPLACES the inherited list rather than adding to it; pass null to inherit. Not signed by this server.",
  { nodeId: z.number().int().min(0), recipients: z.array(z.string()).nullable() },
  async ({ nodeId, recipients }) =>
    renderPlan(planSetRecipients(requireVault(), nodeId, recipients)),
);

server.tool(
  "vault_plan_set_cooldown",
  "Build an UNSIGNED payload to set the minimum seconds between a node's payments. Not signed by this server.",
  { nodeId: z.number().int().min(0), cooldownSec: z.number().int().min(0) },
  async ({ nodeId, cooldownSec }) =>
    renderPlan(planSetCooldown(requireVault(), nodeId, cooldownSec)),
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

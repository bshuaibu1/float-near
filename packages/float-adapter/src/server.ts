#!/usr/bin/env node
/**
 * Serves the existing Float dashboard's /v1 API from NEAR vault views.
 *
 * The point of this process: the Float dashboard runs UNCHANGED. Same
 * components, same logo, same styles, same screens — only
 * NEXT_PUBLIC_FLOAT_API_URL points here instead of at the Solana backend.
 *
 * node:http with no framework, because the whole job is four JSON endpoints.
 *
 *   NEAR_VAULT_CONTRACT        required
 *   NEAR_VAULT_RPC_URL         default https://test.rpc.fastnear.com
 *   NEAR_VAULT_TOKEN           required (the NEP-141 the vault pays in)
 *   NEAR_VAULT_TOKEN_DECIMALS  default 6
 *   NEAR_VAULT_AGENT_ID        only needed for POST /v1/pay. Taken from the key
 *                              file's `account_id` when one is given.
 *   NEAR_VAULT_AGENT_KEY       only needed for POST /v1/pay (the restricted key)
 *   NEAR_VAULT_AGENT_KEY_FILE  PREFERRED over the inline value above: a PATH to
 *                              a ~/.near-credentials-shaped JSON file or a bare
 *                              key file. See key-file.ts — a path is not a
 *                              secret, so reading this config to check which
 *                              vault is wired up stops printing a live private
 *                              key. If both are set the FILE wins.
 *   FLOAT_QUOTE_SIGNER_KEY     32-byte hex, for rail=intents
 *   FLOAT_QUOTE_SIGNER_KEY_FILE  the same, as a path
 *   PORT                       default 8787 (Float's dashboard default)
 */

import { createServer } from "node:http";
import { resolveHost, corsHeaders, authorize, classifyError, fromCaller } from "./gate.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { toBaseUnits, fromBaseUnits } from "@floatonnear/mcp/amounts";
import {
  accountExists,
  newRequestId,
  rpcForNetwork,
  RPC_BY_NETWORK,
  viewAccessKeys,
  viewFunction,
} from "@floatonnear/mcp";
import { isUnavailable } from "./unavailable.js";
import { buildRoute, sendRequestPayment, type RouteArg } from "@floatonnear/mcp/sign";
import { getQuote, signBinding, toBase64 } from "@floatonnear/mcp/quote";
import { toCliCommand } from "@floatonnear/mcp/payloads";
import { planOwnerAction, type OwnerPlanRequest } from "./owner-plan.js";

import {
  getAgentKeys,
  getDashboard,
  getSpendHistory,
  getVaultInfo,
  paymentFromOutcome,
  type AdapterConfig,
} from "./handlers.js";
import type { VaultNode } from "./map.js";
import { AgentSelectionError, loadKeyring, selectAgent } from "./keyring.js";
import {
  adoptBlockedStore,
  BlockedFollower,
  createRpc,
  emptyStore,
  type BlockedStore,
} from "./blocked-scan.js";
import { parseEnvFile, applyEnvFile } from "./env-file.js";
import { resolveKeySource } from "@floatonnear/mcp/key-file";

// Load FLOAT_ENV_FILE before anything reads process.env.
//
// This replaces `set -a && . .float/adapter.env && set +a` in every deploy
// path. That idiom makes the SHELL execute a file holding the agent key, the
// quote signer and the API token, and it has already failed for real on a single
// unquoted value containing a space (see env-file.ts). It also does not exist in
// PowerShell, which is why starting the adapter on Windows needed a bespoke
// Get-Content incantation recorded in this project's memory.
//
// Real environment variables win over the file, so one service can be pointed
// at a different port or contract without editing shared secrets.
if (process.env.FLOAT_ENV_FILE) {
  const envPath = process.env.FLOAT_ENV_FILE;
  if (!existsSync(envPath)) {
    // Fail loudly. A missing env file that is silently ignored starts an adapter
    // with no API token, which disables every mutating route and looks like a
    // code bug rather than a deploy mistake.
    console.error(`FATAL: FLOAT_ENV_FILE=${envPath} does not exist`);
    process.exit(1);
  }
  const applied = applyEnvFile(parseEnvFile(readFileSync(envPath, "utf8")));
  // NAMES only, never values: this line goes to pm2's log on every restart.
  console.log(`env file: ${envPath} — set ${applied.length} (${applied.join(", ") || "none"})`);
}

/**
 * Secrets, from a FILE where one is named. See key-file.ts for why.
 *
 * AFTER the FLOAT_ENV_FILE block above, deliberately: the env file may be where
 * NEAR_VAULT_AGENT_KEY_FILE itself is set, so resolving a path before that file
 * has been applied would miss it.
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
// NAMES only, never values: this goes to pm2's log on every restart.
for (const note of [...agentKeySource.warnings, ...quoteSignerSource.warnings]) {
  console.log(`key source: ${note}`);
}

/**
 * LOUD, BUT NOT FATAL — and the choice is not obvious, so here is the argument.
 *
 * The missing-FLOAT_ENV_FILE case above exits, and this looks like the same
 * thing. It is not: without that file NOTHING is configured, so the process
 * cannot do its job at all. A missing agent key leaves every READ working, and
 * reads are most of what the dashboard asks for. Exiting would turn a mistyped
 * path into a pm2 crash-loop that takes the whole dashboard down.
 *
 * The decisive argument is consistency with what this adapter already does: an
 * ABSENT NEAR_VAULT_AGENT_KEY has always started fine and failed at /v1/pay
 * with a message from `selectAgent`. A key file that cannot be read is the same
 * category of problem, so it travels the same route — carried into the keyring
 * as `agentKeyError`, which reports it there INSTEAD of the generic "set
 * NEAR_VAULT_AGENT_ID and NEAR_VAULT_AGENT_KEY". That generic message is the
 * one thing this must never say here, because it reads as advice to paste the
 * secret back inline.
 */
for (const err of [agentKeySource.error, quoteSignerSource.error]) {
  if (err) console.error(`key source: ${err} — reads are unaffected; paying will fail.`);
}

/**
 * The network, resolved once and BEFORE `env` so `rpcUrl` can follow it.
 *
 * MAINNET IS THE DEFAULT, matching @floatonnear/mcp and the five CLIs. It was
 * testnet here while every CLI defaulted to mainnet, so an operator who created
 * a mainnet vault and started this adapter served a dashboard that queried
 * testnet and reported the vault missing.
 *
 * An unrecognised value FAILS CLOSED for the same reason it does in the MCP:
 * `rpcForNetwork` resolves anything it does not recognise to a testnet
 * endpoint, so `NEAR_VAULT_NETWORK=Mainnet` would answer mainnet questions
 * about the wrong chain rather than complaining.
 */
const NETWORK = process.env.NEAR_VAULT_NETWORK ?? "mainnet";
if (!Object.hasOwn(RPC_BY_NETWORK, NETWORK)) {
  console.error(
    `float-adapter: NEAR_VAULT_NETWORK is "${NETWORK}", which is not a known network ` +
      `(${Object.keys(RPC_BY_NETWORK).join(", ")}). Refusing to start rather than resolving ` +
      `to a testnet endpoint and answering questions about the wrong chain.`,
  );
  process.exit(1);
}

const env = {
  vault: process.env.NEAR_VAULT_CONTRACT ?? "",
  /**
   * The factory, needed only to answer "which vault is MINE?" for a visitor.
   *
   * Optional: a local single-vault setup never asks, and the resolve route
   * reports it is unconfigured rather than guessing a factory — guessing one
   * would hand a visitor an address that is not theirs, under a factory
   * nobody chose.
   */
  factory: process.env.NEAR_VAULT_FACTORY ?? "",
  /**
   * THE RPC FOLLOWS THE NETWORK. It did not, and the same bug was fixed in
   * @floatonnear/mcp earlier today without anyone checking here.
   *
   * This was `NEAR_VAULT_RPC_URL ?? "https://test.rpc.fastnear.com"` — the
   * TESTNET endpoint, regardless of NEAR_VAULT_NETWORK. So an operator running
   * `NEAR_VAULT_NETWORK=mainnet` and nothing else queried testnet about a
   * mainnet vault and got:
   *
   *   account usefloat.near does not exist while viewing
   *
   * which names the account, not the chain, and reads as "your factory is
   * gone". Measured 2026-11-11 by starting this adapter exactly as a new user
   * would.
   *
   * THE DEPLOYED COPY WORKED ONLY BY ACCIDENT: deploy-skill-host.sh sets
   * NEAR_VAULT_RPC_URL explicitly, so the box masked the bug while every
   * hand-run instance hit it. A default that is only ever correct because
   * something else overrides it is not a default, it is a trap with one
   * authorised path around it.
   */
  rpcUrl: rpcForNetwork(NETWORK, {
    configuredNetwork: NETWORK,
    override: process.env.NEAR_VAULT_RPC_URL,
  }),
  token: process.env.NEAR_VAULT_TOKEN ?? "",
  // Loopback unless explicitly overridden — exposure is opted into.
  host: resolveHost(process.env.HOST),
  // Required for mutating routes. Absent => those routes are disabled, not open.
  apiToken: process.env.FLOAT_API_TOKEN,
  // Exact-match CORS origin; the dashboard's dev server by default.
  allowedOrigin: process.env.FLOAT_ALLOWED_ORIGIN ?? "http://localhost:3000",
  decimals: Number(process.env.NEAR_VAULT_TOKEN_DECIMALS ?? "6"),
  // The credentials file carries the account as well as the key, so one path
  // supplies both halves. An explicit NEAR_VAULT_AGENT_ID still wins.
  agentId: process.env.NEAR_VAULT_AGENT_ID ?? agentKeySource.accountId,
  agentKey: agentKeySource.secret,
  // WHY THIS IS THREADED THROUGH rather than handled here: an empty keyring has
  // three possible causes and they need different fixes. `loadKeyring` already
  // distinguishes two of them (`skippedOtherVault`); this is the third.
  agentKeyError: agentKeySource.error,
  port: Number(process.env.PORT ?? "8787"),
  // Where the relayer records Base deliveries. Read fresh on each request so a
  // delivery that lands while this server is running appears without a
  // restart — the file is small and this is a dashboard, not a hot path.
  relayLedger: process.env.RELAY_LEDGER ?? ".demo/relay-ledger.json",
  // Refusals recovered from chain by scripts/scan-blocked.mjs.
  //
  // PER-VAULT PATH, and it MUST match the scanner's default or the two write
  // and read different files while both look healthy — the scan reports
  // refusals recorded, the dashboard shows none, and nothing says why.
  //
  // The old shared `.demo/blocked-log.json` is what let one vault's refusals
  // render on another's dashboard: the scanner defaulted to a different vault
  // entirely, wrote there, and the adapter read it. Putting the vault id in
  // the filename makes that impossible rather than merely detectable.
  blockedLog:
    process.env.BLOCKED_LOG ??
    `.demo/blocked-log.${(process.env.NEAR_VAULT_CONTRACT ?? "unset").replace(/[^a-z0-9._-]/gi, "_")}.json`,
  // Several agents, so the payment path can exercise the hierarchy the
  // dashboard draws. This is the file create-float writes.
  agentKeysPath: process.env.NEAR_VAULT_AGENT_KEYS ?? ".float/agent-keys.json",
  // Follow the chain for refusals. On by default: a refusal is never stored
  // in contract state, so without this the only ones the dashboard can show
  // are those this process happened to witness itself.
  followBlocked: process.env.BLOCKED_FOLLOW !== "0",
  followIntervalMs: Number(process.env.BLOCKED_FOLLOW_INTERVAL_MS ?? "10000"),
  // Binds a payee to a one-time deposit address for the cross-chain rail.
  // Absent by default: whoever holds it can redirect any Intents payment the
  // budget allows, so it is opt-in and belongs to the operator.
  quoteSignerKey: quoteSignerSource.secret,
  quoteSignerError: quoteSignerSource.error,
};

const keyring = loadKeyring(env);

/**
 * JSON-RPC for the follower's block and chunk calls, with pacing and backoff.
 *
 * Deliberately not a bare fetch. Public endpoints rate-limit, and without
 * retries every transient 429 became a PERMANENT gap in the coverage map,
 * because a block that could not be read is recorded as unread. One load test
 * left 33 fragmented holes of three to twenty blocks each — every one
 * technically honest, and collectively useless, since nobody is going to
 * backfill a five-block gap. A hole should mean "genuinely unavailable", not
 * "the endpoint was briefly busy".
 */
const rpc = createRpc(env.rpcUrl, {
  onThrottle: (ms) => console.log(`[blocked-follow] rate-limited, waiting ${ms}ms`),
});

function loadBlockedStore(): BlockedStore {
  try {
    if (!existsSync(env.blockedLog)) return emptyStore(env.vault);
    const parsed = JSON.parse(readFileSync(env.blockedLog, "utf8"));
    // VAULT-SCOPED. `parsed.vault ?? env.vault` read the field and never
    // compared it, so a log written for another vault loaded wholesale —
    // observed live, six refusals from v3.floatvault-12329.testnet rendered on
    // a one-node vault's activity page. See `adoptBlockedStore`.
    const store = adoptBlockedStore(parsed, env.vault);
    if (parsed.vault && parsed.vault !== env.vault) {
      console.log(
        `[blocked] ignoring ${env.blockedLog}: it belongs to ${parsed.vault}, not ${env.vault}. ` +
          `Refusals for this vault are UNKNOWN, not absent — rescan with scripts/scan-blocked.mjs.`,
      );
    }
    return store;
  } catch {
    // A corrupt file must not stop the server, and must not be mistaken for
    // "no refusals" — a null cursor makes the follower restart from the head
    // rather than claim coverage it does not have.
    return emptyStore(env.vault);
  }
}

function saveBlockedStore(s: BlockedStore): void {
  mkdirSync(dirname(env.blockedLog), { recursive: true });
  writeFileSync(env.blockedLog, JSON.stringify(s, null, 2) + "\n");
}

if (!env.vault || !env.token) {
  console.error("NEAR_VAULT_CONTRACT and NEAR_VAULT_TOKEN are required");
  process.exit(1);
}

const cfg: AdapterConfig = {
  token: env.token,
  decimals: env.decimals,
  // VIRTUAL AGENTS LIVE HERE. Their keys are NEP-611 gas keys on the vault
  // itself rather than on a sub-account, so enumerating them needs the vault
  // id. Without it `getAgentKeys` degrades to account-bound agents only —
  // which, now that sub-accounts are retired, is an empty list.
  vault: env.vault,
  blockedRing: [],
  maxBlocked: 50,
};

const view = <T,>(method: string, args: unknown = {}) =>
  viewFunction<T>(env.rpcUrl, env.vault, method, args);

/**
 * A NEAR account id, loosely — enough to keep junk out of an RPC call.
 *
 * Not a full grammar check: the chain is the authority and answers an unknown
 * account with an error we surface anyway. This exists so a query string
 * cannot push arbitrary text into a view call, and so the 64-character cap is
 * refused here rather than producing a confusing RPC failure.
 */
const LOOKS_LIKE_ACCOUNT = /^[a-z0-9._-]{2,64}$/;

/**
 * WHICH VAULT THIS REQUEST IS ABOUT.
 *
 * The adapter used to serve exactly one vault — `NEAR_VAULT_CONTRACT` — and
 * ignore the `?owner=` the dashboard had been sending all along. Hosted, that
 * means every visitor sees the operator's vault, and the figures look like
 * theirs. Nothing leaks (a vault's state is public on chain) but a person acts
 * on numbers that are not theirs, which is worse than being told nothing.
 *
 * So reads honour `?vault=`. The configured vault remains the default, which
 * keeps every local setup working unchanged.
 *
 * `/v1/pay` MUST NOT honour it, and does not: that path uses `env.vault`
 * directly, because the agent key it signs with is bound to one vault and
 * pointing it elsewhere is meaningless at best.
 */
function vaultFor(url: URL): { vault: string; isDefault: boolean; error?: string } {
  const asked = url.searchParams.get("vault")?.trim();
  if (!asked) return { vault: env.vault, isDefault: true };
  if (!LOOKS_LIKE_ACCOUNT.test(asked)) {
    return { vault: env.vault, isDefault: true, error: `"${asked}" is not a NEAR account id` };
  }
  return { vault: asked, isDefault: asked === env.vault };
}

/**
 * The per-request config and view function.
 *
 * `blockedRing` and `chainBlocked` are EMPTIED for any vault that is not the
 * configured one, and that is the subtle part. Both are populated by watching
 * `env.vault` — the follower and the scan store. Sharing them would attribute
 * the operator's refusals to a visitor's vault: a payment they never made,
 * refused for a reason that was never about them. Empty is correct, and the
 * coverage banner already says "outside the scanned range they are UNKNOWN,
 * not absent", which is exactly the truth for a vault nobody has scanned.
 */
function perRequest(vault: string, isDefault: boolean) {
  const reqCfg: AdapterConfig = isDefault
    ? cfg
    : { ...cfg, vault, blockedRing: [], chainBlocked: {} };
  const reqView = <T,>(method: string, args: unknown = {}) =>
    viewFunction<T>(env.rpcUrl, vault, method, args);
  return { reqCfg, reqView };
}

/**
 * The network this vault lives on, read ONCE.
 *
 * `get_config.network` is immutable for a given vault — a contract cannot
 * migrate chains — so re-reading it per request buys nothing and costs a
 * round trip on a path that is otherwise pure local computation.
 *
 * The env var is a FALLBACK, not the primary. The chain is authoritative: an
 * operator who mistypes it would otherwise get CLI commands carrying the wrong
 * `network-config`, which fail after the owner has already approved them.
 * Asking the vault first means the env var can only help when the chain is
 * unreachable, never override it.
 *
 * ONE CONFIG NAME. This read `NEAR_NETWORK`, which appeared nowhere else in the
 * product — every other surface uses `NEAR_VAULT_NETWORK` (33 occurrences
 * against this one). So an operator who configured the adapter the documented
 * way, and then lost RPC, fell through to an env var they had never been told
 * to set, and the adapter answered with whatever `networkName()` threw instead.
 * A second spelling of the same setting is a parallel flow, and it only shows
 * up in the one case nobody tests: the chain being down.
 *
 * `NEAR_NETWORK` is still honoured so an existing deployment does not break,
 * but it is second and it is not documented.
 */
let cachedNetwork: string | undefined;
async function networkName(): Promise<string> {
  if (cachedNetwork) return cachedNetwork;
  try {
    const c = await viewFunction<{ network: string }>(env.rpcUrl, env.vault, "get_config", {});
    cachedNetwork = c.network;
    return cachedNetwork;
  } catch (e) {
    const fallback =
      process.env.NEAR_VAULT_NETWORK?.trim() || process.env.NEAR_NETWORK?.trim();
    if (fallback) return fallback; // NOT cached: the chain still wins once reachable
    throw e;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${env.port}`);

  // CORS echoes ONLY the configured origin. The previous wildcard plus an
  // approving preflight meant any page the operator had open could POST JSON
  // here, and /v1/pay signs with the agent key.
  for (const [k, v] of Object.entries(corsHeaders(env.allowedOrigin, req.headers.origin))) {
    res.setHeader(k, v);
  }
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  // AUTH BEFORE ANY HANDLER. Previously a POST reached body validation and
  // answered 400 — there was nothing to fail at. Mutating routes require a
  // bearer token; GETs stay open behind a loopback bind.
  //
  // THE ROUTE DECIDES, NOT THE METHOD. Gating every non-GET meant a hosted
  // dashboard could offer no owner actions at all, because the token cannot
  // exist in public: the dashboard proxy attaches it without authenticating
  // the caller. `/v1/owner-plan` returns an UNSIGNED payload the owner
  // approves in their own wallet, so it needs no token; `/v1/pay` signs with
  // the agent key and always does. Unknown routes stay shut — see gate.ts.
  const verdict = authorize({
    method: req.method ?? "GET",
    path: url.pathname,
    authHeader: req.headers.authorization,
    token: env.apiToken,
  });
  if (!verdict.ok) {
    res.writeHead(verdict.status, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: verdict.error }));
  }

  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // A missing or malformed ledger yields NO deliveries, never a crash and
  // never an invented one: the worst it can do is under-report delivery, which
  // is the safe direction for a claim the chain cannot back.
  // Chain-recovered refusals, re-read per request so a scan that runs while
  // the server is up appears without a restart. A missing or malformed file
  // yields none rather than crashing — the failure direction is always to
  // show fewer refusals than happened, never to invent one.
  {
    // VAULT-SCOPED HERE TOO. `loadBlockedStore` above was fixed first and this
    // reader was missed, so the leak survived the fix completely: six refusals
    // from v3.floatvault-12329.testnet still rendered on a one-node vault's
    // activity page, and the adapter log showed no complaint because the
    // complaint lives in the other function. Two readers of one file, one
    // guard. Caught only by checking the live endpoint after the fix.
    const parsed = (() => {
      try {
        if (!existsSync(env.blockedLog)) return null;
        const raw = JSON.parse(readFileSync(env.blockedLog, "utf8"));
        if (raw?.vault && raw.vault !== env.vault) return null;
        return raw;
      } catch {
        return null;
      }
    })();
    cfg.chainBlocked = parsed?.blocked ?? {};
    cfg.blockedScan =
      parsed && typeof parsed.scannedFrom === "number" && typeof parsed.scannedTo === "number"
        ? {
            from: parsed.scannedFrom,
            to: parsed.scannedTo,
            // Without these the range is a claim about blocks nobody read.
            holes: Array.isArray(parsed.holes) ? parsed.holes : [],
          }
        : null;
  }

  cfg.deliveries = (() => {
    try {
      if (!existsSync(env.relayLedger)) return {};
      return JSON.parse(readFileSync(env.relayLedger, "utf8"));
    } catch {
      return {};
    }
  })();

  try {
    if (url.pathname === "/v1/dashboard") {
      {
        const { vault, isDefault, error } = vaultFor(url);
        if (error) return send(400, { error });
        const { reqCfg, reqView } = perRequest(vault, isDefault);
        return send(200, await getDashboard(reqView, reqCfg));
      }
    }

    if (url.pathname === "/v1/spend-history") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "25"), 50);
      const offset = Number(url.searchParams.get("offset") ?? "0");
      {
        const { vault, isDefault, error } = vaultFor(url);
        if (error) return send(400, { error });
        const { reqCfg, reqView } = perRequest(vault, isDefault);
        return send(200, await getSpendHistory(reqView, reqCfg, limit, offset));
      }
    }

    // Where this vault lives. The UI reads the chain from here rather than
    // hardcoding it, so it cannot link a testnet vault to a mainnet explorer.
    /**
     * WHICH VAULT BELONGS TO THIS OWNER?
     *
     * A hosted dashboard has to answer this before it can read anything: the
     * visitor connects a wallet and the page needs an address to ask about.
     *
     * ASKED OF THE FACTORY, never derived here. The factory exposes
     * `vault_id_for` precisely so the derivation has ONE implementation —
     * `create.ts` says so in capitals — and a copy in this file would be a
     * second place for it to drift. The derivation is also not injective
     * (`a.b.near` and `a-b.near` collide), so a local guess could name a
     * vault owned by somebody else.
     *
     * `vault: null` is a real answer, not an error: it means this owner has
     * no legal vault id, which is the case for an implicit account. The page
     * should offer to create one rather than showing a failure.
     */
    if (url.pathname === "/v1/resolve") {
      const owner = url.searchParams.get("owner")?.trim();
      if (!owner) return send(400, { error: "owner is required" });
      if (!LOOKS_LIKE_ACCOUNT.test(owner)) {
        return send(400, { error: `"${owner}" is not a NEAR account id` });
      }
      if (!env.factory) {
        return send(200, {
          owner,
          vault: null,
          exists: false,
          reason: "NEAR_VAULT_FACTORY is not set on this adapter, so it cannot derive a vault id.",
        });
      }
      /**
       * COULD NOT ASK != THE ANSWER IS NO.
       *
       * This was `.catch(() => null)`, so a transient RPC failure was
       * reported as "an implicit account cannot have a vault" with HTTP 200 —
       * a confident false claim about the caller's account, which the
       * dashboard proxy then cached for the life of the process. Measured
       * 2026-11-09: six identical calls gave four answers and two nulls,
       * because the background refusal-follower saturates the RPC budget.
       *
       * 503 is the honest status. It is also what stops the proxy caching it.
       */
      let derived: string | null;
      try {
        derived = await viewFunction<string | null>(
          env.rpcUrl,
          env.factory,
          "vault_id_for",
          { owner },
        );
      } catch (e) {
        if (isUnavailable(e)) {
          return send(503, {
            error: "UPSTREAM_UNAVAILABLE",
            owner,
            detail:
              "Could not reach the chain to derive this account's vault id, so " +
              "whether it has one is UNKNOWN — not no. Retry shortly.",
          });
        }
        throw e;
      }
      if (!derived) {
        return send(200, {
          owner,
          vault: null,
          exists: false,
          reason:
            "No legal vault id for that account under this factory. An implicit " +
            "account (64 hex characters) cannot have one; use a named account.",
        });
      }
      // Whether it has been CREATED is a separate question from whether it
      // could exist, and the page needs both: one says "here is your vault",
      // the other says "you do not have one yet".
      //
      // A view call that throws is the account not existing; it is not an
      // adapter failure, so it must not surface as one.
      //
      // SAME RULE FOR `exists`, and this one was the demo-killer: a 429 made
      // it `false`, so an owner with a populated vault was shown the
      // create-one empty state and invited to create a vault that already
      // exists. `exists` flickered false->true across one measured run.
      let exists: boolean;
      try {
        exists = await accountExists(env.rpcUrl, derived);
      } catch (e) {
        if (isUnavailable(e)) {
          return send(503, {
            error: "UPSTREAM_UNAVAILABLE",
            owner,
            vault: derived,
            detail:
              `Derived ${derived}, but could not reach the chain to check whether ` +
              "it exists. Whether you have a vault is UNKNOWN — not no. Retry shortly.",
          });
        }
        /**
         * NEVER `exists = false` HERE. `accountExists` returns false WITHOUT
         * throwing for a genuine absence (UNKNOWN_ACCOUNT); it throws only
         * when it cannot tell. So every throw is uncertainty, and turning
         * uncertainty into "you have no vault" is the exact bug this route
         * was already fixed for once.
         */
        return send(503, {
          error: "UPSTREAM_UNAVAILABLE",
          owner,
          vault: derived,
          detail:
            `Derived ${derived}, but could not determine whether it exists: ` +
            `${e instanceof Error ? e.message : String(e)}. UNKNOWN, not no.`,
        });
      }
      return send(200, { owner, vault: derived, exists, factory: env.factory });
    }

    if (url.pathname === "/v1/vault-info") {
      const { vault, isDefault, error } = vaultFor(url);
      if (error) return send(400, { error });
      const { reqCfg, reqView } = perRequest(vault, isDefault);
      return send(
        200,
        await getVaultInfo(reqView, reqCfg, (contractId, method, args) =>
          viewFunction<string | null>(env.rpcUrl, contractId, method, args ?? {}),
        ),
      );
    }

    // Agent accounts WITH their access keys read from the chain. The key
    // restriction is the product's central claim, so the page that states it
    // reads the real permission instead of a constant.
    if (url.pathname === "/v1/agent-keys") {
      {
        const { vault, isDefault, error } = vaultFor(url);
        if (error) return send(400, { error });
        const { reqCfg, reqView } = perRequest(vault, isDefault);
        return send(200, await getAgentKeys(reqView, (id) => viewAccessKeys(env.rpcUrl, id), reqCfg));
      }
    }

    /**
     * An UNSIGNED owner payload for a policy change, plus the exact CLI command.
     *
     * Deliberately not a write endpoint. Owner methods change who can spend the
     * treasury, so this server never signs them — it only ever holds an agent
     * key that can call `request_payment`. The dashboard therefore shows the
     * owner what to run rather than claiming to have saved anything, which is
     * also why the old Solana-era "Save policy" button could never have worked
     * here: it POSTed to /v1/agents/:id/policy, which does not exist.
     */
    if (url.pathname === "/v1/owner-plan" && req.method === "POST") {
      const body = await new Promise<string>((ok) => {
        let s = "";
        req.on("data", (d) => (s += d));
        req.on("end", () => ok(s));
      });
      const b = JSON.parse(body || "{}") as OwnerPlanRequest;

      /**
       * WHICH VAULT THIS PLAN IS FOR. This route built against `env.vault`
       * unconditionally, so on a hosted box every visitor asking to freeze
       * their own node received a command naming the OPERATOR's vault. It
       * reverts — `assert_owner` sees the wrong signer — but the dashboard
       * would have shown them a confident command for somebody else's vault,
       * which is the same defect the read path had and the reason `?owner=`
       * was being ignored.
       *
       * The plan is still only a DESCRIPTION: no key is used here and the
       * owner signs it in their own wallet, so naming a vault you do not own
       * buys nothing the contract will honour.
       */
      const { vault: planVault, error: planVaultError } = vaultFor(url);
      if (planVaultError) return send(400, { error: planVaultError });

      // The NETWORK, not the vault — it is a property of the chain, so the
      // configured vault answers for it even when the plan targets another.
      //
      // CACHED, because it CANNOT CHANGE and this was an RPC round trip on
      // every single call. The deploy's own assertion caught the cost: the
      // refusal-follower's cold-start catch-up briefly saturates the RPC, and
      // during that window this read threw and the route answered 500 instead
      // of the 400 it owed the caller. A static value should not be able to
      // make a request fail.
      let net: { network: string };
      try {
        net = { network: await networkName() };
      } catch (e) {
        if (isUnavailable(e)) {
          return send(503, {
            error: "UPSTREAM_UNAVAILABLE",
            detail:
              "Could not reach the chain to determine the network, so the CLI " +
              "command cannot be written correctly. Retry shortly.",
          });
        }
        throw e;
      }
      let payload;
      try {
        payload = planOwnerAction(b, { ...env, vault: planVault });
      } catch (e) {
        // REPORT WHAT ACTUALLY WENT WRONG.
        //
        // This used to swallow the error and say `unknown action` for
        // everything, so an underfunded gas key, a mistyped public key and
        // an over-long label all produced the one message that cannot lead
        // the caller to a fix. The validators in planAddRole write for a
        // human; this hands that text through unchanged.
        return send(400, {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      return send(200, { payload, cli: toCliCommand(payload, net.network) });
    }

    if (url.pathname === "/v1/settings") {
      const c = await view<{ owner: string }>("get_config", {});
      return send(200, { ownerWallet: c.owner, notificationEmail: null });
    }

    if (url.pathname === "/v1/pay" && req.method === "POST") {
      const body = await new Promise<string>((ok) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => ok(b));
      });
      const {
        amount,
        recipient,
        memo = "",
        agent,
        nodeId,
        rail = "near",
        destinationAsset,
      } = JSON.parse(body || "{}") as {
        amount: string;
        recipient: string;
        memo?: string;
        agent?: string;
        nodeId?: number;
        rail?: "near" | "intents";
        destinationAsset?: string;
      };

      // WHICH agent signs decides WHICH budget is charged — the contract
      // resolves the node from the signer, not from the request body. So a
      // bad selection is a 400, never a quietly-redirected payment.
      let creds;
      try {
        creds = selectAgent(keyring, { agent, nodeId });
      } catch (e) {
        if (e instanceof AgentSelectionError) return send(400, { error: e.message });
        throw e;
      }

      // ---- Cross-chain, if asked for.
      //
      // `amount` means what the PAYEE receives. For the intents rail what
      // actually leaves the vault is the quote's amountIn — fees included —
      // and that is the figure the budget tree is charged, so the hierarchy
      // governs real outflow rather than a nominal number.
      const requestId = newRequestId();
      let route: RouteArg = "near_direct";
      let amountIn = fromCaller(() => toBaseUnits(amount, env.decimals));

      if (rail === "intents") {
        if (!env.quoteSignerKey) {
          // Deliberately a 400 with the reason, not a silent fallback to the
          // NEAR rail. Quietly paying on the wrong chain would look like
          // success and leave the payee unpaid.
          return send(400, {
            // A named-but-broken FILE is a cause; "the variable is unset" is a
            // description of the result. Saying the second when the first
            // applies sends the operator to set something already set.
            error: env.quoteSignerError
              ? `rail=intents needs the quote signer, and the key file could not be ` +
                `read. ${env.quoteSignerError}`
              : "rail=intents requires FLOAT_QUOTE_SIGNER_KEY (32-byte hex), or " +
                "FLOAT_QUOTE_SIGNER_KEY_FILE pointing at a file that holds it. That key " +
                "binds a payee to a one-time deposit address, so it belongs to the vault " +
                "operator. Without it the cross-chain rail is closed.",
          });
        }
        try {
          const deadline = new Date(Date.now() + 20 * 60 * 1000);
          const q = await getQuote({
            amountOut: fromCaller(() => toBaseUnits(amount, env.decimals)),
            payee: recipient,
            refundTo: env.vault,
            destinationAsset,
            deadline,
          });
          amountIn = q.amountIn;
          const sk = Uint8Array.from(Buffer.from(env.quoteSignerKey.replace(/^0x/, ""), "hex"));
          route = buildRoute("intents", {
            depositAddress: q.depositAddress,
            quoteDeadlineNs: q.deadlineNs.toString(),
            signature: toBase64(
              signBinding(
                {
                  vault: env.vault,
                  requestId,
                  token: env.token,
                  amount: q.amountIn,
                  payee: recipient,
                  depositAddress: q.depositAddress,
                  deadlineNs: q.deadlineNs,
                },
                sk,
              ),
            ),
          });
        } catch (e) {
          return send(502, { error: `quote failed: ${(e as Error).message}` });
        }
      }

      const outcome = (await sendRequestPayment({
        rpcUrl: env.rpcUrl,
        vault: env.vault,
        agentId: creds.agentId,
        agentKey: creds.secret,
        requestId,
        token: env.token,
        amount: amountIn,
        recipient,
        memo,
        gasTgas: 100,
        route,
      })) as { status?: string; reason_code?: string; request_id?: string; node_id?: number };

      // A BLOCKED outcome is never stored on-chain, so if the dashboard is to
      // show it as a row, this process has to remember it. See recordBlocked.
      const tree = await view<VaultNode[]>("get_tree", {});
      const labels: Record<number, string> = {};
      for (const n of tree) labels[n.id] = n.label;

      const blocked = outcome.status
        ? paymentFromOutcome(
            cfg,
            {
              request_id: outcome.request_id ?? "",
              node_id: outcome.node_id ?? 0,
              status: outcome.status,
              reason_code: outcome.reason_code ?? "",
            },
            labels,
            amount,
            recipient,
          )
        : null;

      return send(200, { outcome, blocked });
    }

    if (url.pathname === "/healthz") {
      const c = await view<{ vault_id: string; clock_mode: string }>("get_config", {});
      return send(200, { ok: true, vault: c.vault_id, clock_mode: c.clock_mode });
    }

    send(404, { error: `no such endpoint: ${url.pathname}` });
  } catch (e) {
    // Classified, not assumed. A caller's malformed input is THEIR error and
    // must not read as "the server broke, retry" — an agent that retries a
    // bad amount retries it forever.
    const { status, body } = classifyError(e);
    send(status, body);
  }
});

// ---- Follow the chain for refusals.
//
// Refusals live only in NEP-297 events, so an adapter that does not watch the
// chain can only ever show the ones it personally caused. Started before
// listening so the first dashboard request already has a cursor.
if (env.followBlocked) {
  const follower = new BlockedFollower({
    rpc,
    vault: env.vault,
    load: loadBlockedStore,
    save: saveBlockedStore,
    intervalMs: env.followIntervalMs,
    onTick: ({ from, to, added, holes }) => {
      // Silent when there is nothing to say; a per-tick line every 10s would
      // bury anything that matters.
      if (added || holes) {
        console.log(
          `[blocked-follow] blocks ${from}..${to}  +${added} refusal(s)` +
            (holes ? `  ${holes} unreadable block(s)` : ""),
        );
      }
    },
    onSkip: ({ from, to }) => {
      console.warn(
        `[blocked-follow] BACKLOG TOO LARGE — blocks ${from}..${to} ` +
          `(${to - from + 1}) were NOT scanned and are recorded as a gap. ` +
          `Refusals in that span are unknown, not absent. ` +
          `Fill it with: node scripts/scan-blocked.mjs --from ${from}`,
      );
    },
  });
  follower.start();
  const shutdown = () => follower.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

server.listen(env.port, env.host, () => {
  console.log(`float-adapter -> ${env.vault} on ${env.rpcUrl}`);
  // The address the socket is ACTUALLY on. The old line hardcoded 127.0.0.1
  // while listen() had bound 0.0.0.0 — a claim that stopped anyone checking.
  const addr = server.address();
  const shown =
    typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : `${env.host}:${env.port}`;
  console.log(`listening on http://${shown}`);
  if (env.host !== "127.0.0.1" && env.host !== "::1" && env.host !== "localhost") {
    console.log(`  WARNING: bound to ${env.host} — reachable beyond this machine.`);
  }
  console.log(
    `  mutating routes: ${env.apiToken ? "require a bearer token" : "DISABLED until FLOAT_API_TOKEN is set"}`,
  );
  console.log(`  cors origin    : ${env.allowedOrigin}`);
  console.log(`point the dashboard at it: NEXT_PUBLIC_FLOAT_API_URL=http://127.0.0.1:${env.port}`);
  console.log(`token ${env.token} (${env.decimals} decimals), 1 unit = ${fromBaseUnits(10n ** BigInt(env.decimals), env.decimals)}`);
});

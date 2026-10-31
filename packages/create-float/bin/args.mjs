/**
 * Argument parsing, extracted so it can be tested.
 *
 * It used to run at module scope in create-float.mjs, which made it untestable
 * twice over: that file calls `main()` on import, and the unknown-network guard
 * called `process.exit(2)` directly, so merely importing it to check a flag
 * could terminate the test runner. Here it is a pure function of argv that
 * THROWS on a bad network; the entry point turns that into the same exit code.
 *
 * The behaviours below are not incidental — each is load-bearing and at least
 * one of them is a regression that already happened:
 *
 *   - mainnet's RPC default. Without a per-network default, `--network mainnet`
 *     left RPC null and every call failed with "Failed to parse URL from null".
 *   - `--agents` refusing a non-numeric value instead of silently treating it
 *     as zero, which would quietly create no agents and look like success.
 *   - `opt()` ignoring a flag whose value is missing, so `--owner` at the end
 *     of argv falls back to the default rather than swallowing `undefined`.
 */

/** A bad `--network`. Carries the exit code the CLI should use. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

export const NETWORKS = ["testnet", "mainnet"];
export const RPC_DEFAULTS = {
  mainnet: "https://free.rpc.fastnear.com",
  testnet: "https://test.rpc.fastnear.com",
};

/**
 * `has` and `opt` as the wizard uses them.
 *
 * `opt` deliberately treats a flag with no following token as absent. The
 * alternative — returning `argv[i + 1]` unchecked — yields `undefined`, which
 * then flows into an account id or a URL and fails much later with a message
 * that names neither the flag nor the omission.
 */
export function makeReaders(argv) {
  const has = (f) => argv.includes(f);
  const opt = (f, d) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  return { has, opt };
}

/**
 * Did the caller ask what this does, rather than ask it to do something?
 *
 * Must be answered BEFORE preflight. Measured 2026-10-30, right after the first
 * publish: `npx -y @floatonnear/create-float --help` ignored the flag, ran
 * preflight, and prompted for a NEAR account — so the one command a person
 * types when they are *not* ready to act was the one that started an
 * account-creating flow. On a machine with no near-cli it was worse still,
 * answering `--help` with "no testnet credentials at ...".
 *
 * A bare `help` counts only in first position. `--owner help` is a (strange)
 * account name, and refusing to run for that user would be its own bug.
 */
export function wantsHelp(argv) {
  return argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
}

/**
 * What this does, what it will spend, and every flag parseArgs actually reads.
 *
 * Kept next to the parser on purpose: a flag documented here but absent there
 * is a lie, and a flag there but missing here is invisible. The test asserts
 * both directions against this text.
 */
export function usage() {
  return `create-float — a Float budget vault on NEAR, in one command

USAGE
  npx @floatonnear/create-float [options]

WHAT IT DOES
  Creates a vault account, deploys the budget contract to it, builds a
  hierarchy of spending limits, and optionally creates agent accounts whose
  keys may ONLY call request_payment. Writes .float/adapter.env and adds a
  'float' entry to your MCP client's config.

WHAT IT COSTS
  You need a funded NEAR account with its key in ~/.near-credentials, which
  'near login' puts there. Roughly 3.9 NEAR for a vault plus one agent — most
  of it a refundable storage stake. On mainnet this spends REAL funds, and the
  wizard asks for a typed acknowledgement before it does.

OPTIONS
  --network <mainnet|testnet>  default mainnet — spends REAL funds
  --owner <account>            the account that signs and owns the vault
  --vault <account>            vault account to create (default: derived)
  --token <account>            fungible token to budget in (default: USDC)
  --decimals <n>               token decimals (default 6)
  --agents <n|all>             agent accounts to create (default none)
  --rpc <url>                  override the RPC endpoint
  --dry-run                    print the plan and stop, spending nothing
  --yes                        skip confirmation prompts
  -h, --help                   print this and exit

AFTER IT RUNS
  Restart your MCP client so it picks up the new server. The vault, every
  account touched, and the agent keys are printed with explorer links.
`;
}

/**
 * Parse argv into the wizard's configuration.
 *
 * @throws {UsageError} on an unrecognised `--network`.
 */
export function parseArgs(argv) {
  const { has, opt } = makeReaders(argv);

  // MAINNET by default, since 2026-10-30. NEAR Intents has no testnet, so the
  // cross-chain rail cannot be exercised there — a testnet default quietly
  // produced a vault missing the capability the product exists for.
  //
  // Only defensible because of the gate further in: the wizard prints the whole
  // bill and requires the word "mainnet" to be TYPED before it sends anything.
  // That acknowledgement is what makes a real-funds default safe, so the two
  // must never be separated.
  const network = opt("--network", "mainnet");
  // Mainnet is allowed, but never by accident. This was once a flat refusal,
  // which was right while the cross-chain rail was unproven — but NEAR Intents
  // has no testnet, so refusing mainnet outright means refusing the only
  // working cross-chain path. The guard is a gate, not a wall; the typed
  // acknowledgement later in the wizard is what keeps it deliberate.
  if (!NETWORKS.includes(network)) {
    throw new UsageError(`Unknown network '${network}'. Use testnet or mainnet.`);
  }
  const mainnet = network === "mainnet";

  return {
    dry: has("--dry-run"),
    yes: has("--yes"),
    network,
    mainnet,
    // The flag wins, but there must be a per-network fallback.
    rpc: opt("--rpc", null) ?? RPC_DEFAULTS[network],
    owner: opt("--owner", null),
    vault: opt("--vault", null),
    token: opt("--token", null),
    decimals: Number(opt("--decimals", "6")),
    agents: opt("--agents", null),
  };
}

/**
 * How many agent accounts to create, from `--agents <n|all>`.
 *
 * Refuses a non-numeric value rather than treating it as zero. Silently
 * creating no agents for `--agents some` would look like success and only
 * surface later as a vault with nothing bound to it.
 *
 * @throws {UsageError} on a value that is neither "all" nor an integer.
 */
export function agentCount(raw, available) {
  if (raw === null || raw === undefined || raw === "0") return 0;
  if (raw === "all") return available;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
    throw new UsageError(`--agents expects a number or "all", got "${raw}"`);
  }
  return Math.max(0, Math.min(available, n));
}

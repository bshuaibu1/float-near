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
 * Parse argv into the wizard's configuration.
 *
 * @throws {UsageError} on an unrecognised `--network`.
 */
export function parseArgs(argv) {
  const { has, opt } = makeReaders(argv);

  const network = opt("--network", "testnet");
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

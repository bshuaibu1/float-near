/**
 * The two steps the wizard used to say it "cannot do for you".
 *
 * It always could. The wizard holds the owner's full-access key, already
 * transfers 3 NEAR to create the vault, and already calls `ft_metadata` on the
 * token at step 2 to prove it is a NEP-141. Nothing about `storage_deposit` or
 * `ft_transfer` is out of reach — the sentence was written early and never
 * revisited, and it cost every user two hand-typed CLI commands with awkward
 * quoting. On Windows those commands fail outright unless the JSON's inner
 * quotes are backslash-escaped, which nothing told them.
 *
 * Kept as a pure function, separately from create-float.mjs, for the same
 * reason as xchain.mjs and tree.mjs: that file calls `main()` at the bottom, so
 * importing it from a test launches the wizard. The decision is also the part
 * worth testing — the two calls it produces are three lines of near-api-js.
 *
 * ORDER IS LOAD-BEARING. Registration must precede the transfer: NEP-141
 * `ft_transfer` to an unregistered account panics with "The account … is not
 * registered". That was measured the hard way on mainnet, where the first
 * cross-chain payment failed for exactly this reason against a one-time
 * deposit address (KNOWN-TRADEOFFS §13).
 */
import { toBaseUnits } from "./tree.mjs";

/**
 * The closing text, written to match what actually happened.
 *
 * The old version printed "Still to do — the wizard cannot do these for you"
 * above two near-cli commands. Both halves were wrong: the wizard can do them,
 * and the commands as printed FAIL on Windows, because PowerShell 5.1 strips
 * embedded double quotes when handing argv to a native exe — so near-cli
 * receives `{account_id:v.me.near}` and answers "key must be a string". That
 * cost a real user two failed attempts on 2026-10-28.
 *
 * So: say what was done, leave at most ONE command, and escape it for the shell
 * that actually broke.
 */
export function fundingNotice(plan, { token, vault, owner, network, decimals }) {
  const lines = [];
  if (plan.register) {
    lines.push(`Registered ${vault} on ${token} — no longer your job.`);
  }
  if (plan.transfer != null) {
    lines.push(`Funded it with ${human(plan.transfer, decimals)} ${token}.`);
    return lines;
  }
  for (const w of plan.warnings ?? []) lines.push(w);

  // An owner holding nothing cannot run an ft_transfer, so printing one under a
  // warning that says exactly that would reintroduce the defect this function
  // exists to remove — a command handed to a user that cannot work. Found by
  // rendering the notice and reading it; the assertions could not see it.
  if (plan.canFundFromOwner === false) {
    lines.push(
      `Get some ${token} into ${owner} first, then re-run with --fund <amount>`,
      `and the wizard will register-and-fund in one go.`,
    );
    return lines;
  }

  lines.push(
    `The vault holds no ${token} yet, so every payment will be refused until it does.`,
    `Send some whenever you are ready — registration is already done:`,
    ``,
    `  near contract call-function as-transaction ${token} ft_transfer \\`,
    `    json-args '{\\"receiver_id\\":\\"${vault}\\",\\"amount\\":\\"<base units>\\"}' \\`,
    `    prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \\`,
    `    sign-as ${owner} network-config ${network} sign-with-legacy-keychain send`,
    ``,
    `  The \\" escapes are for PowerShell, which strips bare double quotes when`,
    `  passing arguments to a native exe. They are harmless in bash.`,
    `  Or re-run this wizard with --fund <amount> and it will do it.`,
  );
  return lines;
}

/** Base units -> a human string, for error messages only. */
function human(base, decimals) {
  const s = String(base).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return decimals ? `${whole}.${frac}` : whole;
}

/**
 * Decide what has to happen to the token before the vault can pay with it.
 *
 * @param registered   `storage_balance_of(vault)` — the token returns `null`
 *                     when the account is not registered, and an object once it
 *                     is. Only `null` distinguishes "not registered" from
 *                     "registered with zero available", so the raw value is
 *                     taken rather than a boolean derived by the caller.
 * @param storageMin   `storage_balance_bounds().min`, as a yocto string. Read
 *                     from the token rather than hardcoded: it is 0.00125 NEAR
 *                     on mainnet USDC, where min and max happen to be equal,
 *                     but neither is guaranteed across tokens.
 * @param fundAmount   human units, or null. NULL IS THE DEFAULT, deliberately:
 *                     moving someone's money because they ran a setup wizard is
 *                     not a sane default, so funding is opt-in.
 */
export function planTokenSetup({
  token,
  vault,
  decimals,
  storageMin,
  registered,
  ownerBalance,
  fundAmount,
}) {
  const warnings = [];
  const register = registered == null;
  const registerDeposit = register ? BigInt(storageMin) : 0n;

  const held = BigInt(ownerBalance ?? "0");
  let transfer = null;
  if (fundAmount != null) {
    const want = toBaseUnits(fundAmount, decimals, "amount");
    if (want > 0n) {
      if (want > held) {
        throw new Error(
          `cannot fund ${fundAmount} ${token}: ${
            held === 0n ? "the owner holds none" : `the owner holds only ${human(held, decimals)}`
          }`,
        );
      }
      transfer = want;
    }
  }

  if (held === 0n) {
    warnings.push(
      `the owner holds no ${token}, so the vault cannot be funded from here — ` +
        `send some to the owner first, or fund the vault directly later`,
    );
  }

  const steps = [];
  if (register) steps.push({ action: "storage_deposit", account: vault, deposit: registerDeposit });
  if (transfer != null) steps.push({ action: "ft_transfer", to: vault, amount: transfer });

  return {
    register,
    registerDeposit,
    transfer,
    // What this adds to the NEAR the owner must have. The affordability gate
    // sums it with the vault funding; leaving it out lets a run clear the gate
    // and then fail with the vault already created.
    nearCost: registerDeposit,
    // Whether an ft_transfer from the owner is even possible. The notice needs
    // this to avoid printing a command the owner cannot run.
    canFundFromOwner: held > 0n,
    warnings,
    steps,
  };
}

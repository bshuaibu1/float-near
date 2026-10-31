import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The two Windows traps that cost a mainnet deploy cycle on 2026-10-31, and the
 * reason the decisions live in a sourceable shell file rather than inline.
 *
 * TRAP 1 — the ABI step. `cargo near build` compiles the crate a SECOND time,
 * natively, as a cdylib to extract ABI metadata. On Windows link.exe refuses to
 * emit a DLL with near-sdk's host-function externs undefined, so the build dies
 * with ~52 LNK2019 errors. `--no-abi` skips only the metadata; the wasm still
 * goes through cargo-near, so `--cfg near` survives and panic reason codes with
 * it. upgrade-vault.sh already honoured NO_ABI=1 — but only if you remembered
 * to set it, and the whole point is that you remember it AFTER the failure.
 *
 * TRAP 2 — the wrong bash. In PowerShell, plain `bash` is C:\WINDOWS\system32\
 * bash.exe, which is WSL, not git-bash. Three things then go wrong at once and
 * only one of them announces itself:
 *   - `$env:VAULT` is not inherited, so the script aborts with "set VAULT";
 *   - cargo-near is absent (WSL's PATH has no ~/.cargo/bin);
 *   - `near` IS present, resolved to the Windows .exe through /mnt/c — so a
 *     tool check that only looks for `near` passes, and the Windows binary then
 *     receives /mnt/c/... paths it cannot open.
 *
 * MEASURED on this machine, 2026-10-31, rather than assumed:
 *
 *   shell      uname -s                  pwd                    osrelease
 *   git-bash   MINGW64_NT-10.0-26200     /c/Users/...            (absent)
 *   WSL        Linux                     /mnt/c/Users/...        6.6.87.2-microsoft-standard-WSL2
 *
 *   cargo-near  git-bash /c/Users/BASHIR/.cargo/bin/cargo-near   WSL (not found)
 *   near        git-bash .../npm/near                            WSL /mnt/c/.../npm/near
 *
 * WHY A SOURCEABLE FILE. These decisions read `uname -s`, a path and a proc
 * file, so inline in the script they can only ever be exercised on the machine
 * running them — the WSL branch is untestable from git-bash and vice versa.
 * Taking all three as ARGUMENTS makes every branch reachable from one shell.
 */

const ROOT = resolve(import.meta.dirname, "..");
const LIB = "scripts/lib/shell-env.sh";

/**
 * A bash that can read this repo. Never plain `bash` on Windows: that is WSL,
 * which is the very thing under test here and may not even be installed.
 */
function findBash() {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    process.env.GIT_BASH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

const BASH = findBash();

/** Call one function in the lib with arguments, return its stdout trimmed. */
function callFn(fn, ...args) {
  const script = `set -eu; . "${LIB}"; ${fn} "$@"`;
  return execFileSync(BASH, ["-c", script, "--", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Skipping is honest here and still runs on the machine that owns these traps.
// A test that silently passes when it cannot execute would be worse than absent.
const opts = BASH ? {} : { skip: "no git-bash found; set GIT_BASH to run these" };

test("git-bash is recognised from uname, with no proc file to read", opts, () => {
  // MINGW64 has no /proc/sys/kernel/osrelease at all, so the classifier must
  // reach its answer from uname alone. Real value from this machine.
  assert.equal(callFn("shell_kind", "MINGW64_NT-10.0-26200", ""), "git-bash");
  assert.equal(callFn("shell_kind", "MSYS_NT-10.0-26200", ""), "git-bash");
  assert.equal(callFn("shell_kind", "CYGWIN_NT-10.0", ""), "git-bash");
});

test("WSL is recognised from the kernel release, because uname just says Linux", opts, () => {
  // This is the whole difficulty: `uname -s` cannot tell WSL from a real Linux
  // box, and a real Linux box must NOT be treated as a trap.
  assert.equal(callFn("shell_kind", "Linux", "6.6.87.2-microsoft-standard-WSL2"), "wsl");
  assert.equal(callFn("shell_kind", "Linux", "5.15.0-1-Microsoft"), "wsl");
  assert.equal(callFn("shell_kind", "Linux", "6.8.0-45-generic"), "unix");
  assert.equal(callFn("shell_kind", "Darwin", ""), "unix");
});

test("the ABI step is skipped on git-bash and nowhere else", opts, () => {
  assert.equal(callFn("abi_policy", "git-bash"), "skip");
  assert.equal(callFn("abi_policy", "unix"), "build");
  // WSL gets "build" deliberately: inside WSL the native target is Linux, so
  // link.exe is not involved and the ABI step works. Returning "skip" there
  // would hide a real capability behind a Windows-specific workaround.
  assert.equal(callFn("abi_policy", "wsl"), "build");
});

test("WSL on a /mnt/ Windows path is the trap, and is named as one", opts, () => {
  assert.equal(callFn("wsl_verdict", "wsl", "/mnt/c/Users/BASHIR/Documents/near-vault", "0"), "trap");
  assert.equal(callFn("wsl_verdict", "wsl", "/mnt/d/work/near-vault", "0"), "trap");
});

test("WSL working inside its OWN filesystem is a legitimate setup", opts, () => {
  // Someone who cloned into ~ under WSL and installed cargo-near there is not
  // making the mistake this guard exists for. Blocking them would be wrong.
  assert.equal(callFn("wsl_verdict", "wsl", "/home/bashir/near-vault", "0"), "ok");
});

test("git-bash and real Linux are never flagged, whatever the path", opts, () => {
  assert.equal(callFn("wsl_verdict", "git-bash", "/c/Users/BASHIR/Documents/near-vault", "0"), "ok");
  assert.equal(callFn("wsl_verdict", "unix", "/mnt/c/Users/BASHIR/Documents/near-vault", "0"), "ok");
});

test("ALLOW_WSL=1 is an escape hatch, not a suggestion", opts, () => {
  // The guard is a heuristic about intent. Someone who means it must be able to
  // proceed, or the script becomes the obstacle instead of the help.
  assert.equal(callFn("wsl_verdict", "wsl", "/mnt/c/Users/BASHIR/Documents/near-vault", "1"), "ok");
  // Anything other than exactly "1" is not consent.
  assert.equal(callFn("wsl_verdict", "wsl", "/mnt/c/x", "0"), "trap");
  assert.equal(callFn("wsl_verdict", "wsl", "/mnt/c/x", ""), "trap");
  assert.equal(callFn("wsl_verdict", "wsl", "/mnt/c/x", "yes"), "trap");
});

// ---- the lib is only worth anything if the script uses it (tdd-extras Rule 5)
//
// Every test above calls the functions directly, so none can see whether
// upgrade-vault.sh sources them. Driving the script itself means a real build
// and a real deploy, so this is a structural proxy — weaker than running it,
// and strictly better than the nothing that was there before.

import { readFileSync } from "node:fs";

const UPGRADE = readFileSync(join(ROOT, "scripts", "upgrade-vault.sh"), "utf8");

test("WIRING: upgrade-vault.sh sources the lib and uses all three decisions", () => {
  // assert.ok rather than assert.match on purpose: a failing `match` against a
  // 10 KB file prints the whole file as the diff, which buries every other
  // failure in the run.
  assert.ok(
    /^\s*\.\s+\S*scripts\/lib\/shell-env\.sh/m.test(UPGRADE),
    "upgrade-vault.sh does not source scripts/lib/shell-env.sh",
  );
  for (const fn of ["shell_kind", "abi_policy", "wsl_verdict"]) {
    assert.ok(new RegExp(`${fn}\\s`).test(UPGRADE), `upgrade-vault.sh never calls ${fn}`);
  }
});

test("WIRING: every script that runs cargo-near decides the ABI from the shell", () => {
  // deploy-testnet.sh carries the same `if [ "${NO_ABI:-0}" = "1" ]` block
  // upgrade-vault.sh used to. Leaving one script remembering-based and the
  // other automatic is how this trap comes back: the next person runs the
  // other one.
  const builders = ["upgrade-vault.sh", "deploy-testnet.sh"];
  for (const f of builders) {
    const src = readFileSync(join(ROOT, "scripts", f), "utf8");
    assert.ok(/cargo near build/.test(src), `${f} is not a cargo-near builder — fix this list`);
    assert.ok(
      /^\s*\.\s+\S*scripts\/lib\/shell-env\.sh/m.test(src),
      `${f} does not source scripts/lib/shell-env.sh`,
    );
    assert.ok(/abi_policy\s/.test(src), `${f} does not call abi_policy — NO_ABI is manual there`);
  }
});

test("WIRING: the signer key is checked BEFORE the build, not after it", () => {
  // Order is the whole value. The three failed mainnet deploys on 2026-10-31
  // each ran a full cargo-near build and then died at the signing step on a key
  // that had been off the account the entire time. A check placed after the
  // build would report the same thing, minutes later.
  const signer = UPGRADE.indexOf("check-signer-key.mjs");
  const build = UPGRADE.indexOf("cargo near build");
  assert.ok(signer > 0, "upgrade-vault.sh never runs scripts/check-signer-key.mjs");
  assert.ok(build > 0, "could not find the build step to compare against");
  assert.ok(signer < build, "the signer check runs after the build, which wastes the build");
});

test("no deploy preflight calls process.exit — it aborts with the RPC in flight", () => {
  // MEASURED 2026-10-31, node 24.14 / Windows. check-signer-key.mjs ended with
  // `process.exit(0)` after an RPC read and aborted every run, 5 for 5:
  //
  //   VERDICT  can sign a deploy to float.test015.near
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
  //   exit code -1073740791
  //
  // The verdict was right and printed; only the exit code was wrong. Both
  // callers are `if ! node scripts/<check>.mjs`, which reads any non-zero as a
  // refusal — so the guard would have blocked every deploy while displaying a
  // green verdict. A guard that always refuses is as broken as no guard.
  //
  // check-upgrade-margin.mjs did NOT abort (0 for 5) with the same pattern, on
  // a different RPC method. That is luck, not a difference in kind, and it sits
  // in the mainnet deploy path. process.exitCode lets the loop drain instead.
  for (const f of ["check-signer-key.mjs", "check-upgrade-margin.mjs"]) {
    const src = readFileSync(join(ROOT, "scripts", f), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    assert.ok(
      !/process\.exit\(/.test(code),
      `${f} calls process.exit(); set process.exitCode so the event loop can drain`,
    );
  }
});

test("upgrade-vault.sh carries no stray control bytes", () => {
  // Not cosmetic paranoia: writing this file through a heredoc collapsed
  // `\bash.exe` and `\bin\bash.exe` into literal 0x08 backspaces, so the help
  // text that tells you to use git-bash printed "system32ash.exe" — advice for
  // a path that does not exist, inside the handler for this exact mistake.
  // Measured: 3 backspace bytes were in this file.
  const bad = [...UPGRADE].filter((ch) => {
    const c = ch.codePointAt(0);
    return c < 32 && ch !== "\n" && ch !== "\r" && ch !== "\t";
  });
  assert.equal(bad.length, 0, `${bad.length} control bytes in upgrade-vault.sh`);
});

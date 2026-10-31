# Which shell are we in, and what follows from it.
#
# Sourced, never executed. Every function takes what it needs as ARGUMENTS
# rather than reading `uname`, `pwd` or /proc itself, for one reason: inline in
# a deploy script these branches can only ever run on the machine running them,
# so the WSL branch is unreachable from git-bash and the git-bash branch is
# unreachable from WSL. Passing the three inputs in makes every branch testable
# from one shell — see test/shell-env.test.mjs.
#
# MEASURED on Bashir's Windows machine, 2026-10-31:
#
#   shell      uname -s                 pwd                osrelease
#   git-bash   MINGW64_NT-10.0-26200    /c/Users/...        (file absent)
#   WSL        Linux                    /mnt/c/Users/...    6.6.87.2-microsoft-standard-WSL2
#
# `uname -s` alone cannot separate WSL from a real Linux box — both say Linux —
# which is why the kernel release is a second input and not an afterthought.

# shell_kind <uname-s> <osrelease-contents>  ->  git-bash | wsl | unix
shell_kind() {
  case "$1" in
    MINGW*|MSYS*|CYGWIN*) echo git-bash; return ;;
  esac
  # Microsoft's kernel release string has varied in case and shape across WSL
  # versions ("microsoft-standard-WSL2", "1-Microsoft"), so match both forms
  # rather than the one this machine happens to report today.
  case "$1:$2" in
    Linux*:*microsoft*|Linux*:*Microsoft*|Linux*:*WSL*) echo wsl; return ;;
  esac
  echo unix
}

# abi_policy <shell-kind>  ->  skip | build
#
# cargo-near's ABI step compiles the crate a SECOND time, natively, as a cdylib.
# On Windows link.exe refuses to emit a DLL while near-sdk's host-function
# externs are undefined, so the build dies with ~52 LNK2019 errors. `--no-abi`
# drops only the metadata: the wasm still goes through cargo-near, so `--cfg
# near` survives and with it every panic reason code.
#
# WSL gets `build`, deliberately. Inside WSL the native target is Linux and
# link.exe is not involved, so the ABI step works there — skipping it would hide
# a real capability behind a Windows-specific workaround.
abi_policy() {
  case "$1" in
    git-bash) echo skip ;;
    *) echo build ;;
  esac
}

# wsl_verdict <shell-kind> <pwd> <allow-wsl>  ->  trap | ok
#
# In PowerShell, plain `bash` resolves to C:\WINDOWS\system32\bash.exe — WSL,
# not git-bash. Three things then go wrong at once and only one announces
# itself:
#   - `$env:VAULT` is not inherited, so the script aborts with "set VAULT";
#   - cargo-near is absent, because WSL's PATH carries no ~/.cargo/bin;
#   - `near` IS present, resolved to the Windows .exe through /mnt/c, so a tool
#     check looking only for `near` passes and the Windows binary then receives
#     /mnt/c/... paths it cannot open.
#
# The /mnt/ path is what makes this a mistake rather than a setup: someone who
# cloned into their WSL home and installed cargo-near there is not confused, and
# blocking them would be wrong. ALLOW_WSL=1 exists for anyone who means it.
wsl_verdict() {
  if [ "$1" = "wsl" ] && [ "${3:-0}" != "1" ]; then
    case "$2" in
      /mnt/[a-zA-Z]/*) echo trap; return ;;
    esac
  fi
  echo ok
}

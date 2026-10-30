#!/usr/bin/env bash
# Deploys the float-adapter to a VPS under pm2, and refuses rather than guessing.
#
# THIS SCRIPT IS THE RUNBOOK. A hand-rolled `git pull && pm2 restart` skips the
# service-user check, the collision checks, the token check and every
# post-deploy assertion below — which is exactly how a deploy on another box
# restarted 2 of 4 services and left root-owned files in a service-owned tree.
#
# ---- WHAT MAKES THIS DIFFERENT FROM THE OTHER FLOAT DEPLOYS
#
# The existing Float project already runs on a VPS under pm2 as
# float-dashboard / float-admin / float-api, out of /srv/float. This is a
# DIFFERENT service and must not be mistaken for those:
#
#   - it is named float-near-adapter, not float-api. `pm2 restart float-api`
#     would restart the Solana product's API.
#   - it lives in its own tree, default /srv/float-near.
#   - it serves the NEAR vault's /v1 endpoints, reading NEAR RPC.
#
# The same collision bit us one layer up: create-float used to take the `float`
# MCP config key unconditionally, and on a real machine that key already
# belonged to @usefloat/mcp holding an owner key. Names are not ours by
# default. This script therefore REFUSES to touch a pm2 process it did not
# create, rather than restarting someone else's service.
#
# ---- WHAT THIS ENDPOINT IS
#
# POST /v1/pay signs with the agent key. That is a money-moving HTTP endpoint.
# Two consequences the script enforces rather than documents:
#
#   - FLOAT_API_TOKEN must be set, or every mutating route answers 503
#     (DISABLED) while reads keep working. That is deliberate, and silent.
#   - HOST defaults to 127.0.0.1. Binding 0.0.0.0 needs CONFIRM_EXPOSE=1, and
#     should sit behind a reverse proxy with TLS, never be published directly.
#
# ---- NO `set -a; . env`
#
# The adapter reads its own env file via FLOAT_ENV_FILE. Sourcing a secrets file
# makes the shell EXECUTE it, and `set -a; . file; set +a` has already died on
# another box over one unquoted value containing a space. See
# packages/float-adapter/src/env-file.ts.
#
# Usage:
#   bash scripts/deploy-vps.sh
#   ROOT=/srv/float-near SERVICE=float-near-adapter PORT=8787 bash scripts/deploy-vps.sh
#   HOST=0.0.0.0 CONFIRM_EXPOSE=1 bash scripts/deploy-vps.sh
#
# Env:
#   ROOT            deploy tree            (default /srv/float-near)
#   SERVICE         pm2 process name       (default float-near-adapter)
#   PORT            adapter port           (default 8787)
#   HOST            bind address           (default 127.0.0.1)
#   CONFIRM_EXPOSE  required iff HOST is not loopback
#   SERVICE_USER    owner of ROOT          (default: current user)
#   BRANCH          git ref to deploy      (default main)
#   SKIP_PULL       1 to deploy the tree as-is

set -euo pipefail

ROOT="${ROOT:-/srv/float-near}"
SERVICE="${SERVICE:-float-near-adapter}"
PORT="${PORT:-8787}"
HOST="${HOST:-127.0.0.1}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
ENV_FILE="$ROOT/.float/adapter.env"

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "  $*"; }
section() { echo; echo "== $*"; }

# ---------------------------------------------------------------- 0. preflight
section "0. Preflight"

[ "$(id -u)" != "0" ] || die "do not run as root.
  Root git/npm in a service-owned tree leaves root-owned files — .git/index,
  caches, node_modules — that '$SERVICE_USER' can no longer write, and the
  symptom is silent degradation rather than a crash.
  Run as the service user:  sudo -u $SERVICE_USER bash scripts/deploy-vps.sh"

for t in node npm pm2 git curl; do
  command -v "$t" >/dev/null || die "$t not found on PATH"
done
say "node $(node -v), npm $(npm -v), pm2 $(pm2 -v 2>/dev/null | tail -1)"

case "$(node -v)" in
  v20.*|v22.*|v24.*) ;;
  *) die "node $(node -v) is not supported; the packages require >=20" ;;
esac

[ -d "$ROOT" ] || die "$ROOT does not exist. Create it owned by $SERVICE_USER:
  sudo mkdir -p $ROOT && sudo chown -R $SERVICE_USER:$SERVICE_USER $ROOT
  sudo -u $SERVICE_USER git clone https://github.com/bshuaibu1/float-near.git $ROOT"

[ -w "$ROOT" ] || die "$ROOT is not writable by $(id -un)"

# Root-owned files inside a service tree are the documented failure mode, and
# they are cheap to detect. Checked BEFORE doing anything, so a previous bad
# deploy is reported rather than compounded.
root_owned="$(find "$ROOT" -user root -not -path '*/node_modules/*' 2>/dev/null | head -5 || true)"
if [ -n "$root_owned" ]; then
  echo "FATAL: root-owned files in $ROOT — a previous run used sudo:" >&2
  echo "$root_owned" | sed 's/^/    /' >&2
  die "fix with: sudo chown -R $SERVICE_USER:$SERVICE_USER $ROOT"
fi
say "no root-owned files in $ROOT"

# ------------------------------------------------- 1. exposure is opted into
section "1. Bind address"

case "$HOST" in
  127.0.0.1|localhost|::1)
    say "$HOST — loopback. Reachable only from the box itself."
    ;;
  *)
    [ "${CONFIRM_EXPOSE:-0}" = "1" ] || die "HOST=$HOST exposes a money-moving endpoint.
  POST /v1/pay signs with the agent key. Anything that can reach this port and
  holds FLOAT_API_TOKEN can spend the budget.
  Put it behind a reverse proxy with TLS and re-run with CONFIRM_EXPOSE=1."
    say "$HOST — EXPOSED, confirmed. Ensure a proxy and firewall are in front."
    ;;
esac

# --------------------------------------------- 2. names and ports are not ours
section "2. Collisions"

# pm2: refuse to adopt a process we did not create. `float-api` on this box
# belongs to the Solana Float product.
if pm2 describe "$SERVICE" >/dev/null 2>&1; then
  existing_cwd="$(pm2 describe "$SERVICE" 2>/dev/null | awk -F'│' '/exec cwd/ {gsub(/ /,"",$3); print $3}' | head -1)"
  if [ -n "$existing_cwd" ] && [ "$existing_cwd" != "$ROOT" ]; then
    die "pm2 process '$SERVICE' already exists and runs from '$existing_cwd', not '$ROOT'.
  That is a different service. Pick another name with SERVICE=..., or stop the
  other one deliberately. This script will not restart a process it does not
  recognise."
  fi
  say "pm2 '$SERVICE' exists and belongs to this tree — will reload"
  RELOAD=1
else
  say "pm2 '$SERVICE' is new — will start"
  RELOAD=0
fi

# Port: a bound port is someone else's until proven otherwise.
if command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -qE "[:.]$PORT\b"; then
  if [ "$RELOAD" = "1" ]; then
    say "port $PORT is bound — expected, it is our own running instance"
  else
    die "port $PORT is already in use and '$SERVICE' is not running, so it is
  not ours. Choose another with PORT=..., or find the owner:
    ss -ltnp | grep :$PORT"
  fi
fi
say "port $PORT ok"

# ------------------------------------------------------------ 3. source + deps
section "3. Source"

if [ "${SKIP_PULL:-0}" != "1" ]; then
  git -C "$ROOT" fetch --quiet origin "$BRANCH"
  git -C "$ROOT" checkout --quiet "$BRANCH"
  git -C "$ROOT" merge --ff-only --quiet "origin/$BRANCH"
fi
# Ground truth for "what is deployed" is the tree, never a VERSION/REVISION
# file — one of those went three weeks stale on another box while reading as
# authoritative.
DEPLOYED_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
say "HEAD $DEPLOYED_SHA  ($(git -C "$ROOT" log -1 --format=%s | cut -c1-60))"

section "4. Build"
# mcp FIRST: float-adapter depends on @floatonnear/mcp and imports its dist.
( cd "$ROOT" && npm ci --silent )
( cd "$ROOT" && npm run build --workspace @floatonnear/mcp --silent )
( cd "$ROOT" && npm run build --workspace @floatonnear/float-adapter --silent )
[ -f "$ROOT/packages/float-adapter/dist/server.js" ] || die "build produced no dist/server.js"
say "built $(node -e "console.log(require('$ROOT/packages/mcp/package.json').version)") mcp + adapter"

# ------------------------------------------------------------------- 5. secrets
section "5. Configuration"

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found.
  Generate it on a trusted machine with create-float, then copy it here:
    scp .float/adapter.env $SERVICE_USER@<host>:$ENV_FILE
  It holds the agent key, the quote signer and the API token. Never commit it."

perms="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')"
case "$perms" in
  600|400) say "$ENV_FILE permissions $perms" ;;
  *) die "$ENV_FILE is mode $perms — it holds private keys.
  chmod 600 $ENV_FILE" ;;
esac

# Read with node, NOT the shell. Sourcing this file would execute it.
missing="$(node -e '
const {parseEnvFile}=require("'"$ROOT"'/packages/float-adapter/dist/env-file.js");
const fs=require("fs");
const e=parseEnvFile(fs.readFileSync(process.argv[1],"utf8"));
const need=["NEAR_VAULT_CONTRACT","NEAR_VAULT_TOKEN","FLOAT_API_TOKEN"];
console.log(need.filter(k=>!e[k]).join(","));
' "$ENV_FILE")"
[ -z "$missing" ] || die "$ENV_FILE is missing: $missing
  Without FLOAT_API_TOKEN every mutating route answers 503 (DISABLED) while
  reads keep working — the adapter starts and looks healthy."
say "required keys present (values not printed)"

# ---------------------------------------------------------------- 6. start/reload
section "6. pm2"

cd "$ROOT"
if [ "$RELOAD" = "1" ]; then
  PORT="$PORT" HOST="$HOST" FLOAT_ENV_FILE="$ENV_FILE" \
    pm2 restart "$SERVICE" --update-env >/dev/null
  say "restarted $SERVICE"
else
  PORT="$PORT" HOST="$HOST" FLOAT_ENV_FILE="$ENV_FILE" \
    pm2 start packages/float-adapter/dist/server.js \
      --name "$SERVICE" --time --cwd "$ROOT" >/dev/null
  say "started $SERVICE"
fi
pm2 save >/dev/null
say "pm2 save"

# ------------------------------------------------------------- 7. prove it works
section "7. Assertions"

# Never report a deploy clean without checking. State the expectation first, so
# a disagreement is visible rather than interpreted.
sleep 2

status="$(pm2 jlist | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const p=JSON.parse(s).find(x=>x.name===process.argv[1]);
  if(!p){console.log("absent");return;}
  console.log(`${p.pm2_env.status} restarts=${p.pm2_env.restart_time}`);
});' "$SERVICE")"
say "pm2 status: $status"
case "$status" in online*) ;; *) die "pm2 reports '$status' — see: pm2 logs $SERVICE --err --lines 50" ;; esac

# A read endpoint, against the address actually bound.
probe_host="$HOST"; [ "$probe_host" = "0.0.0.0" ] && probe_host=127.0.0.1
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$probe_host:$PORT/v1/dashboard" || true)"
say "GET /v1/dashboard -> $code  (expect 200)"
[ "$code" = "200" ] || die "the adapter is not serving reads. pm2 logs $SERVICE --err --lines 50"

# The mutating route must REFUSE an unauthenticated request. This is the F1
# regression check, run against the live deployment rather than assumed: the
# adapter once accepted unauthenticated POSTs on every interface.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST -H 'content-type: application/json' -d '{}' \
  "http://$probe_host:$PORT/v1/pay" || true)"
say "POST /v1/pay with no token -> $code  (expect 401)"
case "$code" in
  401) ;;
  503) die "POST /v1/pay returned 503 — FLOAT_API_TOKEN did not reach the process.
  The preflight found it in the file, so this is an env-passing failure:
    pm2 describe $SERVICE | grep -i env" ;;
  *)   die "POST /v1/pay returned $code, expected 401. An unauthenticated
  caller must never get past the gate on a money-moving route." ;;
esac

# The error log specifically. A deploy that 'looks clean' because nobody opened
# the err log is the documented failure; state the window and the count.
errlog="$(pm2 describe "$SERVICE" 2>/dev/null | awk -F'│' '/error log path/ {gsub(/ /,"",$3); print $3}' | head -1)"
if [ -n "$errlog" ] && [ -f "$errlog" ]; then
  n="$(wc -l < "$errlog")"
  say "error log $errlog has $n lines total; last 5 since this deploy:"
  tail -5 "$errlog" | sed 's/^/      /' || true
  say "(lines above may predate this deploy — compare against $DEPLOYED_SHA's start time)"
else
  say "no error log path reported by pm2"
fi

section "Deployed"
say "$SERVICE  $DEPLOYED_SHA  http://$HOST:$PORT"
say "logs:    pm2 logs $SERVICE --lines 50"
say "errors:  pm2 logs $SERVICE --err --lines 50"
say "stop:    pm2 stop $SERVICE"

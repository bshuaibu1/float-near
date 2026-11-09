#!/usr/bin/env bash
# Publishes the signing page and /skill.md at a domain, and refuses rather
# than guessing.
#
# WHAT GOES PUBLIC, AND WHY IT IS ONLY THIS.
#
# Exactly one process: web/serve.mjs. It serves the signing page — which MUST
# be reachable, because a user clicks a link to approve creating a vault — and
# /skill.md, which an agent fetches when told "set up https://<domain>/skill.md".
# Neither holds a key and neither signs anything.
#
# THE ADAPTER AND DASHBOARD DO RUN HERE NOW, ON LOOPBACK, WITH NO CREDENTIALS.
#
# They used to be refused outright, and the reason was sound: `POST /v1/pay`
# signs with the agent's key, and scripts/restart-adapter.ps1 hardcodes
# FLOAT_API_TOKEN=local-dev-token — a value that is IN THE REPOSITORY. An
# adapter on the public internet with a published token lets anyone spend from
# the vault up to its caps.
#
# What changed is that reads and owner actions became multi-tenant, so a
# hosted dashboard can show any visitor THEIR vault, and the gate became
# per-ROUTE instead of per-method: /v1/owner-plan returns an UNSIGNED payload
# the owner approves in their own wallet, and /v1/pay always needs the token.
#
# So this box runs BOTH WITH NEITHER CREDENTIAL:
#
#   NO FLOAT_API_TOKEN       -> every token-gated route answers 503. The
#                               dashboard proxy attaches the token WITHOUT
#                               authenticating the caller, so a token here
#                               would be an open /v1/pay for the internet.
#   NO NEAR_VAULT_AGENT_KEY  -> nothing to sign with even if a route opened.
#
# Two independent locks, and this script refuses to deploy if either secret is
# present in its own environment — a mistake that would otherwise be invisible.
#
# WHAT THE FINAL ASSERTIONS CAN AND CANNOT PROVE. They prove the token was
# absent AT DEPLOY, not forever, and they are POSITIVE-CONTROLLED on purpose:
# a 503 from "the gate is shut" and a 503 from "nothing is listening" are the
# same output, so a read is asserted to return 200 through the same hostname
# first. Without that control the negative assertion would pass most loudly
# when the service was simply down.
#
# NOT THE SHARED BOX. 209.209.10.210 already serves pythscan.com and the
# discord avatar app, and usefloat.xyz's DNS pointed there with no vhost
# answering. Deploy this to its own machine: the project memory records a
# hand-rolled deploy on a shared box restarting 2 of 4 services and leaving
# root-owned files in a service-owned tree.
#
# systemd rather than pm2, unlike scripts/deploy-vps.sh. That script manages a
# pm2 process on a box that already runs pm2 for other services; this is one
# service on a clean machine, so systemd is one less dependency and restarts on
# boot without `pm2 startup`.
#
# Usage, as a NON-ROOT user who can sudo:
#   DOMAIN=usefloat.xyz \
#   VAULT=<the demo vault> TOKEN=usdc.fakes.testnet \
#   ./scripts/deploy-skill-host.sh
#
#   SKIP_DASHBOARD=1 deploys only the signing page and /skill.md.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
# `app.` IS CLAIMED AND MUST STAY A REDIRECT. The published @floatonnear/mcp
# 0.5.0 builds signing links at app.$DOMAIN, so pointing it at the dashboard
# would break vault creation for everyone already installed. The dashboard gets
# `dash.` — a new name nothing has been told about yet.
ALT_NAMES="${ALT_NAMES:-www.$DOMAIN app.$DOMAIN}"
DASH_NAME="${DASH_NAME:-dash.$DOMAIN}"
ROOT="${ROOT:-/srv/float-near-web}"
SERVICE="${SERVICE:-float-near-web}"
PORT="${PORT:-8080}"
# SSH, NOT HTTPS, because this repository is PRIVATE. The https form cannot
# clone it on a headless box: git has no credential helper and no tty, so it
# dies with `could not read Username for 'https://github.com': No such device
# or address` — an error about a missing TTY that says nothing about the real
# cause, which is that the box has no GitHub credential at all.
#
# The box authenticates with a READ-ONLY deploy key (generated ON the host, so
# the private half never travels) registered at
# repos/bshuaibu1/float-near/keys with read_only=true. Read-only matters: a
# deploy key with write access turns a compromised web box into repository
# write access.
#
# Verified from wattson 2026-11-09: https failed, ssh cloned.
REPO="${REPO:-git@github.com:bshuaibu1/float-near.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
EMAIL="${EMAIL:-}"

SKIP_DASHBOARD="${SKIP_DASHBOARD:-}"
DASH_SERVICE="${DASH_SERVICE:-float-near-dash}"
DASH_PORT="${DASH_PORT:-3000}"
ADAPTER_SERVICE="${ADAPTER_SERVICE:-float-near-adapter}"
ADAPTER_PORT="${ADAPTER_PORT:-8787}"
# The adapter's DEFAULT vault — what a request with no ?vault= reads. Every
# other vault is reachable per-request, so this is the demo, not a limit.
VAULT="${VAULT:-}"
TOKEN="${TOKEN:-}"
TOKEN_DECIMALS="${TOKEN_DECIMALS:-6}"
FACTORY="${FACTORY:-fac.floatv4.testnet}"
NETWORK="${NETWORK:-testnet}"
VAULT_RPC_URL="${VAULT_RPC_URL:-https://test.rpc.fastnear.com}"

die() { echo "FATAL: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# ---- refuse before touching anything ---------------------------------------

[ -n "$DOMAIN" ] || die "DOMAIN is required, e.g. DOMAIN=usefloat.xyz $0
  It is used for the nginx server_name AND the TLS certificate, and a wrong
  value produces a certificate for a host nobody asked for."

[ "$(id -u)" -ne 0 ] || die "do not run this as root.
  A root-owned checkout under $ROOT cannot be written by '$SERVICE_USER'
  afterwards, and the symptom is silent: deploys appear to work and the
  service keeps running the old code. Run as the service user with sudo
  available."

command -v node >/dev/null || die "node is not installed. Install Node 20+ first."
command -v git  >/dev/null || die "git is not installed."

# ---- the two secrets that must NOT be here -----------------------------------
#
# REFUSED BEFORE ANYTHING IS TOUCHED, because the failure is otherwise silent:
# the box would come up looking perfect and be an open money-moving endpoint.
#
# FLOAT_API_TOKEN is the dangerous one. apps/dashboard/app/api/float/[...path]
# attaches it to any mutating request WITHOUT authenticating the caller — right
# on a laptop, where it keeps the token out of the browser, and catastrophic in
# public, where it makes /v1/pay reachable by anyone up to the vault's caps.
#
# Checked with `${X+set}`, NOT `-n "$X"`: an EMPTY token is still a decision
# someone made and still ends up in the systemd unit, and `-n` would wave it
# through. This refuses the variable EXISTING, not just being non-empty.
for secret in FLOAT_API_TOKEN NEAR_VAULT_AGENT_KEY NEAR_VAULT_AGENT_KEY_FILE \
              FLOAT_QUOTE_SIGNER_KEY FLOAT_QUOTE_SIGNER_KEY_FILE; do
  eval "present=\${$secret+set}"
  [ -z "${present:-}" ] || die "$secret is set in this shell, and this deploy is PUBLIC.
  Nothing on this box may hold a credential that authorizes spending:
    FLOAT_API_TOKEN      the dashboard proxy attaches it without authenticating
                         the caller, so a token here is an open /v1/pay.
    NEAR_VAULT_AGENT_KEY signs payments.
  Unset it and re-run:  unset $secret
  (An EMPTY value is refused too — it would still be written to the unit.)"
done

# The DNS must already point here, or certbot's HTTP-01 challenge fails in a
# way that reads as a certbot problem rather than a DNS one.
server_ip="$(curl -s --max-time 10 https://api.ipify.org || true)"
[ -n "$server_ip" ] || die "could not determine this machine's public IP; is it online?"
CERT_NAMES="$DOMAIN $ALT_NAMES"
[ -n "$SKIP_DASHBOARD" ] || CERT_NAMES="$CERT_NAMES $DASH_NAME"
for name in $CERT_NAMES; do
  resolved="$(getent hosts "$name" | awk '{print $1}' | head -1 || true)"
  [ -n "$resolved" ] || die "$name does not resolve. Create an A record -> $server_ip first.
  The dashboard needs its own record: $DASH_NAME -> $server_ip"
  [ "$resolved" = "$server_ip" ] || die "$name resolves to $resolved, not this machine ($server_ip).
  Repoint the A record and wait for propagation. Issuing a certificate now
  would fail the HTTP-01 challenge."
done
say "DNS: $CERT_NAMES all resolve to $server_ip"

# A foreign listener on the port is a collision, not something to restart.
if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  if ! systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    die "port $PORT is in use and '$SERVICE' is not the one using it.
  Something else owns that port; find it with: sudo ss -ltnp 'sport = :$PORT'"
  fi
fi

# ---- the checkout ----------------------------------------------------------

if [ -d "$ROOT/.git" ]; then
  owner="$(stat -c '%U' "$ROOT")"
  [ "$owner" = "$SERVICE_USER" ] || die "$ROOT is owned by '$owner', not '$SERVICE_USER'.
  Fix with: sudo chown -R $SERVICE_USER:$SERVICE_USER $ROOT"
  say "updating $ROOT"
  git -C "$ROOT" fetch --quiet origin "$BRANCH"
  git -C "$ROOT" reset --hard --quiet "origin/$BRANCH"
else
  # CHECK ACCESS BEFORE CREATING ANYTHING. A failed clone after mkdir leaves an
  # empty $ROOT that the next run treats as "not a git checkout" and retries
  # into, and the git error itself names a missing TTY rather than a missing
  # credential.
  case "$REPO" in
    git@*|ssh://*)
      # CAPTURED, NOT PIPED, and that is the whole point of this shape.
      #
      # `ssh -T git@github.com` ALWAYS exits 1 — GitHub refuses the shell on
      # purpose, even on a perfect authentication. Under `set -o pipefail` at
      # the top of this script, that 1 propagates through the pipe no matter
      # what grep found, so `ssh ... | grep -q ... || die` could NEVER pass.
      # Measured on wattson: identical command, guard passes without pipefail
      # and fails with it, while the clone it was guarding worked fine.
      #
      # A guard written to prevent a cryptic failure became one. `|| true`
      # keeps the non-zero exit from killing the script under `set -e`, and the
      # verdict comes from the TEXT, which is the thing that actually carries
      # the answer.
      gh_probe="$(ssh -o StrictHostKeyChecking=no -o BatchMode=yes -T git@github.com 2>&1 || true)"
      case "$gh_probe" in
        *"successfully authenticated"*) : ;;
        *) die "this box cannot authenticate to GitHub, so the private repo
  cannot be cloned. Generate a key here and register it READ-ONLY:
    ssh-keygen -t ed25519 -N '' -f ~/.ssh/github_deploy
    printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
  then add ~/.ssh/github_deploy.pub at
    https://github.com/bshuaibu1/float-near/settings/keys  (leave write access OFF)

  ssh said: ${gh_probe:-(no output at all — is outbound :22 blocked?)}" ;;
      esac
      ;;
  esac
  say "cloning into $ROOT"
  sudo mkdir -p "$ROOT"
  sudo chown "$SERVICE_USER:$SERVICE_USER" "$ROOT"
  git clone --quiet --branch "$BRANCH" "$REPO" "$ROOT"
fi
DEPLOYED_SHA="$(git -C "$ROOT" rev-parse --short HEAD)"

# The page fetches ./vault.wasm, and serve.mjs maps it to the create-float
# package. Missing, every vault creation fails at the last step with a 404 the
# user cannot act on.
[ -f "$ROOT/packages/create-float/res/vault.wasm" ] \
  || die "packages/create-float/res/vault.wasm is missing from the checkout.
  The signing page cannot create a vault without it."
[ -f "$ROOT/SKILL.md" ] || die "SKILL.md is missing; /skill.md would 404."

if [ -z "$SKIP_DASHBOARD" ]; then
  # Required, not defaulted. A wrong vault id does not fail — it renders
  # somebody else's numbers as the demo, which is the bug this whole
  # multi-tenancy effort was about. A wrong TOKEN is worse: ft_balance_of on a
  # real-but-wrong token returns "0" rather than erroring, so every balance
  # reads as empty and nothing says why.
  [ -n "$VAULT" ] || die "VAULT is required (the adapter's DEFAULT vault, shown when a
  request names none). Other vaults are reachable per-request, so this is the
  demo vault, not a limit. Pass SKIP_DASHBOARD=1 to deploy only the page."
  [ -n "$TOKEN" ] || die "TOKEN is required, e.g. TOKEN=usdc.fakes.testnet.
  A real-but-wrong token id returns \"0\" from ft_balance_of instead of an
  error, so every balance would render as empty with no explanation."
fi

# ---- the service -----------------------------------------------------------

say "writing systemd unit $SERVICE"
sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=Float signing page and skill.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT
# LOOPBACK ONLY. nginx terminates TLS and proxies in; binding 0.0.0.0 would
# expose the page on :$PORT without a certificate, and browsers would be
# reaching an origin that is not the one the certificate names.
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
ExecStart=$(command -v node) $ROOT/web/serve.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --quiet "$SERVICE"
sudo systemctl restart "$SERVICE"

for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" \
  || die "$SERVICE did not come up. Logs: sudo journalctl -u $SERVICE -n 50 --no-pager"
say "$SERVICE is up on 127.0.0.1:$PORT ($DEPLOYED_SHA)"

# ---- the adapter and the dashboard, both on loopback -----------------------

if [ -z "$SKIP_DASHBOARD" ]; then
  command -v npm >/dev/null || die "npm is not installed, and the dashboard needs a build."

  # TWO INSTALLS, because apps/dashboard is NOT in the workspace. The root
  # package.json declares `workspaces: ["packages/*"]` only, so a root install
  # does not reach it — and the adapter DOES need the root one, because it
  # imports @floatonnear/mcp/payloads from a sibling package.
  # A FULL install, dev dependencies included. Both builds run `tsc`/`next`,
  # which live in devDependencies, so `--omit=dev` produces a tree that cannot
  # build and an error pointing at the compiler rather than at this choice.
  say "installing and building the adapter (workspace root)"
  ( cd "$ROOT" && npm install >/dev/null )
  # DEPENDENCY ORDER, EXPLICITLY. The adapter's tsc reads @floatonnear/mcp's
  # TYPES from packages/mcp/dist/*.d.ts, so mcp must be built FIRST. Building
  # only the adapter on a fresh checkout fails with "has no exported member"
  # for every symbol mcp provides — an error that reads like a missing feature
  # rather than a missing build step. Measured on wattson 2026-11-09.
  #
  # Not relying on `npm run build --workspaces` to topologically sort: being
  # explicit costs one line and removes a dependency on npm's ordering.
  ( cd "$ROOT" && npm run build --workspace @floatonnear/mcp >/dev/null )
  [ -f "$ROOT/packages/mcp/dist/index.d.ts" ]     || die "@floatonnear/mcp did not build; the adapter cannot resolve its types."
  ( cd "$ROOT" && npm run build --workspace @floatonnear/float-adapter >/dev/null )
  # ASSERT THE ARTIFACT, do not trust the exit code. `cargo near build` in this
  # repo has printed success while doing nothing; a build tool reporting ok is
  # not evidence the file exists.
  [ -f "$ROOT/packages/float-adapter/dist/server.js" ] \
    || die "the adapter did not build; packages/float-adapter/dist/server.js is missing."

  say "installing and building the dashboard (separate tree)"
  ( cd "$ROOT/apps/dashboard" && npm install >/dev/null )
  # NEXT_PUBLIC_* IS BAKED IN AT BUILD TIME, not read at runtime, so the
  # signing-page URL has to be present for THIS command or the hosted page
  # links at 127.0.0.1 and is dead for every visitor.
  ( cd "$ROOT/apps/dashboard" && NEXT_PUBLIC_SIGNING_PAGE_URL="https://$DOMAIN/" npm run build >/dev/null )
  [ -d "$ROOT/apps/dashboard/.next" ] \
    || die "the dashboard did not build; apps/dashboard/.next is missing."

  say "writing systemd unit $ADAPTER_SERVICE"
  sudo tee "/etc/systemd/system/$ADAPTER_SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=Float adapter (read-only: no agent key, no API token)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT/packages/float-adapter
# LOOPBACK. gate.ts defaults to 127.0.0.1 precisely so exposure is opted into,
# but saying it here means the unit does not depend on that default holding.
Environment=HOST=127.0.0.1
Environment=PORT=$ADAPTER_PORT
Environment=NEAR_NETWORK=$NETWORK
Environment=NEAR_VAULT_RPC_URL=$VAULT_RPC_URL
Environment=NEAR_VAULT_CONTRACT=$VAULT
Environment=NEAR_VAULT_FACTORY=$FACTORY
Environment=NEAR_VAULT_TOKEN=$TOKEN
Environment=NEAR_VAULT_TOKEN_DECIMALS=$TOKEN_DECIMALS
# ABSOLUTE, because these default to CWD-RELATIVE paths and the service's CWD
# is not the repo root. Measured 2026-11-09: the adapter run from
# packages/float-adapter wrote its refusal store to
# packages/float-adapter/.demo/ while scripts/scan-blocked.mjs, run from the
# repo root, wrote to .demo/ — two files for one vault, and the dashboard
# rendered 3 settled payments and ZERO refusals. The blocked payment is the
# single most valuable thing in the fixture, so losing it silently is the
# worst available failure.
# THE REFUSAL FOLLOWER IS OFF ON THIS BOX, and the number is measured rather
# than assumed. With it on: 117 rate-limit lines in two minutes, /healthz
# answering 500, and /v1/resolve degraded — on a host whose BARE RPC health is
# 40/40. It scans every block from its cursor to the chain head, so a longer
# interval only batches the same reads; the cost is the block rate, not the
# tick rate.
#
# AN EARLIER CONCLUSION HERE WAS WRONG AND IS CORRECTED: a measurement taken
# on a dev machine said the follower was innocent, but that machine's own IP
# was throttled, which masked the effect. On a clean host the effect is plain.
#
# What is lost: refusals that happen AFTER deployment are not picked up, so
# the activity page's coverage window stops advancing. That is acceptable here
# and the banner already tells the truth about it — outside the scanned range
# refusals are UNKNOWN, not absent. /v1/pay is disabled on this box, so no
# refusal can originate from it either.
#
# To refresh after a live demo, re-scan on the box and restart:
#   NEAR_VAULT_CONTRACT=<vault> node scripts/scan-blocked.mjs --from <block>
Environment=BLOCKED_FOLLOW=${BLOCKED_FOLLOW:-0}
Environment=BLOCKED_LOG=$ROOT/.demo/blocked-log.$(printf '%s' "$VAULT" | sed 's/[^a-zA-Z0-9._-]/_/g').json
Environment=RELAY_LEDGER=$ROOT/.demo/relay-ledger.json
#
# DELIBERATELY ABSENT, and this emptiness is the security property:
#   FLOAT_API_TOKEN       every token-gated route answers 503. /v1/owner-plan
#                         still works — it returns an UNSIGNED payload the
#                         owner approves in their own wallet.
#   NEAR_VAULT_AGENT_KEY  nothing to sign a payment with.
# Adding either turns this into a money-moving endpoint on the public
# internet. If you need /v1/pay, run the adapter on your own machine.
#
ExecStart=$(command -v node) $ROOT/packages/float-adapter/dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

  say "writing systemd unit $DASH_SERVICE"
  sudo tee "/etc/systemd/system/$DASH_SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=Float dashboard (multi-tenant reads, no API token)
After=network-online.target $ADAPTER_SERVICE.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$ROOT/apps/dashboard
Environment=PORT=$DASH_PORT
Environment=NODE_ENV=production
# Server-only, NOT NEXT_PUBLIC_: a NEXT_PUBLIC_ name is inlined into the
# browser bundle and would publish the adapter's address to every visitor.
Environment=FLOAT_ADAPTER_URL=http://127.0.0.1:$ADAPTER_PORT
Environment=NEXT_PUBLIC_SIGNING_PAGE_URL=https://$DOMAIN/
#
# FLOAT_API_TOKEN IS DELIBERATELY ABSENT. The proxy attaches it to any
# mutating request without authenticating the caller, so setting it here
# would let anyone on the internet POST /api/float/v1/pay.
#
# `-H 127.0.0.1` ON THE COMMAND LINE, because `next start` IGNORES the
# HOSTNAME environment variable and defaults to 0.0.0.0. This unit used to set
# Environment=HOSTNAME=127.0.0.1 and the dashboard bound every interface
# anyway — confirmed by `ss -ltnp` showing `*:3000` and by the deploy's own
# negative assertion getting HTTP 200 from the PUBLIC ip. A config that looks
# right and is silently ignored is worse than one that errors.
ExecStart=$(command -v npm) run start -- -H 127.0.0.1 -p $DASH_PORT
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

  sudo systemctl daemon-reload
  for s in "$ADAPTER_SERVICE" "$DASH_SERVICE"; do
    sudo systemctl enable --quiet "$s"
    sudo systemctl restart "$s"
  done

  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:$ADAPTER_PORT/healthz" \
      && curl -sf -o /dev/null "http://127.0.0.1:$DASH_PORT/" && break
    sleep 2
  done
  curl -sf -o /dev/null "http://127.0.0.1:$ADAPTER_PORT/healthz" \
    || die "$ADAPTER_SERVICE did not come up. sudo journalctl -u $ADAPTER_SERVICE -n 50 --no-pager"
  curl -sf -o /dev/null "http://127.0.0.1:$DASH_PORT/" \
    || die "$DASH_SERVICE did not come up. sudo journalctl -u $DASH_SERVICE -n 50 --no-pager"
  say "$ADAPTER_SERVICE on 127.0.0.1:$ADAPTER_PORT, $DASH_SERVICE on 127.0.0.1:$DASH_PORT"
fi

# ---- nginx -----------------------------------------------------------------

command -v nginx >/dev/null || die "nginx is not installed. sudo apt install -y nginx"

say "writing nginx vhost for $DOMAIN"
#
# HTTP ONLY, AND CERTBOT ADDS THE TLS. Writing `listen 443 ssl` here cannot
# work on a FIRST deploy: no certificate exists yet, so `nginx -t` fails with
#
#   no "ssl_certificate" is defined for the "listen ... ssl" directive
#
# and the script dies before certbot ever runs. It would only have passed on a
# box that already had certs — i.e. never on the first run, which is the only
# run that matters. Measured on wattson 2026-11-09.
#
# `certbot --nginx` reads these server blocks, adds `listen 443 ssl` with the
# right `ssl_certificate` paths, and (with --redirect) turns port 80 into a
# redirect. Letting it do that is the supported path and keeps the cert paths
# in one place rather than hardcoded here.
#
# EVERY port-80 block serves the ACME challenge, including the ones that only
# redirect. A `return 301` without that location would bounce certbot's own
# HTTP-01 challenge to https — which has no certificate yet — and issuance
# fails for exactly the names that are only redirects.
sudo tee "/etc/nginx/sites-available/$SERVICE" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name $ALT_NAMES;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    # \$request_uri, NOT \$uri: the MCP builds signing links with a query
    # string (?factory=...&label=...) and the published 0.5.0 still defaults to
    # app.$DOMAIN. Dropping the query would send a user to a blank page.
    location / { return 301 https://$DOMAIN\$request_uri; }
}
NGINX

if [ -z "$SKIP_DASHBOARD" ]; then
sudo tee -a "/etc/nginx/sites-available/$SERVICE" >/dev/null <<NGINX

server {
    listen 80;
    listen [::]:80;
    server_name $DASH_NAME;

    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass http://127.0.0.1:$DASH_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # Next.js streams; buffering makes a slow chain read as a hang.
        proxy_buffering off;
    }
}
NGINX
fi

sudo ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t || die "nginx config is invalid; nothing was reloaded."
sudo systemctl reload nginx

# ---- TLS -------------------------------------------------------------------

if [ -z "${SKIP_CERTBOT:-}" ]; then
  command -v certbot >/dev/null || die "certbot is not installed.
  sudo apt install -y certbot python3-certbot-nginx"
  # The cert covers dash. too, but dash. is NOT in ALT_NAMES — ALT_NAMES is the
  # set that gets 301'd to the apex, and the dashboard must serve, not redirect.
  names="-d $DOMAIN"; for n in $ALT_NAMES; do names="$names -d $n"; done
  [ -n "$SKIP_DASHBOARD" ] || names="$names -d $DASH_NAME"
  email_arg="--register-unsafely-without-email"
  [ -n "$EMAIL" ] && email_arg="--email $EMAIL"
  say "requesting a certificate for $DOMAIN $ALT_NAMES"
  # shellcheck disable=SC2086
  sudo certbot --nginx $names --non-interactive --agree-tos $email_arg --redirect \
    || die "certbot failed. The vhost is in place and serving HTTP; re-run once
  the cause is fixed. Check: sudo certbot certificates"
fi

# ---- assert, rather than announce -------------------------------------------

say "checking what is actually reachable"
problems=0
check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "    ok    $1"; else echo "    BROKEN  $1 (expected $2, got $3)"; problems=$((problems+1)); fi
}

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/skill.md" || true)"
check "https://$DOMAIN/skill.md serves" "200" "$code"

ctype="$(curl -s -o /dev/null -w '%{content_type}' --max-time 10 "https://$DOMAIN/skill.md" || true)"
case "$ctype" in text/plain*) echo "    ok    served as text/plain";; *) echo "    BROKEN  skill.md served as '$ctype'"; problems=$((problems+1));; esac

body="$(curl -s --max-time 10 "https://$DOMAIN/skill.md" || true)"
case "$body" in
  ---*) echo "    ok    body starts with the skill frontmatter";;
  *) echo "    BROKEN  skill.md body does not start with frontmatter"; problems=$((problems+1));;
esac
# A document an agent cannot act on is the same as no document.
case "$body" in
  *"claude mcp add"*|*mcpServers*) echo "    ok    carries setup instructions";;
  *) echo "    BROKEN  skill.md has no setup instructions"; problems=$((problems+1));;
esac

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" || true)"
check "the signing page serves" "200" "$code"

# The redirect must keep the query string, or every signing link breaks.
loc="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 "https://app.$DOMAIN/?factory=x&label=y" || true)"
case "$loc" in
  *"factory=x"*) echo "    ok    app.$DOMAIN redirect preserves the query string";;
  *) echo "    BROKEN  app.$DOMAIN redirect lost the query string: '$loc'"; problems=$((problems+1));;
esac

# NEGATIVE ASSERTIONS. The point is not that the page is up; it is that
# nothing which signs is.
#
# The services are now RUNNING on these ports, so this stopped being "is it
# absent" and became "is it bound to loopback only". Reaching them on the
# public IP would bypass nginx and TLS entirely.
# $PORT INCLUDED, and its absence is exactly how the signing page shipped
# bound to 0.0.0.0. The loop checked the adapter and the dashboard and simply
# never asked about the page itself, so `*:8080` passed every run.
for p in "$PORT" "$ADAPTER_PORT" "$DASH_PORT"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$server_ip:$p/" || true)"
  case "$code" in
    000) echo "    ok    :$p is not reachable on the public IP (loopback only)";;
    *) echo "    BROKEN  $server_ip:$p answers HTTP $code — it must be loopback only"; problems=$((problems+1));;
  esac
done

if [ -z "$SKIP_DASHBOARD" ]; then
  # ---- the money-moving assertion, positive-controlled -----------------------
  #
  # WHY A BARE 503 CHECK WOULD BE THEATRE. "The gate is shut" and "nothing is
  # listening" produce the SAME result, and the same is true of a 000. A
  # negative assertion that passes when the service is down is worse than no
  # assertion, because it reads as proof.
  #
  # So a READ through the same hostname must return 200 FIRST. That is the
  # control: it proves nginx, the dashboard and the proxy are all alive and
  # that the refusal below is therefore a decision rather than an absence.
  ctl="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DASH_NAME/api/float/v1/resolve?owner=$VAULT" || true)"
  case "$ctl" in
    200|404) echo "    ok    control: reads reach the adapter through https://$DASH_NAME (HTTP $ctl)";;
    *) echo "    BROKEN  control FAILED: a read through $DASH_NAME returned $ctl, so the"
       echo "            refusal below would prove nothing. Fix this before trusting it."
       problems=$((problems+1));;
  esac

  # Now the claim. Unauthenticated, from the public internet, exactly as an
  # attacker would send it.
  pay="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
    "https://$DASH_NAME/api/float/v1/pay" \
    -H 'content-type: application/json' \
    -d '{"amount":"1","recipient":"attacker.testnet"}' || true)"
  case "$pay" in
    503) echo "    ok    POST /api/float/v1/pay is REFUSED 503 — no token on this box";;
    *) echo "    BROKEN  POST /api/float/v1/pay returned $pay, not 503."
       echo "            This box can authorize payments from the internet. Stop and"
       echo "            check FLOAT_API_TOKEN is unset in $DASH_SERVICE and $ADAPTER_SERVICE."
       problems=$((problems+1));;
  esac

  # And with the token that is PUBLISHED IN THIS REPOSITORY. If someone set
  # FLOAT_API_TOKEN to the hardcoded restart-adapter.ps1 value, the check
  # above would still pass while this one catches it.
  pay2="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
    "https://$DASH_NAME/api/float/v1/pay" \
    -H 'authorization: Bearer local-dev-token' \
    -H 'content-type: application/json' \
    -d '{"amount":"1","recipient":"attacker.testnet"}' || true)"
  case "$pay2" in
    503) echo "    ok    the repository's own local-dev-token is not a key here either";;
    *) echo "    BROKEN  local-dev-token got HTTP $pay2 — a token published in git works"
       echo "            against this box. Unset FLOAT_API_TOKEN and redeploy NOW."
       problems=$((problems+1));;
  esac

  # Owner actions MUST work, or the hosted dashboard is read-only and the
  # whole point of gating by route rather than method is lost. 400 is the
  # expected answer to a deliberately incomplete body: it proves the route was
  # REACHED and validated, which 503 would not.
  plan="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
    "https://$DASH_NAME/api/float/v1/owner-plan" \
    -H 'content-type: application/json' -d '{"action":"freeze"}' || true)"
  case "$plan" in
    400) echo "    ok    /v1/owner-plan is reachable and validates (400 on a missing nodeId)";;
    503) echo "    BROKEN  /v1/owner-plan answered 503, so owner actions are dead here."
         echo "            The route gate is by METHOD again rather than by route."
         problems=$((problems+1));;
    *) echo "    BROKEN  /v1/owner-plan returned $plan; expected 400 on a missing nodeId"; problems=$((problems+1));;
  esac
fi

echo
if [ "$problems" -ne 0 ]; then
  die "$problems problem(s). The deploy is NOT good; fix before telling anyone the URL."
fi
echo "deployed $DEPLOYED_SHA — https://$DOMAIN/skill.md is live"
echo
echo "The install line is now:"
echo "    Set up https://$DOMAIN/skill.md"
if [ -z "$SKIP_DASHBOARD" ]; then
  echo
  echo "The dashboard is at https://$DASH_NAME — it shows each visitor THEIR"
  echo "own vault, derived from the wallet they connect, and an empty state"
  echo "with a create link when they have none."
  echo
  echo "It cannot move money: no FLOAT_API_TOKEN and no agent key on this box,"
  echo "asserted above against the public hostname. /v1/pay is 503 here by"
  echo "construction. To actually pay, run the adapter on your own machine."
fi

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
# THE ADAPTER DOES NOT GO ON THIS BOX. `POST /v1/pay` signs with the agent's
# key, and scripts/restart-adapter.ps1 hardcodes FLOAT_API_TOKEN=local-dev-token
# — a value that is in the repository. An adapter on the public internet with a
# published token would let anyone spend from the vault up to its caps. The
# adapter is an owner's local tool and stays on loopback. Same for the
# dashboard: it is a console for one configured vault and exposing it buys
# nothing. This script asserts both are absent at the end rather than trusting
# that nobody started them.
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
#   DOMAIN=usefloat.xyz ./scripts/deploy-skill-host.sh
set -euo pipefail

DOMAIN="${DOMAIN:-}"
ALT_NAMES="${ALT_NAMES:-www.$DOMAIN app.$DOMAIN}"
ROOT="${ROOT:-/srv/float-near-web}"
SERVICE="${SERVICE:-float-near-web}"
PORT="${PORT:-8080}"
REPO="${REPO:-https://github.com/bshuaibu1/float-near.git}"
BRANCH="${BRANCH:-main}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
EMAIL="${EMAIL:-}"

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

# The DNS must already point here, or certbot's HTTP-01 challenge fails in a
# way that reads as a certbot problem rather than a DNS one.
server_ip="$(curl -s --max-time 10 https://api.ipify.org || true)"
[ -n "$server_ip" ] || die "could not determine this machine's public IP; is it online?"
for name in $DOMAIN $ALT_NAMES; do
  resolved="$(getent hosts "$name" | awk '{print $1}' | head -1 || true)"
  [ -n "$resolved" ] || die "$name does not resolve. Create an A record -> $server_ip first."
  [ "$resolved" = "$server_ip" ] || die "$name resolves to $resolved, not this machine ($server_ip).
  Repoint the A record and wait for propagation. Issuing a certificate now
  would fail the HTTP-01 challenge."
done
say "DNS: $DOMAIN $ALT_NAMES all resolve to $server_ip"

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

# ---- nginx -----------------------------------------------------------------

command -v nginx >/dev/null || die "nginx is not installed. sudo apt install -y nginx"

say "writing nginx vhost for $DOMAIN"
sudo tee "/etc/nginx/sites-available/$SERVICE" >/dev/null <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN $ALT_NAMES;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$DOMAIN\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $ALT_NAMES;
    # \$request_uri, NOT \$uri: the MCP builds signing links with a query
    # string (?factory=...&label=...) and the published 0.5.0 still defaults to
    # app.$DOMAIN. Dropping the query would send a user to a blank page.
    return 301 https://$DOMAIN\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

sudo ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t || die "nginx config is invalid; nothing was reloaded."
sudo systemctl reload nginx

# ---- TLS -------------------------------------------------------------------

if [ -z "${SKIP_CERTBOT:-}" ]; then
  command -v certbot >/dev/null || die "certbot is not installed.
  sudo apt install -y certbot python3-certbot-nginx"
  names="-d $DOMAIN"; for n in $ALT_NAMES; do names="$names -d $n"; done
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
# nothing which signs is. An adapter reachable from the internet with the
# repository's own token would let anyone spend from the vault.
for p in 8787 3000; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$server_ip:$p/" || true)"
  case "$code" in
    000) echo "    ok    nothing answering publicly on :$p";;
    *) echo "    BROKEN  something answers on $server_ip:$p (HTTP $code) — it must not be public"; problems=$((problems+1));;
  esac
done

echo
if [ "$problems" -ne 0 ]; then
  die "$problems problem(s). The deploy is NOT good; fix before telling anyone the URL."
fi
echo "deployed $DEPLOYED_SHA — https://$DOMAIN/skill.md is live"
echo
echo "The install line is now:"
echo "    Set up https://$DOMAIN/skill.md"

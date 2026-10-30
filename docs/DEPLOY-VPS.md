# Deploying the adapter to a VPS

`scripts/deploy-vps.sh` **is** the runbook. This document explains the decisions
behind it so you can tell when it is wrong, not to give you commands to run
instead of it.

> **Not yet run on a real host.** Everything below is derived from this repo's
> code and from the conventions of the two VPS deployments already in the global
> notes. The script is syntax-checked and its logic reviewed, but it has not
> been executed against a live VPS. Treat the first run as a test: use a
> throwaway `ROOT` and a loopback bind before pointing anything real at it.

## What is being deployed, and what it is not

Only the **adapter** — the HTTP service that serves the Float dashboard's `/v1`
API by reading NEAR vault views. The vault contract itself lives on NEAR and is
deployed by `scripts/upgrade-vault.sh`; nothing here touches chain state.

The MCP server is **not** deployed. It speaks stdio and is launched on demand by
the agent's own client via `npx @floatonnear/mcp`. There is nothing to run as a
service.

## The name and port are not yours by default

The existing Float product already runs under pm2 on a VPS:

| name | what it is |
| --- | --- |
| `float-dashboard` | Solana product's Next.js dashboard |
| `float-admin` | Solana product's admin |
| `float-api` | **Solana product's API** |
| `walrus-frontend`, `walrus-relay` | unrelated project |

So this service is `float-near-adapter`, out of `/srv/float-near`. `pm2 restart
float-api` would restart the wrong product.

The script refuses to touch a pm2 process whose `cwd` is not the tree it is
deploying, and refuses a port that is already bound unless the bound listener is
its own previous instance. That is the same lesson as the MCP config key:
`create-float` used to claim the `float` key unconditionally, and on a real
machine that key already belonged to `@usefloat/mcp` holding an owner key.
**A name you did not reserve is somebody else's.**

## Why there is no `set -a && . adapter.env`

Every doc in this repo used to say:

```bash
set -a && . .float/adapter.env && set +a && npx @floatonnear/float-adapter
```

Two problems, one of which has already happened on another box:

1. **It executes the file.** `. file` is `source`. A value containing `$(...)`
   or backticks runs as a command. This file holds `NEAR_VAULT_AGENT_KEY`,
   `FLOAT_QUOTE_SIGNER_KEY` and `FLOAT_API_TOKEN` — it should be data.
2. **One unquoted value with a space kills it.** On another deployment a line
   reading `X_MAINTENANCE_MESSAGE=Pyth Scan is temporarily...` made
   `set -a; . .env; set +a` die with `Scan: command not found`, and every script
   that opened with that line failed before it ran.

The adapter now reads the file itself:

```bash
FLOAT_ENV_FILE=/srv/float-near/.float/adapter.env node packages/float-adapter/dist/server.js
```

Parsed by `parseEnvFile` in `packages/float-adapter/src/env-file.ts` — no shell,
no interpolation, no command substitution, tested against exactly the shapes
that broke the shell. Real environment variables win over the file, so `PORT`
and `HOST` can be set per-service without editing shared secrets.

This also removes the PowerShell-specific `Get-Content | Set-Item Env:`
incantation needed to start the adapter on Windows. One mechanism, both
platforms.

## One-time setup

```bash
# as root, once
sudo mkdir -p /srv/float-near
sudo chown -R "$USER":"$USER" /srv/float-near

# as the service user, never root
git clone https://github.com/bshuaibu1/float-near.git /srv/float-near
```

Then get the secrets onto the box. **Generate them on a trusted machine**, not
on the VPS — `create-float` mints the agent key and the quote signer, and the
fewer places that happens the better:

```bash
# on your machine, after running create-float
scp .float/adapter.env user@host:/srv/float-near/.float/adapter.env
ssh user@host 'chmod 600 /srv/float-near/.float/adapter.env'
```

The script refuses to start if that file is not mode `600` or `400`. It holds
private keys.

## Every deploy after that

```bash
sudo -u <service-user> bash /srv/float-near/scripts/deploy-vps.sh
```

Never as root. Root `git`/`npm` in a service-owned tree leaves root-owned
`.git/index` and caches that the service user can no longer write, and the
symptom is silent degradation rather than a crash. The script checks for
pre-existing root-owned files *before* doing anything, so a previous bad deploy
is reported instead of compounded.

Useful overrides:

```bash
PORT=8788 bash scripts/deploy-vps.sh          # a second vault on one box
BRANCH=intents-rail bash scripts/deploy-vps.sh
SKIP_PULL=1 bash scripts/deploy-vps.sh        # deploy the tree as-is
```

## Exposure

`HOST` defaults to `127.0.0.1`. **`POST /v1/pay` signs with the agent key** —
anything that can reach the port and holds `FLOAT_API_TOKEN` can spend the
budget. That route shipped once with no authentication at all, bound to every
interface, which is finding F1 in `docs/SELF-REVIEW-2026-10-29.md`.

To expose it you must say so:

```bash
HOST=0.0.0.0 CONFIRM_EXPOSE=1 bash scripts/deploy-vps.sh
```

Do that only behind a reverse proxy terminating TLS, with the port firewalled
off from the internet. The adapter speaks plain HTTP and has no rate limiting.

`FLOAT_ALLOWED_ORIGIN` must also be set to the dashboard's real origin, or the
browser is refused by exact-match CORS.

## What the script asserts before claiming success

It does not report a clean deploy without checking, because "it restarted" and
"it works" are different claims:

| check | expected |
| --- | --- |
| `pm2` status | `online` |
| `GET /v1/dashboard` | `200` |
| `POST /v1/pay` with no token | **`401`** |
| pm2 error log | printed, with total line count |

The `401` is a live regression test for F1. A `503` there means
`FLOAT_API_TOKEN` reached the file but not the process — the script says so
explicitly, because those two failures look identical from the outside and have
completely different fixes.

The error log is printed with its **total line count**, and the script says that
the lines shown may predate this deploy. Whether a log line is current is a
separate claim from whether it appears in a `tail`; appearing in a tail
establishes nothing about when it was written.

## Rollback

pm2 keeps the previous process definition, but the code is from git, so roll
back the tree:

```bash
git -C /srv/float-near log --oneline -5
BRANCH=<previous-sha> SKIP_PULL=0 bash scripts/deploy-vps.sh
```

The adapter is stateless apart from `RELAY_LEDGER` and `BLOCKED_LOG` if those
are configured, so a rollback needs no data migration. The **vault contract** is
the opposite — see `scripts/upgrade-vault.sh`, where a bad deploy can brick
state and the migration runs in the same transaction for that reason.

## What is still missing

Named rather than left to be discovered:

- **No systemd unit.** pm2 matches the conventions of the existing deployments,
  but it depends on `pm2 save` plus `pm2 startup` having been run once for the
  service to survive a reboot. The script runs `pm2 save`; it does not configure
  `pm2 startup`.
- **No health endpoint.** `/v1/dashboard` is used as a liveness probe, which
  means a liveness check performs real RPC calls against NEAR. A dedicated
  `/healthz` that does not touch the network would be better.
- **No log rotation.** pm2's logs grow without bound. `pm2 install
  pm2-logrotate` once per box.
- **One agent per adapter.** `POST /v1/pay` signs as a single agent
  (`NEAR_VAULT_AGENT_ID`). A vault with several agents needs one adapter per
  agent, on distinct ports, or the agents sign for themselves over MCP.

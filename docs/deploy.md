# Deploying Tincazz

How to run the bot on a VPS with Docker, how deploys from GitHub work, and what to do when
something breaks. For local development see the [README](../README.md).

## How it ships

Every push to `main` that passes CI (lint, typecheck, tests, build) builds a Docker image and
publishes it to `ghcr.io/cazzwastaken/tincazz` (see `.github/workflows/docker.yml`). `v*` git tags
publish versioned images, and every image is also tagged `sha-<commit>`. The server only needs
Docker, `docker-compose.yml` and a `.env` file.

Before merging or deploying to `main`, do any manual step the change needs: a new intent or
permission in the Developer Portal, a `.env` variable or a `docker-compose.yml` change. Deploys are
automatic and do not roll back on their own. The **Server Members Intent** in particular must be
enabled first: the bot always requests it and cannot log in without it.

## One-time VPS setup

After [installing Docker](https://docs.docker.com/engine/install/):

```sh
mkdir tincazz && cd tincazz
curl -fsSLO https://raw.githubusercontent.com/cazzwastaken/tincazz/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/cazzwastaken/tincazz/main/.env.example -o .env
chmod 600 .env && nano .env   # set DISCORD_TOKEN
docker compose up -d
docker compose logs -f
```

The first image is published after the first push to `main`. Open the package's settings on GitHub
and set its visibility to **public** (or run `docker login ghcr.io` on the VPS with a token that
has `read:packages`).

The container restarts automatically after crashes and reboots (`restart: unless-stopped`). It runs
as a non-root user with a read-only filesystem and no extra capabilities, and its logs are rotated
(3 files of 10 MB), so it will not fill the disk.

## Automatic deploys

The `deploy` job in `docker.yml` runs after a successful publish on `main` (not for tags or pull
requests) and SSHes into the VPS to pull the new image and restart the bot. It runs in the
`production` GitHub environment, which holds these secrets:

| Secret            | Value                                                                         |
| ----------------- | ----------------------------------------------------------------------------- |
| `VPS_HOST`        | the server's host name or address                                             |
| `VPS_USER`        | the deploy user                                                               |
| `VPS_SSH_KEY`     | the private key CI logs in with                                               |
| `VPS_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <host>` output; its first field must match `VPS_HOST` |

On the VPS, create a dedicated `deploy` user in the `docker` group with the compose project in
`~/tincazz`, and give CI a dedicated key restricted to one command in `~/.ssh/authorized_keys`:

```
command="cd ~/tincazz && docker compose pull && docker compose up -d && docker image prune -f",restrict ssh-ed25519 AAAA... tincazz-ci
```

Notes:

- The forced command wins: whatever the workflow passes to `ssh` is ignored, so CI cannot run extra
  steps (such as a health check) over that key. To add one, extend the server-side command.
- A leaked key can do nothing except redeploy.
- The job does not update `docker-compose.yml` or `.env` on the server. Changing either is a manual
  step on the VPS.
- Set the private key secret from the key file so its formatting survives, never by pasting into
  the web UI: `gh secret set VPS_SSH_KEY --env production < <path-to-private-key>`.
- Never `echo` secrets or enable shell tracing in the job. Keep real hosts, users and keys out of
  the repository, docs and logs.

### Troubleshooting a failed deploy job

Read the log with `gh run view <id> --log-failed`.

- `error in libcrypto` followed by `Permission denied (publickey,password)`: the `VPS_SSH_KEY`
  secret is malformed. Set it again from the key file as above.
- `Host key verification failed`: `VPS_KNOWN_HOSTS` is stale or does not match `VPS_HOST`.
- `Permission denied (publickey)` with a valid key: check ownership and modes of the deploy user's
  home, `~/.ssh` (700) and `authorized_keys` (600) on the server.

## Manual update

```sh
docker compose pull && docker compose up -d
```

`docker compose pull` only updates the image. When a release changes `docker-compose.yml`, fetch
the new file too (the same `curl` as in the setup) before running `up -d`.

## Backups

The SQLite database lives on the `tincazz-data` Docker volume, mounted at `/app/data` (the only
writable path in the container). To back it up:

```sh
docker compose exec bot node -e "require('better-sqlite3')('/app/data/tincazz.db').backup('/app/data/backup.db')"
docker compose cp bot:/app/data/backup.db .
```

## Troubleshooting

**The bot restarts in a loop with `SqliteError: unable to open database file`
(`SQLITE_CANTOPEN`).** The container has no writable `/app/data`. The usual cause is an outdated
`docker-compose.yml` without the `tincazz-data` volume: check that `docker compose config` lists it
under `volumes`, replace the file with the current one and run `docker compose up -d`. Also make
sure `DATABASE_PATH` in `.env` is unset or points inside `/app/data`.

**The bot exits at startup and the log mentions disallowed intents (4014).** Enable the **Server
Members Intent** and **Message Content Intent** in the Developer Portal (Bot tab), then restart.

## Rolling back

Set the `image:` tag in `docker-compose.yml` to an earlier build (`sha-<commit>` or a `v*` version),
then run `docker compose up -d`. Switch back to `latest` to follow `main` again. Database
migrations only move forward, so restore a backup if a rollback crosses a schema change.

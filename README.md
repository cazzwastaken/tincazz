# Tincazz

Discord bot for the cazzwastaken community server, built with TypeScript, discord.js and the
Sapphire framework.

Currently implemented:
- `?ping` / `/ping`: the bot's latency
- `?help` / `/help`: the games, the ways to earn coins and the bet limits (built from the config)
- `?gamba [bet]` / `/gamba bet:<bet>`: wagered spins with a progressive pot (see below).
  `?gamba` is the classic plain-text reply, `/gamba` the polished card with buttons; both share the
  same economy
- `/coinflip bot|challenge|open [bet] [side]`: flip a coin against the bot, challenge a member
  (60 seconds to accept) or open a flip anyone can accept (120 seconds). Bets range from 10 to
  10,000 coins (default 10). The winner takes the pool minus a 3% rake (at least 1 coin) that goes into
  the gamba pot; against the bot a win nets the bet minus the rake and a loss costs the bet. The
  coin spins for about three seconds (the card is edited a few times) before the result shows. A
  finished challenge has a Rematch button: either player can press it; the first press challenges
  the other for the same bet, keeping the side they had, and removes the button
- `?coinflip [bet] [heads|tails]`, `?coinflip @member [bet] [side]`, `?coinflip open [bet] [side]`
  (aliases `?cf`, `?flip`): the same coinflip from a message, arguments in any order (`?cf 100 t`).
  A challenge pings only the member it names, who must be in the server
- `/dice [bet] [on]`: roll two dice against the bot, calling `high` (8-12, the default), `low`
  (2-6), `seven`, `doubles` or an exact total. Bets range from 10 to 10,000 coins (default 10). A win
  pays 99% of fair odds (2.376x on high or low, 5.94x on seven or doubles, 7.128x to 35.64x on an
  exact total), and 1% of the bet (at least 1 coin) goes into the gamba pot. The dice tumble for a
  moment before the result shows; Roll again repeats the same bet and call
- `?dice [bet] [high|low|seven|doubles|=2…12]` (alias `?roll`): the same dice from a message,
  arguments in any order (`?dice =12 50`)
- `/balance`, `/daily`, `/collect`, `/bailout`: your coins and the ways to earn more:
  - `/daily`: 400 coins plus 75 per streak day (up to 925 from day 7), and 10% cashback on the
    previous UTC day's net gamba, coinflip and dice losses (up to 1,000)
  - `/collect`: 25 coins for every hour since the last collect, stacking up to 12 hours (300)
  - `/bailout`: under 10 coins, 200 plus 25 per day of a live daily streak, every 30 minutes
- `/stats [user]`: a player profile with spins, win rate, jackpots, biggest win, best odds, net
  profit, coinflip and dice totals, their last five coinflips and dice rolls, and daily streak
- `/leaderboard [category]`: the top 10 by `coins`, `biggest-win`, `jackpots`, `profit`, `spins`, `coinflip` or `dice`; only
  the person who ran it can use its category select and Previous/Next buttons
- chat rewards: a few coins for chatting, at most once a minute
- `/eco give|take`: moderators adjust coins (Manage Server)
- `/settings show|logs|autorole`: admins pick log channels and join roles (Manage Server)
- members who leave are hidden from boards and ranks, and purged after a 30 day grace period

## Gamba

Every spin costs a stake: `1`, `100`, `2.5k`, `all` or `half` (1 to 10,000 coins), or 1 coin when
you give no bet. There are no free spins. A spin pays a multiple of the stake. Payouts include the
stake:

| Result        | Payout |
| ------------- | ------ |
| yt pair       | 2x     |
| python pair   | 4x     |
| cpp pair      | 8x     |
| yt triple     | 10x    |
| python triple | 25x    |
| cpp triple    | 100x   |

On average a spin returns about 98.7% of the bet (a ~1% house edge), before the pot. Wins are
weighted toward the common pairs, so a balance lasts: about 36% of spins pay something, and most of
those double the stake. The cpp triple's main prize is the pot and the jackpot role.

Bets of 100 or less add nothing to the shared pot. Bets over 100 add 3% of the whole bet,
rounded down to whole coins. The pot starts at 10,000 coins and never drops below that seed.

A python triple also pays 5% of the pot above the seed, on top of its 25x payout. Pairs and yt
triples take nothing from the pot. A cpp triple wins the pot, up to 80x its bet (see below). Both pot prizes are full-sized
at bets of 500 or more and scale by `bet / 500` below that, rounded down to whole coins.

One win takes at most 80x its bet from the pot for a jackpot and 1x its bet for a python triple;
the rest stays in the pot. For example, a 500-coin jackpot takes up to 40,000 coins and a
10,000-coin one up to 800,000. This keeps every spin a loss on average however big the pot gets.
If a jackpot leaves the pot below the seed, it is topped back up.

`?gamba` replies to you with the reels (plus a follow-up on a win), with no buttons. Every `/gamba`
result card has a **Spin again** button (same bet).
Wagered cards also get **Double (N)**, shown only when twice the bet is at most 10,000 and at
most your balance after the spin. Only the player can use the buttons.

## Create the bot (once)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create an
   application.
2. **Bot** tab: reset/copy the token, and enable the **Message Content Intent** (required for
   `?` prefix commands).
3. Also enable the **Server Members Intent** (privileged). The bot always requests it, so without
   it the bot fails to log in (Discord rejects the connection) and exits. Enable it **before**
   merging or deploying to `main`: deploys are automatic and do not roll back.
4. **OAuth2 -> URL Generator**: scopes `bot`, permissions as needed, then open the URL to invite
   the bot to your server. Give it **Manage Roles** (for gamba jackpot roles and auto-roles) and
   keep its highest role above those roles.

## First-time server setup

Run these as someone with Manage Server:
- `/settings logs set type:<economy|mod> channel:<channel>`: where economy and moderation logs go
  (`/settings logs clear` stops a log). The bot needs View Channel and Send Messages in log
  channels. The economy log records admin give/take, jackpots and member events; big spins,
  rolls and flips do not get log entries.
- `/settings autorole add role:<role> target:<members|bots>`: roles given to new joiners or new
  bots (`target` defaults to members; `remove` to stop)
- `/settings show`: review the current settings

## Local development

Requires Node.js 24+ and [pnpm](https://pnpm.io).

```sh
pnpm install
cp .env.example .env   # then set DISCORD_TOKEN (and GUILD_ID for instant slash commands)
pnpm dev
```

`DATABASE_PATH` (default `./data/tincazz.db`) is the SQLite file; it is created and migrated on
startup. `GUILD_ID` is optional: when set, slash commands register to that server instantly,
otherwise they register globally, which can take up to an hour.

`.env` is gitignored. Never commit it. Before opening a PR, run the same checks CI does:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

See [AGENTS.md](AGENTS.md) for the full list of scripts, conventions and git rules.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request,
and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/cazzwastaken/tincazz/security/advisories/new),
not in public issues.

## Deploying to a VPS

Every push to `main` that passes CI (lint, typecheck, tests, build) builds a Docker image and
publishes it to `ghcr.io/cazzwastaken/tincazz` (see `.github/workflows/docker.yml`). The server only
needs Docker, `docker-compose.yml` and a `.env` file.

One-time setup on the VPS (after [installing Docker](https://docs.docker.com/engine/install/)):

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

### Automatic deploys

The `deploy` job in `docker.yml` runs after a successful publish on `main` and SSHes into the VPS to
pull the new image and restart the bot. It runs in the `production` GitHub environment, which holds
these secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (private key) and `VPS_KNOWN_HOSTS` (the output of
`ssh-keyscan -t ed25519 <host>`).

On the VPS, create a dedicated `deploy` user in the `docker` group with the compose project in
`~/tincazz`, and give CI a dedicated key restricted to one command in `~/.ssh/authorized_keys`:

```
command="cd ~/tincazz && docker compose pull && docker compose up -d && docker image prune -f",restrict ssh-ed25519 AAAA... tincazz-ci
```

Set the private key secret from the file so its formatting survives
(`gh secret set VPS_SSH_KEY --env production < <path-to-private-key>`). A leaked key can then do
nothing except redeploy. The job does not update `docker-compose.yml` or
`.env` on the server.

### Manual update

To update to the latest version by hand:

```sh
docker compose pull && docker compose up -d
```

`docker compose pull` only updates the image. When a release changes `docker-compose.yml`, fetch the
new file too (the same `curl` as in the setup above) before running `up -d`.

The container restarts automatically after crashes and reboots (`restart: unless-stopped`). It runs
as a non-root user with a read-only filesystem and no extra capabilities, and its logs are rotated
(3 files of 10 MB), so it will not fill the disk.

The SQLite database lives on the `tincazz-data` Docker volume, mounted at `/app/data` (the only
writable path in the container). To back it up:

```sh
docker compose exec bot node -e "require('better-sqlite3')('/app/data/tincazz.db').backup('/app/data/backup.db')"
docker compose cp bot:/app/data/backup.db .
```

If the bot restarts in a loop with `SqliteError: unable to open database file`
(`SQLITE_CANTOPEN`), the container has no writable `/app/data`. The usual cause is an outdated
`docker-compose.yml` without the `tincazz-data` volume: check that `docker compose config` lists it
under `volumes`, replace the file with the current one and run `docker compose up -d`. Also make sure
`DATABASE_PATH` in `.env` is unset or points inside `/app/data`.

To roll back, set the `image:` tag in `docker-compose.yml` to an earlier build (every image is also
tagged `sha-<commit>`, and `v*` git tags publish versioned images), then run
`docker compose up -d`. Switch back to `latest` to follow `main` again.

## License

Released under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only).

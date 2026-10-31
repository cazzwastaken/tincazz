# AGENTS.md

Guidance for AI coding agents and contributors working in this repository.

## Project

Tincazz is a Discord bot for managing the cazzwastaken community server. It is expected to grow
into a large, feature-rich bot, so structure and conventions matter more than speed.

## Stack

- TypeScript (strict), ESM, Node.js 24+
- [discord.js](https://discord.js.org) on top of the [Sapphire framework](https://www.sapphirejs.dev)
- [zod](https://zod.dev) for validating configuration
- pnpm, [Biome](https://biomejs.dev) (lint + format), [Vitest](https://vitest.dev)
- Docker + GitHub Actions (CI, image published to GHCR), Dependabot for dependency updates

## Commands

| Command            | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `pnpm dev`         | Run with reload (`tsx watch`), loads `.env`          |
| `pnpm build`       | Compile `src/` to `dist/`                            |
| `pnpm start`       | Run the compiled bot                                 |
| `pnpm lint`        | Biome lint + format check (`lint:fix` to apply)      |
| `pnpm typecheck`   | `tsc --noEmit` over `src/` and `test/`               |
| `pnpm test`        | Run Vitest                                           |
| `pnpm db:generate` | Generate a Drizzle migration from `src/db/schema.ts` |

Before considering any change done, `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
must pass. CI runs exactly these.

## Layout

```
src/
  index.ts        entry point: parse env, create client, log in, handle shutdown
  client.ts       builds the SapphireClient (intents, logger, mention policy, piece path)
  config/env.ts   zod schema for environment variables
  db/             SQLite schema (Drizzle) and `openDatabase`, exposed as `container.db`
  commands/       one file per command, grouped in folders by category
    admin/        `/settings` (log channels, join auto-roles and game channels; Manage Server)
    economy/      slash commands for coins (/balance, also `?bal` / `?balance`, /daily, /collect,
                  /bailout, /eco)
    general/      `?ping` / `/ping`, `?help` / `/help`
    misc/         games: `?gamba` / `/gamba`, `?coinflip` / `/coinflip` (aliases `?cf`, `?flip`),
                  `?dice` / `/dice` (alias `?roll`)
    stats/        slash commands for profiles and boards (/stats, /leaderboard)
  features/       plain feature logic, one folder per feature (not auto-loaded)
    animation/    shared frame playback: per-channel frame budget, per-user busy lock, display
                  adapters for slash, button and prefix
    coinflip/     `/coinflip` rules: rake, flips, `cf:*` custom IDs, the one transactional settle
                  module, the in-memory challenge registry (exactly-once and expiry), cards
                  (challenge results carry a single-use Rematch button) and flip frames
    dice/         `/dice` rules: 2d6 calls and payouts (tuned to a 99% return), the edge into the
                  pot, the single-transaction settle, `dc:*` custom IDs, the prefix parser, cards
                  and roll frames
    economy/      wallets and ledger; the only code that changes balances. Faucets: daily (with
                  cashback on yesterday's gambling losses), hourly collect, bailout, chat
    gamba/        spin logic, odds and payouts (tuned to a ~1% house edge), the pot, bet parsing,
                  result cards and the shared `spin()` flow used by commands and buttons (every
                  spin is a wager, default 1)
    help/         the help card, built from the economy and wager config so it cannot drift
    logs/         log channels: event types and cards, fire-and-forget `sendLog`, economy
                  events (admin adjustments, jackpots and member events)
    members/      departed-member tracking: hidden from boards and ranks, daily reconcile
                  against the guild and purge after a 30 day grace period
    presence/     the bot's rotating status (live pot, last jackpot, spins today), started from
                  the ready listener
    scheduler/    the hourly tick that runs periodic jobs (started from the ready listener)
    settings/     per-guild settings store: log channels, auto-roles, game channels (the games
                  work everywhere until some are listed; `gameChannelDenied` gates gamba, coinflip
                  and dice commands and buttons), their cards and role assignment
    stats/        read-only profile, recent plays and leaderboard queries, `lb:*` custom IDs and
                  cards
    ui/           shared Components V2 card helpers
  interaction-handlers/  one file per component handler (gamba, coinflip and dice buttons,
                  leaderboard paging and category select)
  listeners/      one file per Discord/Sapphire event listener (member join, leave and
                  screening, channel and role delete cleanup, chat rewards, ready, and a
                  generic ephemeral reply when a command or handler throws)
drizzle/          generated SQL migrations, committed and shipped in the image
test/             Vitest tests
.github/          CI, image publishing, Dependabot, issue forms, PR template and CODEOWNERS
```

Sapphire loads every file under `commands/`, `listeners/` and `interaction-handlers/` automatically
(and would do the same for `preconditions/` and `arguments/` if added). Do not register pieces by
hand. Pieces export a class extending `Command`, `Listener`, etc. Button state lives in the custom
ID (see `features/gamba/custom-ids.ts`), so handlers must ignore IDs they cannot decode.

## Database

- SQLite through better-sqlite3 and Drizzle. Migrations from `drizzle/` are applied on startup.
- Change `src/db/schema.ts`, then run `pnpm db:generate --name <change>` and commit both. CI fails
  when the schema and the migrations drift apart.
- Coin amounts and timestamps (epoch milliseconds, UTC) are integers.
- Tests use `openDatabase(':memory:')` and assign `container.db`.
- `better-sqlite3` must stay `true` in `allowBuilds` in `pnpm-workspace.yaml`, or its native binary
  is never built.

## Discord and Sapphire notes

- **Prefix commands need `loadMessageCommandListeners: true`** in `src/client.ts`. Without it the
  bot receives messages but never runs a command, and nothing is logged. Do not remove it. A test
  guards this.
- **Mentions are suppressed by default** (`allowedMentions: { parse: [], repliedUser: false }`).
  A command that must ping someone has to opt in explicitly for that message.
- **Slash commands register to `GUILD_ID` when it is set**, otherwise globally (global updates can
  take up to an hour). Each command implements `registerApplicationCommands` and `chatInputRun`.
- **Gamba jackpots assign a role** (`?gamba`, `/gamba` and the Spin again/Double buttons), so the
  bot needs the **Manage Roles** permission and its highest role must sit above the jackpot role.
- **Server Members is a privileged intent** (`GuildMembers`): enable it in the Developer Portal
  (Bot -> Server Members Intent). It drives joins, leaves and member fetches. `src/client.ts`
  always requests it, so with the toggle off Discord closes the gateway (4014, disallowed
  intents), `client.login` rejects and the bot exits at startup: it fails to log in.
  Known limitation: a member who joined before a restart and passes Rules Screening after it may
  not get auto-roles, because the guild-member partial's old `pending` is unknown
  (`src/listeners/member-screening.ts`).
- **Auto-roles** (`/settings autorole`) need **Manage Roles**, with the bot's highest role above
  every auto-role.
- Prefix commands rely on the privileged **Message Content** intent. Prefer slash commands
  (`chatInputRun`) for new user-facing features, and add a gateway intent only when a feature needs
  it.

## Conventions

- `CONTRIBUTING.md` is the human-facing summary of these rules. When a convention here changes,
  update it there too.
- Use `.js` extensions in relative imports (NodeNext ESM), and `import type` for type-only imports.
- Read configuration only through `parseEnv` in `src/config/env.ts`. Add new variables to the zod
  schema **and** to `.env.example` in the same commit. Do not read `process.env` elsewhere.
- Feature logic goes in `src/features/<name>/` with an `index.ts` public surface; commands and
  listeners stay thin and call into it. Game/feature config (emojis, odds, role IDs) lives in the
  feature folder.
- Gamba payouts (`payoutBps` in `src/features/gamba/config.ts`) target a ~99% return before the
  pot, a ~1% house edge. `test/gamba-evaluate.test.ts` enumerates every draw and fails outside
  98.5–99.5%: keep it in range when changing payouts, odds or reels. It also checks that a spin
  loses on average at every bet however big the pot is, through `pot.maxWinPerBet` in
  `config.ts`: adding a pot-paying tier or raising a cap must keep (jackpot cap + sum of the other
  caps weighted by their odds) under the house edge.
- Keep gamba low-volatility. Players went broke within a daily's worth of spins when a third of the
  return sat in rare triples, so most of it now sits in the common pairs (yt pair 2x), and the
  jackpot's real prize is the pot and the role. Do not move return back into rare tiers to make a
  headline multiplier bigger.
- Dice payouts (`returnBps` in `src/features/dice/config.ts`) return 99%;
  `test/dice-evaluate.test.ts` fails outside 98.5–99.5%.
- Coin faucets (economy `config.ts`: daily, cashback, collect, bailout, chat) are sized so players
  can keep playing at small bets. A new faucet gets its own ledger reason, a claim function in
  `src/features/economy/` that writes in one transaction, an op in `test/fuzz-economy.test.ts` and a
  cooldown or rate check in `expectCooldownsHeld`.
- A new way to move coins with user impact should consider an economy log event. Logging is
  fire-and-forget after the transaction commits: it must never block or fail the action.
- Log through `this.container.logger` / `client.logger`, not `console`.
- Keep logic that can be tested without Discord in plain functions and cover it with Vitest.
- Anything that parses user input (bet strings, custom IDs, option strings) also gets
  [fast-check](https://fast-check.dev) property tests next to the example tests (see
  `test/fuzz-*.test.ts`). Code that moves coins is covered by the model-based run in
  `test/fuzz-economy.test.ts`: extend it when adding a new way to earn or spend.
- New behavior and bug fixes come with tests in `test/`. To test a command end to end, build the
  client with `createClient`, load the stores, emit `Events.MessageCreate` with a stubbed message
  and assert on the replies (see `test/ping.test.ts`). No network or real token is needed.
- Add dependencies with `pnpm add` (no hand-edited versions). Keep `pnpm-lock.yaml` committed.

## CI/CD

- `.github/workflows/ci.yml` runs lint, typecheck, tests, build and a migration drift check
  (`pnpm db:generate` must leave `drizzle/` unchanged). It runs on pull requests (which
  also build the Docker image without pushing) and is reused by the publish workflow.
- `.github/workflows/docker.yml` runs on pushes to `main` and `v*` tags. It calls CI first and
  publishes the image to `ghcr.io/cazzwastaken/tincazz` only if CI passes.
- The `deploy` job in `docker.yml` runs after `publish`, only for pushes to `main` (not tags or
  PRs), in the `production` GitHub environment. It SSHes into the VPS, which pulls the new image
  and restarts the bot. See "Deploys" below.
- Dependabot opens weekly PRs for npm, GitHub Actions and the Docker base image, using
  conventional prefixes (`chore(deps)`, `ci(deps)`, `build(deps)`).
- Node major versions are ignored by Dependabot and upgraded by hand, only to LTS releases (update
  `.node-version`, `package.json` engines and the Dockerfile together). Newer images can drop tools
  the Dockerfile relies on: `node:25` no longer ships corepack, so `corepack enable` fails there.
- Do not merge a PR with failing checks.

## Deploys

- Secrets live in the `production` GitHub environment, never in the repo: `VPS_HOST`, `VPS_USER`,
  `VPS_SSH_KEY` (private key), `VPS_KNOWN_HOSTS` (`ssh-keyscan -t ed25519` output, the first field
  must match `VPS_HOST`). Do not add real hosts, usernames, IPs or keys to docs, workflows or logs.
- The server key is pinned in `authorized_keys` to a forced command (`docker compose pull`, `up -d`,
  `image prune`) with `restrict`. The command passed to `ssh` in the workflow is therefore ignored, and
  CI cannot run extra steps (such as a health check) over that key. To add one, extend the
  server-side command instead, not the workflow.
- CI does not update `docker-compose.yml` or `.env` on the server. Changes to either are a manual
  step on the VPS. Deploys do not roll back on their own.
- Enable the **Server Members Intent** in the Developer Portal **before** merging or deploying to
  `main`. Deploys are automatic and the bot cannot log in without it.
- Set `VPS_SSH_KEY` from the key file so formatting survives, never by pasting into the web UI:
  `gh secret set VPS_SSH_KEY --env production < <path-to-private-key>`.
- Troubleshooting a failed deploy job (`gh run view <id> --log-failed`):
  - `error in libcrypto` followed by `Permission denied (publickey,password)`: the
    `VPS_SSH_KEY` secret is malformed. Re-set it as above.
  - `Host key verification failed`: `VPS_KNOWN_HOSTS` is stale or does not match `VPS_HOST`.
  - `Permission denied (publickey)` with a valid key: check ownership and modes of the deploy
    user's home, `~/.ssh` (700) and `authorized_keys` (600) on the server.
- Secret values never appear in the logs, but never `echo` them or enable shell tracing in the job.

## Git rules

- Make **all changes in logical commits**: one coherent change per commit, never a single dump of
  unrelated work. Each commit should leave `lint`, `typecheck`, `test` and `build` passing.
- Follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`.
  - Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
    `revert`.
  - Summary is imperative, lower case, no trailing period, about 72 characters or fewer
    (`feat(moderation): add timeout command`).
  - Use the body to explain _why_ when it is not obvious. Mark breaking changes with `!` and a
    `BREAKING CHANGE:` footer.
- Work on a branch and open a pull request for anything non-trivial; do not force-push `main`.
- Do not commit generated output (`dist/`, `node_modules/`) or anything listed in `.gitignore`.

## Secrets and security

This repository is **public**. Never commit tokens, keys, `.env` files, server/user IDs that are
meant to stay private, or logs containing them.
- Real values live only in `.env` (gitignored) locally and in the `.env` file on the server.
  `.env.example` documents the variables with empty or safe placeholder values.
- The Docker image contains no secrets; they are injected at runtime through `env_file`.
- Never log the token or print the full environment.
- If a token is ever committed or pasted anywhere public, treat it as compromised: reset it in the
  Discord Developer Portal immediately (removing it from git history is not enough).
- Request only the gateway intents the bot actually needs. `MessageContent` is privileged.

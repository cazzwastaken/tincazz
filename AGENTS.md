# AGENTS.md

Guidance for AI coding agents and contributors working in this repository.

## Project

Tincazz is a Discord bot for managing the cazzwastaken community server. It is expected to grow
into a large, feature-rich bot, so structure and conventions matter more than speed.

Stack: TypeScript (strict), ESM, Node.js 24+, [discord.js](https://discord.js.org) on the
[Sapphire framework](https://www.sapphirejs.dev), SQLite via Drizzle, [zod](https://zod.dev),
sharp for images, pnpm, [Biome](https://biomejs.dev), [Vitest](https://vitest.dev) with
[fast-check](https://fast-check.dev). Docker + GitHub Actions (CI, image to GHCR), Dependabot.

## Commands

| Command            | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `pnpm dev`         | Run with reload (`tsx watch`), loads `.env`                     |
| `pnpm build`       | Compile `src/` to `dist/`                                       |
| `pnpm start`       | Run the compiled bot                                            |
| `pnpm lint`        | Biome lint + format check, TS and Markdown (`lint:fix` applies) |
| `pnpm typecheck`   | `tsc --noEmit` over `src/` and `test/`                          |
| `pnpm test`        | Run Vitest                                                      |
| `pnpm db:generate` | Generate a Drizzle migration from `src/db/schema.ts`            |

## Where to change things

| Task                      | Touch                                                                                                                                                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a slash command       | `src/commands/<category>/<name>.ts` (`registerApplicationCommands` + `chatInputRun`), logic in `src/features/<name>/`, a test in `test/`                                                                                                                         |
| Add a prefix alias        | `aliases` in the command's constructor options                                                                                                                                                                                                                   |
| Add a game                | `src/features/<game>/` (`config.ts`, rules, `custom-ids.ts`, cards, one transactional settle), a command, button handler in `src/interaction-handlers/`, game-channel gate (`gameChannelDenied`), `test/<game>-evaluate.test.ts`, `/help` topic, `docs/games.md` |
| Change gamba or dice odds | `src/features/gamba/config.ts` / `src/features/dice/config.ts`, then the `*-evaluate` tests, `docs/games.md`, the help cards                                                                                                                                     |
| Add a coin faucet         | `src/features/economy/` (config, claim function, ledger reason), `test/fuzz-economy.test.ts` (op and `expectCooldownsHeld`), help `coins` page                                                                                                                   |
| Add an image source or op | `src/features/imaging/` (`source.ts`, `render.ts`, `frames.ts`...), keep `urls.ts` allowlist intact, `test/imaging-*.test.ts` and `fuzz-imaging-*.test.ts`                                                                                                       |
| Add a help topic          | `src/features/help/topics.ts` (page, `topicInfo`, aliases), page in `cards.ts`, `test/help.test.ts`                                                                                                                                                              |
| Add an env variable       | zod schema in `src/config/env.ts`, `.env.example`, `test/env.test.ts`                                                                                                                                                                                            |
| Add a DB column or table  | `src/db/schema.ts`, then `pnpm db:generate --name <change>`, commit `drizzle/` with it                                                                                                                                                                           |
| Add a log event           | event type in `src/features/logs/events.ts`, card in `cards.ts`, emit through `sendLog` after the transaction                                                                                                                                                    |
| Add a listener or handler | one file in `src/listeners/` or `src/interaction-handlers/` (auto-loaded)                                                                                                                                                                                        |

## Before you finish

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all pass. CI runs exactly these, plus a
   check that `pnpm db:generate` leaves `drizzle/` unchanged.
2. New behavior and bug fixes have tests in `test/`; anything parsing user input has fast-check
   tests; anything moving coins is in `test/fuzz-economy.test.ts`.
3. Docs match the change: the layout below, the README feature list, the `/help` topic,
   `docs/games.md` for rule changes, `.env.example` for env vars, `CONTRIBUTING.md` when a
   convention changes.
4. Commits are logical, conventional and each pass the checks (see "Git rules").

## Layout

```
src/
  index.ts        entry point: parse env, create client, log in, handle shutdown
  client.ts       builds the SapphireClient (intents, logger, mention policy, piece path)
  config/env.ts   zod schema for environment variables
  db/             SQLite schema (Drizzle) and `openDatabase`, exposed as `container.db`
  commands/       one file per command, grouped in folders by category
    admin/        `/settings` (log channels, join auto-roles, the gamba jackpot role, game channels and the honeypot channel;
                  Manage Server); `/giveaway create` (server-level and channel Manage Messages)
                  and `/giveaway cancel` (same staff checks), plus `/giveaway list`
    economy/      `/balance` (also `?bal` / `?balance`), `/daily`, `/collect`, `/bailout`, `/eco`
    general/      `?ping` / `/ping`, `?help` / `/help` (paged card, `topic` option / argument)
    image/        `?bubble` / `/bubble` (also the "Bubble message" message context menu) and
                  `?caption` / `/caption` (also the "Caption message" context menu, which asks for
                  the text in a modal); `?gif` / `/gif` converts an image to a downloadable GIF.
                  All image processing is in `features/imaging/`
    misc/         games: `?gamba` / `/gamba`, `?coinflip` / `/coinflip` (aliases `?cf`, `?flip`),
                  `?dice` / `/dice` (alias `?roll`)
    stats/        `/stats`, `/leaderboard`
  features/       plain feature logic, one folder per feature (not auto-loaded)
    animation/    shared frame playback: per-channel frame budget, per-user busy lock, display
                  adapters for slash, button and prefix
    coinflip/     rake, flips, `cf:*` custom IDs, transactional settlement, and challenge cards
                  persisted until closed so their original expiry survives restarts; result
                  cards have a single-use Rematch button
    dice/         2d6 calls and payouts (tuned to a 99% return), the edge into the pot, the
                  single-transaction settle, `dc:*` custom IDs, the prefix parser, cards, frames
    economy/      wallets and ledger; the only code that changes balances. Faucets: daily (with
                  cashback on yesterday's gambling losses), hourly collect, bailout, chat
    gamba/        spin logic, odds and payouts (tuned to a ~1% house edge), the pot, bet parsing,
                  result cards and the shared `spin()` flow used by commands and buttons (every
                  spin is a wager, default 1)
    giveaways/    guild-scoped reaction giveaways, live entry counts, durable draw and result edits
    help/         the paged help card (home, games, images, coins, gamba, coinflip and dice, giveaways), the
                  topic menu and aliases, built from the economy and wager config so it cannot
                  drift; `hp:*` custom IDs
    honeypot/     per-guild honeypot channel: the softban trigger with its in-memory guard, the
                  warning card sync (debounced, re-posted when deleted), the store and copy
    imaging/      `/bubble`, `/caption` and `/gif` logic: the URL allowlist (`urls.ts`), the capped
                  downloader with redirect checks, source picking (attachment, link, reply, message
                  link, avatar, sticker), message-link parsing, decode, bubble and caption
                  rendering with sharp, the Discord-style message screenshot (`message.ts`), GIF
                  encoding with a size ladder, the job queue (timeout, concurrency, per-user lock),
                  prefix argument parsing, text sanitising, the `cap:*` caption modal custom IDs
                  and the Discord adapters
    logs/         log channels: event types and cards, fire-and-forget `sendLog`, economy events
                  (admin adjustments, jackpots and member events)
    members/      departed-member tracking: hidden from boards and ranks, daily reconcile against
                  the guild and purge after a 30 day grace period
    presence/     the bot's rotating status (live pot, last jackpot, spins today), started from
                  the ready listener
    scheduler/    the hourly tick that runs periodic jobs (started from the ready listener)
    settings/     per-guild settings store: log channels, auto-roles, game channels (unrestricted
                  by default; once restricted, an empty list pauses games until an admin allows
                  a channel or resets the restriction; `gameChannelDenied` gates game commands
                  and buttons), their cards and role assignment
    stats/        read-only profile, recent plays and leaderboard queries, `lb:*` custom IDs, cards
    ui/           shared Components V2 card helpers
  interaction-handlers/  one file per component or modal handler (gamba, coinflip, dice and help
                  buttons and menu, leaderboard paging and category select, the caption modal)
  listeners/      one file per Discord/Sapphire event listener (member join, leave and screening,
                  channel and role delete cleanup, chat rewards, the honeypot trigger and card re-post
                  after a single or bulk delete (`honeypot.ts`, `honeypot-card-delete.ts`,
                  `honeypot-card-bulk-delete.ts`), ready, a generic ephemeral reply
                  when a command or handler throws, giveaway reaction refreshes and deletion handling,
                  and replies when a precondition denies a command, such as a cooldown)
assets/fonts/     the OFL fonts used for image captions, each with its licence file
drizzle/          generated SQL migrations, committed and shipped in the image
test/             Vitest tests (`test/support/` has shared helpers)
docs/             `games.md` (player-facing rules), `giveaways.md` and `deploy.md` (operator guide)
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
  take up to an hour). Each command implements `registerApplicationCommands` and `chatInputRun`
  (plus `contextMenuRun` for a context menu command).
- **Intents** (`src/client.ts`): Guilds, GuildMessages, GuildMessageReactions, MessageContent and GuildMembers. Request
  only what a feature needs. `MessageContent` (prefix commands) and `GuildMembers` (joins, leaves,
  member fetches) are privileged and must be enabled in the Developer Portal (Bot tab). With
  Server Members off, Discord closes the gateway (4014, disallowed intents) and the bot exits at
  startup. Prefer slash commands for new user-facing features.
- **Manage Roles** is required for gamba jackpot roles (`?gamba`, `/gamba` and the Spin
  again/Double buttons) and for `/settings autorole`; the bot's highest role must sit above every
  role it assigns.
- **Ban Members** is required for the honeypot (`/settings honeypot`), together with View
  Channel, Send Messages and Manage Messages in the honeypot channel. It softbans with `deleteMessageSeconds: 3600` and cannot ban
  members whose highest role is at or above the bot's.
- **`Partials.Message`** (`src/client.ts`) lets `messageDelete` and `messageDeleteBulk` include an
  uncached honeypot card so it can be re-posted. Do not remove it.
- Pending screening joins persist until role assignment or departure. The hourly job recovers completions missed while offline.

## Conventions

- `CONTRIBUTING.md` is the human-facing summary of these rules. When a convention here changes,
  update it there too.
- Use `.js` extensions in relative imports (NodeNext ESM), and `import type` for type-only imports.
- Read configuration only through `parseEnv` in `src/config/env.ts`. Add new variables to the zod
  schema **and** to `.env.example` in the same commit. Do not read `process.env` elsewhere.
- Feature logic goes in `src/features/<name>/` with an `index.ts` public surface; commands and
  listeners stay thin and call into it. Game/feature config (emojis, odds, role IDs) lives in the
  feature folder.
- Log through `this.container.logger` / `client.logger`, not `console`.
- Keep logic that can be tested without Discord in plain functions and cover it with Vitest.
- Add dependencies with `pnpm add` (no hand-edited versions). Keep `pnpm-lock.yaml` committed.

### Economy and games

Rule changes also update `docs/games.md` and the `/help` cards (built from config, but check the
prose).

- Gamba payouts (`payoutBps` in `src/features/gamba/config.ts`) target a ~99% return before the
  pot, a ~1% house edge. `test/gamba-evaluate.test.ts` enumerates every draw and fails outside
  98.5-99.5%: keep it in range when changing payouts, odds or reels. It also checks that a spin
  loses on average at every bet however big the pot is, through `pot.maxWinPerBet` in `config.ts`:
  adding a pot-paying tier or raising a cap must keep (jackpot cap + sum of the other caps weighted
  by their odds) under the house edge.
- Keep gamba low-volatility. Players went broke within a daily's worth of spins when a third of the
  return sat in rare triples, so most of it now sits in the common pairs (yt pair 2x), and the
  jackpot's real prize is the pot and the role. Do not move return back into rare tiers to make a
  headline multiplier bigger.
- Dice payouts (`returnBps` in `src/features/dice/config.ts`) return 99%;
  `test/dice-evaluate.test.ts` fails outside 98.5-99.5%.
- Coin faucets (economy `config.ts`: daily, cashback, collect, bailout, chat) are sized so players
  can keep playing at small bets. A new faucet gets its own ledger reason, a claim function in
  `src/features/economy/` that writes in one transaction, an op in `test/fuzz-economy.test.ts` and a
  cooldown or rate check in `expectCooldownsHeld`.
- A new way to move coins with user impact should consider an economy log event. Logging is
  fire-and-forget after the transaction commits: it must never block or fail the action.

### Images

- Image commands fetch sources only from the allowlist in `src/features/imaging/urls.ts` (Discord,
  Tenor and Giphy hosts, https only, every redirect hop checked). Never widen it to arbitrary
  hosts: that is an SSRF hole.
- Fonts in `assets/fonts/` must be OFL (or similarly licensed) and committed with their licence
  file. The runtime image needs `fontconfig` and `assets/` (see the Dockerfile) to render captions
  and message screenshots.

### Tests

- New behavior and bug fixes come with tests in `test/`. To test a command end to end, build the
  client with `createClient`, load the stores, emit `Events.MessageCreate` with a stubbed message
  and assert on the replies (see `test/ping.test.ts`). No network or real token is needed.
- Anything that parses user input (bet strings, custom IDs, option strings) also gets fast-check
  property tests next to the example tests (see `test/fuzz-*.test.ts`). Code that moves coins is
  covered by the model-based run in `test/fuzz-economy.test.ts`: extend it when adding a new way to
  earn or spend.

## CI/CD and deploys

- `.github/workflows/ci.yml` runs lint, typecheck, tests, build and the migration drift check. It
  runs on pull requests (which also build the Docker image without pushing) and is reused by the
  publish workflow.
- `.github/workflows/docker.yml` runs on pushes to `main` and `v*` tags: CI first, then it
  publishes `ghcr.io/cazzwastaken/tincazz`. For pushes to `main` a `deploy` job (in the
  `production` GitHub environment) SSHes into the VPS to pull the image and restart the bot.
- Do not merge a PR with failing checks. Deploys are automatic and do not roll back.
- Enable the **Server Members Intent** in the Developer Portal **before** merging or deploying to
  `main`; the bot cannot log in without it.
- CI does not update `docker-compose.yml` or `.env` on the server: those are manual steps.
- The deploy key is pinned to a forced command, so CI cannot run extra steps over it. Secrets live
  in the `production` environment, never in the repo. Set `VPS_SSH_KEY` from the key file
  (`gh secret set VPS_SSH_KEY --env production < <path>`), never `echo` secrets or enable shell
  tracing in the job. Setup, troubleshooting a failed deploy job, backups and rollback are in
  [docs/deploy.md](docs/deploy.md).
- Dependabot opens weekly PRs for npm, GitHub Actions and the Docker base image, using
  conventional prefixes (`chore(deps)`, `ci(deps)`, `build(deps)`).
- Node major versions are ignored by Dependabot and upgraded by hand, only to LTS releases (update
  `.node-version`, `package.json` engines and the Dockerfile together). Newer images can drop tools
  the Dockerfile relies on: `node:25` no longer ships corepack, so `corepack enable` fails there.

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

This repository is **public**. Never commit tokens, keys, `.env` files, real hosts, usernames or IPs,
server/user IDs that are meant to stay private, or logs containing them.

- Real values live only in `.env` (gitignored) locally and in the `.env` file on the server.
  `.env.example` documents the variables with empty or safe placeholder values.
- The Docker image contains no secrets; they are injected at runtime through `env_file`.
- Never log the token or print the full environment.
- If a token is ever committed or pasted anywhere public, treat it as compromised: reset it in the
  Discord Developer Portal immediately (removing it from git history is not enough).

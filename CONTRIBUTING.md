# Contributing to Tincazz

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome. This guide covers
how to get set up and what a pull request needs to be merged. [AGENTS.md](AGENTS.md) holds the
full conventions (layout, a "where to change things" table, database, Discord quirks, economy rules)
and applies to humans as much as to AI agents. Game rules for players are in
[docs/games.md](docs/games.md), and the operator guide is [docs/deploy.md](docs/deploy.md).

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs**: search the [issues](https://github.com/cazzwastaken/tincazz/issues) first, then open
  one with the bug report form.
- **Small fixes** (typos, docs, an obvious bug): open a pull request directly.
- **New features or larger changes**: open an issue first so we can agree on the design before you
  spend time on it. This matters most for anything touching the economy or gamba odds, which are
  tuned on purpose (see "Economy and gamba" below).
- **Security issues**: do not open a public issue. Report them privately through
  [GitHub's private vulnerability reporting](https://github.com/cazzwastaken/tincazz/security/advisories/new).

Issues labelled `good first issue` or `help wanted` are good places to start.

## Setup

You need Node.js 24+ (see `.node-version`), [pnpm](https://pnpm.io) and a Discord bot of your own
to test with. Do not test against the production bot.

1. Fork the repository and clone your fork.
2. Create a test application and bot as described in
   [Add it to your server](README.md#add-it-to-your-server), and invite it to a private test server.
3. Install and run:

   ```sh
   pnpm install
   cp .env.example .env   # set DISCORD_TOKEN, and GUILD_ID to your test server
   pnpm dev
   ```

Setting `GUILD_ID` makes slash commands register to your test server instantly instead of globally.
The SQLite database is created under `./data/` on first start.

## Making a change

1. Branch off `main` with a descriptive name: `feat/<thing>`, `fix/<thing>`, `docs/<thing>`.
2. Put feature logic in `src/features/<name>/` and keep commands, listeners and interaction handlers
   thin. Sapphire loads pieces automatically, so never register them by hand.
3. Prefer slash commands for new user-facing features.
   Write erasable TypeScript only (`erasableSyntaxOnly`, enforced by `pnpm typecheck`): no
   parameter properties, `enum` or `namespace`. The built bot runs compiled JavaScript and
   `pnpm dev` uses `tsx`, but the tests load pieces with Node's native type stripping, which
   rejects that syntax.
4. Add or update tests in `test/` (see "Tests" below).
5. If you change `src/db/schema.ts`, run `pnpm db:generate --name <change>` and commit the generated
   migration in `drizzle/` with it.
6. If you add an environment variable, add it to the zod schema in `src/config/env.ts` **and** to
   `.env.example` in the same commit. Read config only through `parseEnv`.
7. Games run through the shared animation flow: `runAnimatedGame` (busy lock, settle, error text,
   show) with a `GameSurface` for slash and prefix commands, and a single transactional settle in
   the feature that uses `settleStake` (bet, then payouts) from `src/features/economy/`. Do not
   hand-roll the bet and payout ledger steps.
8. Guild specifics (log channels, auto-roles, the jackpot role, game channels, the Hall of Fame
   channel and its exemptions) are per-guild
   settings in `src/features/settings/`, set by staff with `/settings`. Never hard-code role,
   channel or server IDs in the code.
9. Keep the docs in step: the README feature list and the `/help` cards for user-visible behavior,
   [docs/games.md](docs/games.md) for rule or payout changes, and AGENTS.md (layout, conventions)
   plus this file when a convention changes.

## Checks

CI runs exactly this, and a pull request cannot be merged until it passes:

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm lint:fix` applies Biome's formatting and safe fixes (Markdown included). CI also fails when `drizzle/` and the
schema drift apart, and builds the Docker image for every pull request.

## Tests

- Every bug fix and new behavior comes with a test. A bug fix should include a test that fails
  without the fix.
- Keep logic testable without Discord: plain functions in `src/features/`, covered by
  [Vitest](https://vitest.dev).
- Anything that parses user input (bets, custom IDs, option strings) also gets
  [fast-check](https://fast-check.dev) property tests (see `test/fuzz-*.test.ts`).
- Anything that moves coins must be covered by the model-based run in `test/fuzz-economy.test.ts`.
- To test a command end to end, build the client with `createClient`, load the stores and emit an
  event with a stubbed message or interaction (see `test/ping.test.ts`). Tests use
  `openDatabase(':memory:')` and never need a token or network access.

## Economy and gamba

The economy is balanced deliberately. Changes here get extra review:

- Gamba targets a ~1% house edge. `test/gamba-evaluate.test.ts` fails if the return leaves
  98.5–99.5%. Pot prizes are capped per bet (`pot.maxWinPerBet`) so a huge pot never makes a
  spin profitable on average; the same test guards it.
- Gamba stays low-volatility: most of the return sits in the common pairs. Do not move it into rare
  tiers to make a headline multiplier bigger.
- Dice payouts (`returnBps` in `src/features/dice/config.ts`) return 99%.
  `test/dice-evaluate.test.ts` fails if the return leaves 98.5–99.5%.
- A new coin faucet needs its own ledger reason, a claim function in `src/features/economy/` that
  writes in one transaction, and coverage in `test/fuzz-economy.test.ts`.
- Image commands fetch sources only from the allowlist in `src/features/imaging/urls.ts`; never
  widen it to arbitrary hosts (SSRF).
- Add fonts to `assets/fonts/` only if they are OFL (or similarly licensed), with their licence
  file. The runtime image needs `fontconfig` and `assets/` to render captions and message
  screenshots.

Explain the reasoning (and the numbers) in the pull request.

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org):

```
type(scope): imperative summary in lower case
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  `revert`.
- Keep the summary around 72 characters or fewer, with no trailing period, e.g.
  `feat(moderation): add timeout command`.
- One logical change per commit, and every commit should pass the checks on its own. Use the body to
  explain _why_ when it is not obvious.
- Mark breaking changes with `!` and a `BREAKING CHANGE:` footer.

## Pull requests

- Fill in the pull request template, link the issue it closes (`Closes #123`) and keep the PR
  focused on one thing.
- Include screenshots of new or changed cards and messages.
- Mention any manual step a deploy needs: a new intent or permission, a `.env` variable or a
  `docker-compose.yml` change. Merges to `main` deploy automatically, so these must be done first
  (see [docs/deploy.md](docs/deploy.md)).
- A maintainer reviews every PR. Address feedback with new commits; force-pushing your own branch is
  fine, force-pushing `main` never is.

## Secrets

This repository is public. Never commit tokens, `.env` files, private server or user IDs, or logs
that contain them. If you leak a bot token, reset it in the Discord Developer Portal right away:
removing it from git history is not enough.

## License

By contributing, you agree that your contributions are licensed under the
[GNU General Public License v3.0](LICENSE) (GPL-3.0-only), the same license as the project.

# Tincazz

A Discord bot for the cazzwastaken community: games, coins, image tricks and server tools.

[![CI](https://github.com/cazzwastaken/tincazz/actions/workflows/ci.yml/badge.svg)](https://github.com/cazzwastaken/tincazz/actions/workflows/ci.yml)
[![Publish image](https://github.com/cazzwastaken/tincazz/actions/workflows/docker.yml/badge.svg)](https://github.com/cazzwastaken/tincazz/actions/workflows/docker.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)
![Node.js 24+](https://img.shields.io/badge/node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-5865F2?logo=discord&logoColor=white)
![Sapphire](https://img.shields.io/badge/Sapphire-framework-2f6fd1)

## What it does

Type `/help` (or `?help`) in Discord for a paged guide with the live numbers.

**Games** (rules and payouts in [docs/games.md](docs/games.md))

- `/gamba`: slot-style spins with a progressive pot and a jackpot role
- `/coinflip`: flip against the bot, challenge a member or open a flip anyone can take
- `/dice`: call two dice (drawn as pictures) for high, low, seven, doubles or an exact total, then Roll again, Double or Change call

**Images**

- `/bubble`: put a speech bubble on an image, GIF, avatar or a whole message (reply to it, paste
  its link, or right-click > Apps > Bubble message)
- `/caption`: add a white caption bar above an image, GIF, avatar or a whole message (reply to it,
  paste its link, or right-click > Apps > Caption message)
- `/gif` or `?gif`: convert an uploaded or linked image to a downloadable GIF. You can also
  reply to an image with `?gif`.

**Economy**

- `/balance`, `/daily`, `/collect`, `/bailout`: earn and check your coins, plus a little for chatting
- `/coins history`: privately see your latest 10 coin changes in this server
- `/stats` and `/leaderboard`: profiles and top-10 boards
- `/eco`: moderators give or take coins

**Server tools**

- Staff can host timed reaction giveaways with `/giveaway create`. Cancel a pending draw with `/giveaway cancel`. Use `/giveaway list` to find draws in channels you can read. See [giveaways](docs/giveaways.md).
- `/poll` (or `?poll`): ask a question, members vote with reactions and a live bar chart shows the result. Yes/no or up to 9 options, optional anonymity and a timer up to 7 days. See [polls](docs/polls.md).
- Hall of Fame: when enough different people react to a message (5 by default), Tincazz posts it in
  a channel of your choice as a card with the author, the text, pictures (uploaded ones are copied, linked ones are shown through Discord's proxy) and a link back,
  with an icon that grows with the count. Messages from bots, apps and webhooks (including this bot's
  own polls, giveaways and cards) are never inducted, and bot reactions never count. Staff set it up
  with `/settings halloffame`. See [Hall of Fame](docs/halloffame.md).
- `/settings`: log channels, join roles, the jackpot role, which channels the games may be played in, and the Hall of Fame
- Honeypot channel: `/settings honeypot set` catches compromised accounts spamming every channel. The bot attempts a DM embed before softbanning and wiping the last hour of messages server-wide. Staff (Manage Messages or Administrator) and the server owner get an embed explaining why they weren't kicked and a 🍯 reaction if Discord allows it. Bots are ignored.
- Most commands also work with the `?` prefix, such as `?gamba 100` or `?caption hello`

## Add it to your server

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. On the **Bot** tab, copy the token and enable the **Message Content** and **Server Members**
   privileged intents. The bot cannot log in without Server Members.
3. Invite it with the `bot` and `applications.commands` scopes and the **Manage Roles**, **Ban Members** and **Manage Messages** permissions.
   Keep its highest role above the jackpot and auto-roles.
4. As someone with Manage Server, run `/settings show`, then `/settings logs set` and
   `/settings autorole add` to taste, `/settings jackpot set` to choose the gamba jackpot role and
   `/settings halloffame set` to pick the Hall of Fame channel (the bot needs View Channel, Send
   Messages, Attach Files and Read Message History there).

## Run it yourself

Needs Node.js 24+ and [pnpm](https://pnpm.io).

```sh
pnpm install
cp .env.example .env   # set DISCORD_TOKEN (and GUILD_ID for instant slash commands)
pnpm dev
```

For Docker, a VPS and automatic deploys, see [docs/deploy.md](docs/deploy.md).

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request,
and follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately through
[GitHub's private vulnerability reporting](https://github.com/cazzwastaken/tincazz/security/advisories/new),
not in public issues.

## License

Released under the [GNU General Public License v3.0](LICENSE) (GPL-3.0-only).

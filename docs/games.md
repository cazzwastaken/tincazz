# Game rules

Player-facing rules for the games. The `/help` command in Discord always shows the live numbers
(it is built from the same config as the games), so trust it if this page ever disagrees.

Everyone starts with 1,000 coins. Earn more with `/daily`, `/collect`, `/bailout` and by chatting;
see `/help topic:coins`. Games are available in every channel by default. Server admins can limit
them to certain channels with `/settings games allow`; threads follow their parent channel.
Removing or deleting the last allowed channel pauses games across the server. To resume, allow
another channel or use `/settings games reset` to allow every channel again. The bot notifies the
configured mod log when a game channel is deleted, unless that log channel was deleted too.

## Gamba

`/gamba [bet]` or `?gamba [bet]` spins three reels. A bet is `1`, `100`, `2.5k`, `all` or `half`
(1 to 10,000 coins), or 1 coin when you give none. There are no free spins. Payouts include your
stake:

| Result        | Payout |
| ------------- | ------ |
| yt pair       | 2x     |
| python pair   | 4x     |
| cpp pair      | 8x     |
| yt triple     | 10x    |
| python triple | 25x    |
| cpp triple    | 100x   |

On average a spin returns about 98.7% of the bet (a ~1% house edge) before the pot. Wins sit mostly
in the common pairs, so a balance lasts: about 36% of spins pay something, and most of those double
the stake. The cpp triple's main prize is the pot and the jackpot role.

`/gamba` shows a card with **Spin again** (same bet) and, when twice the bet is at most 10,000 and
at most your balance, **Double**. Only the player can press them. `?gamba` replies with the reels
and no buttons.

### The pot

- The pot starts at 10,000 coins and never drops below that seed.
- Bets of 100 or less add nothing to it. Bets over 100 add 3% of the whole bet, rounded down.
- A **cpp triple** wins the pot and the jackpot role, plus the 100x payout.
- A **python triple** also takes 8% of the pot above the seed, on top of its 25x payout. Pairs and
  yt triples take nothing from the pot.
- Pot prizes are full-sized at bets of 500 or more and scale by `bet / 500` below that.
- One win takes at most 96x its bet from the pot for a jackpot and 2x its bet for a python triple;
  the rest stays. A 500-coin jackpot takes up to 48,000 coins, a 10,000-coin one up to 960,000.
  This keeps every spin a loss on average however big the pot gets.
- If a jackpot leaves the pot under the seed, it is topped back up.

## Coinflip

`/coinflip bot|challenge|open [bet] [side]`, or `?coinflip` (aliases `?cf`, `?flip`).

- Bets run from 10 to 10,000 coins (default 10). Pick `heads` or `tails`.
- **bot**: flip against the bot.
- **challenge**: challenge a member. They have 60 seconds to accept.
- **open**: anyone can accept within 120 seconds.
- Pending challenges keep their original deadline across bot restarts. If they expire while the
  bot is offline, it updates the cards when it comes back.
- Against a member the winner takes the pool minus a 3% rake (at least 1 coin) that goes into the
  gamba pot.
- Against the bot a win pays both stakes minus the same 3% of the pool, so it nets your bet minus the
  rake, and the rake goes into the pot. A loss costs the bet and adds nothing to the pot. Over many
  flips you lose 3% of what you bet, and that is exactly what the pot gains. Small rakes are
  rounded up or down at random in proportion to the fraction, so this holds at every bet.
- `/stats` counts every flip. The **Coinflip net** leaderboard counts flips against the bot only,
  because flips between members just move coins from one account to another.
- The coin spins for a few seconds before the result shows.
- You can have at most 3 open (not yet accepted or expired) challenges at once in a server, rematches
  included; cancel one or wait for it to expire to post another.
- A finished challenge has a **Rematch** button. Either player can press it: the first press
  challenges the other for the same bet and removes the button.
- From a message, arguments go in any order: `?cf 100 t`, `?cf @member 50 heads`, `?cf open 100`.

## Dice

`/dice [bet] [on]`, or `?dice` (alias `?roll`). Two dice are rolled against the bot and you call the
result. Bets run from 10 to 10,000 coins (default 10).

| Call             | Wins on         | Payout |
| ---------------- | --------------- | ------ |
| `high` (default) | total 8 to 12   | 2.376x |
| `low`            | total 2 to 6    | 2.376x |
| `seven`          | total 7         | 5.94x  |
| `doubles`        | both dice match | 5.94x  |
| exact 6 or 8     | that total      | 7.128x |
| exact 5 or 9     | that total      | 8.91x  |
| exact 4 or 10    | that total      | 11.88x |
| exact 3 or 11    | that total      | 17.82x |
| exact 2 or 12    | that total      | 35.64x |

Payouts are 99% of fair odds. Fractions of a coin are rounded up or down at random in proportion to
the fraction (a 10-coin high pays 23 or 24, 24 six times in ten for an average of 23.76), so the
return is 99% at every bet size. 1% of every bet goes into the gamba pot the same way (a 10-coin
roll adds a coin one time in ten). **Roll again** repeats the same bet and call. From a message:
`?dice 50 seven`, `?dice =12 50`.

# Game rules

Player-facing rules for the games. The `/help` command in Discord always shows the live numbers
(it is built from the same config as the games), so trust it if this page ever disagrees.

Everyone starts with 1,000 coins. Earn more with `/daily`, `/collect`, `/bailout` and by chatting;
see `/help topic:coins`. Server admins can limit the games to certain channels with
`/settings games allow`.

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
- The winner takes the pool minus a 3% rake (at least 1 coin) that goes into the gamba pot. Against
  the bot a win nets your bet minus the rake and a loss costs the bet.
- The coin spins for a few seconds before the result shows.
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

Payouts are 99% of fair odds, rounded down to whole coins. 1% of every bet (at least 1 coin) goes
into the gamba pot. **Roll again** repeats the same bet and call. From a message:
`?dice 50 seven`, `?dice =12 50`.

# Polls

Run `/poll question:Pizza tonight?` or `?poll Pizza tonight?` in any server text channel. Tincazz
posts a card with a live bar chart and reacts with 👍 and 👎. Vote by reacting. Anyone can ask,
and polls are not games: they cost nothing and are not limited to game channels.

## Asking

- `/poll question [options] [duration] [anonymous]`
- `?poll <question>` for a yes/no poll
- `?poll "<question>" | option | option` for your own choices (2 to 9, numbered 1️⃣ to 9️⃣)
- `--anon` and `--for 2h` go at the end of a prefix poll, in either order

The question can be up to 200 characters and each option up to 80. Options must be different
(ignoring case). Durations look like `30m`, `2h` or `3d`, from 1 minute to 7 days, and default to
24 hours. Mentions in the question and options never ping anyone.

You can have 3 open polls per server. Asking a fourth lists your open polls with links and
tells you when the first one ends. Closing a poll, or letting it end, frees a slot.

## Voting

React with an option emoji. You get one vote, and your latest reaction wins. Removing your
reaction withdraws your vote. Reactions that are not options, and reactions from bots, are
ignored. The card updates a few seconds after the last vote.

Anonymous polls (🔒) do not list voters on the card. They are not secret: Discord still shows
who reacted with each emoji, and Tincazz stores who voted what, so that each person only counts
once.

## Closing

A poll closes by itself when time is up. The host, or anyone with **Manage Messages**, can press
**Close poll** to end it early. The closed card shows the final bars and the winner (or a tie, or
that nobody voted). Deleting the poll message cancels the poll.

## Operator notes

Tincazz needs these permissions in the channel:

- **View Channel**, **Send Messages**, **Add Reactions** and **Read Message History**: to post
  the card, add the option reactions and recount votes.
- **Manage Messages** (optional): lets Tincazz remove your old reaction when you switch your vote.
  Without it only your latest vote counts, but the older reactions stay visible on the message.
  Without it, a withdrawn vote can also come back: the periodic recount restores your vote only if
  exactly one option reaction of yours remains. With several left, the latest cannot be known and
  you stay unvoted.

Polls are stored in the database and survive restarts. While the bot is offline, votes are
not lost: on startup, and every 15 minutes, Tincazz reads the reactions Discord returns and brings
the stored votes in line with them. A recount that overlaps live votes is thrown away and retried
a few seconds later, so it never overrides a newer vote. Edits that fail because of missing access are retried with a
backoff, starting after five minutes and growing to an hour.

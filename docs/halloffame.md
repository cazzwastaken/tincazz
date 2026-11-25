# Hall of Fame

When enough different people react to a message, Tincazz posts it in the server's Hall of Fame
channel: a card with the author, the text, the pictures and a link back to the original. Members
do nothing special, they just react. Staff choose the channel and the number of people with
`/settings halloffame`. The Hall of Fame is not a game: it costs nothing and is not limited to
game channels.

## What gets inducted

A message is inducted when **N different people** have reacted to it, where N is the threshold:
5 by default, 2 to 50 if staff change it. The count is **people**, not reactions:

- One person who reacts with five different emoji counts once.
- The author's own reactions never count.
- Bots never count.
- Super reactions (the animated "burst" ones) never count.

Only normal messages and replies are inducted (forwarded messages too, showing what was forwarded).
Joins, boosts, pins, command results and other system messages are not, and neither are messages
written by bots or sent through webhooks. That keeps poll cards, giveaway posts and reaction-role
messages out of the hall.

A message is inducted at most once. The card keeps the **peak** number of people: the count never
goes down, so taking reactions off later does not remove a post. It can go up, and the card is
updated as more people react.

For very popular messages the count is a lower bound. Discord lists the people behind an emoji 100
at a time, and Tincazz reads one page for each of the 20 most used emoji.

## The card

Every card is a single Components V2 message in the hall channel:

- A **HALL OF FAME** header, the author's display name, `@username` and avatar, the original
  channel and when the message was sent.
- The message text as a quote, cut at 1,500 characters (a cut code block is closed again).
  Mentions and `@everyone` in it never ping anyone.
- For a reply, a line saying who it replied to with a short snippet. For a forward, a "Forwarded
  message" line and the forwarded text. A native poll shows as a note with its question.
- Up to 4 pictures (PNG, JPEG, GIF and WebP, 8 MB in total). Discord's picture links expire, so
  the pictures are **copied** into the hall post and stay for as long as the post does. Pictures
  marked as spoilers stay spoilers. A picture that cannot be copied is left out and the card says
  so. Stickers are shown by their permanent image (a Lottie sticker, which has none, by name), and
  images and GIFs from links (Discord, Tenor and Giphy only) are shown from the link.
- Other attachments are listed by name (the first five, then "+N more files"); they are not copied.
- A footer with the peak number of people and the three most used emoji (custom emoji from other
  servers are left out of the breakdown but still counted), then two buttons: **Jump to message**
  and the original channel.

The accent colour and the icon in the footer grow with the count, compared with the current
threshold:

| Peak count            | Icon |
| --------------------- | ---- |
| below 2x threshold    | ⭐   |
| 2x to below 4x        | 🌟   |
| 4x to below 8x        | 💫   |
| 8x threshold and over | 👑   |

For example, with the default threshold of 5, a message goes from ⭐ at 5 people to 🌟 at 10, 💫 at
20 and 👑 at 40. Changing the threshold changes the icon the next time a card is refreshed.

When a message is inducted, counting stops as soon as the threshold is reached, so the first number
on the card can be low. The final count and the emoji breakdown follow within about half a minute.

## Setup

Anyone with **Manage Server** can set it up. All of it lives under `/settings halloffame`:

| Command                                                      | What it does                                            |
| ------------------------------------------------------------ | ------------------------------------------------------- |
| `/settings halloffame set channel:#hall-of-fame threshold:5` | Pick the hall channel (and optionally the threshold)    |
| `/settings halloffame threshold count:8`                     | Change how many people a message needs                  |
| `/settings halloffame exempt channel:#spam`                  | Never induct messages from a channel or category        |
| `/settings halloffame unexempt channel:#spam`                | Allow it again                                          |
| `/settings halloffame clear`                                 | Stop inducting (existing posts stay)                    |
| `/settings show`                                             | Show the channel, threshold, exemptions and any problem |

- `set` takes a text or announcement channel. It checks the bot's permissions, posts an intro card
  there (so you can see it works, and so members learn the rules) and only then saves the channel.
  If the bot cannot post there, nothing changes. Running it again for the same channel with a new
  threshold just changes the threshold. The honeypot channel cannot be the hall, and the hall
  cannot become the honeypot.
- `threshold` takes a whole number from 2 to 50. It is **not retroactive**: it applies from the next
  reaction, posts already in the hall stay, and old messages are not scanned. Lowering it does not
  add posts for old messages until someone reacts to them again.
- `exempt` accepts a text, announcement, voice, stage, forum or media channel, or a category. A
  channel's threads count as the channel, and a category covers every channel in it with their
  threads. Up to 50 exemptions. The hall and the honeypot channel are always skipped and need no
  entry. Exempting a channel keeps the posts it already has, but they stop being updated.
- The settings are logged to the mod log channel, if there is one: set, cleared, threshold and
  exemptions added or removed, and automatic clean-ups.

## Permissions

Tincazz needs these permissions:

- In the **hall channel**: View Channel, Send Messages, Attach Files and Read Message History.
  Attach Files is for the copied pictures. Read Message History lets it find its own card again
  after a crash (see below).
- In the **channels messages come from**: View Channel and Read Message History, to read the
  message and see who reacted. A channel the bot cannot read is skipped.

No new intent is needed: reactions arrive through the reaction events the bot already receives,
and it reads the message and its reactions from Discord when it needs them, so a message the bot
has not seen before still works. `/settings show` warns when the hall channel
is missing a permission.

## What is never inducted

These checks are automatic and silent: nothing tells the people who reacted. They are also listed
in the intro card, in `/settings show` and in `/help halloffame`.

| What              | Why                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| The hall itself   | Messages in the hall channel (and its threads) are never inducted again.                                    |
| The honeypot      | The honeypot channel is never inducted.                                                                     |
| Exempt channels   | A channel staff exempted, a thread of one, or a channel in an exempt category.                              |
| Private threads   | The hall cannot tell who was invited to them.                                                               |
| Age-restricted    | A message from an age-restricted channel is skipped unless the hall channel is age-restricted too.          |
| Private channels  | A message is only posted into a hall that nobody can see who couldn't already see the original (see below). |
| Bots and webhooks | Messages written by bots, or sent through webhooks.                                                         |
| System messages   | Only normal messages and replies count, not joins, boosts, pins or command results.                         |

A thread follows its parent channel for the age-restriction and private-channel checks. If the bot
cannot resolve the hall channel, nothing is inducted.

**How the private-channel check works.** Tincazz lists who can see a channel: every role (with
`@everyone`) whose permissions in that channel include View Channel, plus every member with their
own View Channel permission overwrite there. Roles with Administrator, who see everything, and the
bot itself are not counted. A message is inducted only when everyone on the hall's list is also on
the source channel's list. So in a server where `@everyone` is locked out everywhere, a staff
channel is never posted into a members-only hall, and a member who has a personal overwrite on the
hall but not on the source channel blocks it too. If either list cannot be worked out, nothing is
inducted.

The check is **conservative**: it compares who is allowed in, not who actually holds a role, so it
can skip a message that would have been safe (for example when a role can see the hall but is
denied the source channel, even if nobody in it reacts). It is a safety net, not a guarantee about
your permission setup. To keep a channel out of the hall for certain, **exempt it**: exempting is
the way to hard-block a private channel, and nothing else overrides it.

## After the post

- **Edits**: when the original is edited, the post is redrawn within a few seconds. An edit that
  changes nothing visible, such as a link preview that finished loading, does not touch the post.
  The pictures are copied again, and a picture the author removed disappears. This stops for a post
  that is frozen (see below), and an edit made while the bot was offline is only picked up by the
  next edit or reaction.
- **Deleted originals**: while the bot is online, deleting the original (or bulk deleting it, or
  deleting its channel or thread, or the channel or forum a thread belongs to) deletes the hall post
  too. This is driven by Discord's delete events, so an original deleted **while the bot was
  offline** is not noticed at the next start: the post is only checked again when its original
  gets an edit or a reaction, and a deleted message can get neither. Such a post stays until staff
  delete it by hand.
- **Deleted hall posts**: if staff delete a post from the hall, Tincazz remembers and never posts
  that message again, whatever happens to its reactions.
- **Changed source**: if the channel later becomes private (see the audience check above),
  age-restricted or exempt, the post is **frozen**: it stays as it is and later edits and new
  reactions are not copied into it. Nothing removes a frozen post except deleting the original
  while the bot is online or staff deleting the post, so staff delete it by hand if it should go.
- **Changing the hall channel**: posts in the old channel stay there and keep following edits and
  deletions. New inductions go to the new channel, and a message that is already in the old hall is
  not posted again.
- **Clearing the hall**: nothing new is inducted. Existing posts stay.
- **Deleting the hall channel**: the setting is cleared automatically (and logged), and the records
  of the posts that were in it are dropped. After picking a new channel, those messages can be
  inducted again if people react to them again. Deleting an exempt channel or category removes it
  from the exemptions.

## How it keeps up

You can ignore this unless something looks slow or missing.

- **Reactions are batched.** After a reaction Tincazz waits 3 seconds for more, and never longer
  than 30 seconds, then counts the people once. A message that was just short of the threshold is
  not looked at again until enough new reactions could have taken it over.
- **A bounded queue.** Two messages are counted at a time. If more than 200 are waiting, the extra
  are dropped, and the next reaction on them tries again. Posted cards are refreshed at most every
  30 seconds. Discord's rate limits are handled by the library, which waits and retries.
- **No access, no retries.** If Discord refuses access to a channel, it is skipped for 10 minutes.
  Running `/settings halloffame set` for a hall channel, including the one already set, clears that
  memory for it at once, so after fixing permissions just run it again.
- **One post per message.** Tincazz reserves the message in its database before sending anything,
  so two reactions at the same time, or a restart in the middle, cannot produce two posts.
- **Restarts and crashes.** Everything that matters is stored in the database. If the bot stops
  between sending a card and recording it, the reservation is picked up at the next start (and
  hourly): Tincazz looks through the last 300 messages of the hall channel for its own card for that
  message and adopts it, or, if there is none, releases the reservation so the message can be
  inducted by its next reaction. If it cannot check, it waits rather than risk a duplicate.
- **Reactions while offline** are not scanned. A message that reached the threshold while the bot
  was down is inducted when its next reaction arrives.

## Troubleshooting

If a message does not show up, check in this order:

1. **Is it set?** `/settings show` should list a hall channel without a warning.
2. **Enough different people?** The author, bots and super reactions do not count, and one person
   counts once however many emoji they use. A new reaction triggers the check, so there is a delay
   of a few seconds (up to 30).
3. **Is the channel skipped?** Private channels (when someone can see the hall who cannot see the channel), age-restricted
   channels (while the hall is not), private threads, exempt channels and categories, the hall
   itself and the honeypot are never inducted.
4. **Is the message eligible?** Messages by bots and webhooks and system messages are skipped.
5. **Permissions.** The bot needs View Channel and Read Message History in the source channel, and
   View Channel, Send Messages and Attach Files in the hall. A channel that refused the bot is
   skipped for 10 minutes. After fixing the hall's permissions, run `/settings halloffame set` for it again to clear that at once; a source channel is tried again after the 10 minutes.
6. **Was it posted before?** If staff deleted the post, it is never posted again. A message
   already in an older hall channel is not posted again either.
7. **Threshold changes** are not retroactive: an old message needs a new reaction to be looked at
   again.

If a post looks out of date, edit the original or add a reaction and it refreshes in a few seconds.

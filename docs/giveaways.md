# Giveaways

Run `/giveaway create prize:Nitro 1 month duration:12 hours` in a server text or announcement
channel. The command requires **Manage Messages** in that channel. The person who runs it is
the host. Durations use whole minutes, hours, or days, from `1 minute` to `30 days`.
Short forms such as `30m`, `12h`, and `1d` work too. Tincazz queues the request and starts
the duration when the public entry card opens.

React with 🎉 on the giveaway post to enter. Remove your 🎉 reaction to withdraw. If you added both
a regular and a Super Reaction, remove both to withdraw. Each person gets one entry. The host and
bot accounts are excluded. The post shows the prize, host, entry count, and earliest draw time.

Use `/giveaway list` to see current giveaways and giveaways with channel access issues.
Results are private and include only channels you can view and read. Use the `page` option for more.

## Drawing and recovery

At or after the displayed time, Tincazz reads the 🎉 reactions Discord returns while the draw runs
and selects one eligible entrant at random. If the draw is delayed, changes to reactions can still
affect the result. This applies during busy periods, restarts, and Discord outages. Tincazz edits
the original post with the result. The winner contacts the host to claim the prize.

If Tincazz loses channel access, restore its channel permissions to resume. It retries automatically,
starting after five minutes and backing off to one hour. Once Tincazz records a result, it retries
the result edit with the same winner. Deleting the giveaway post before the draw cancels it.

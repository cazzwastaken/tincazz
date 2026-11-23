# Giveaways

Run `/giveaway create prize:Nitro 1 month duration:12 hours` in a server text or announcement
channel. The command requires **Manage Messages** in that channel. The person who runs it is
the host. Durations use whole minutes, hours, or days, from `1 minute` to `30 days`.
Short forms such as `30m`, `12h`, and `1d` work too.

React with 🎉 on the giveaway post to enter. Remove your 🎉 reaction to withdraw. If you added both
a regular and a Super Reaction, remove both to withdraw. Each person gets one entry. The host and
bot accounts are excluded. The post shows the prize, host, entry count, and scheduled draw time.

Use `/giveaway list` to see current giveaways in this server, ordered by draw time. Each listing
shows its server-specific ID, prize, host, entry count, draw time, and a link to the post. Results
are private and include only channels you can view and read. Use the `page` option for more.

## Drawing and recovery

At the deadline, Tincazz reads the current 🎉 reactions and selects one eligible entrant at random.
It edits the original post with the result, including when there are zero eligible entrants. The
winner contacts the host to claim the prize.

A restart preserves the original deadline. If the bot or Discord was unavailable at draw time,
Tincazz draws from the reactions still present when it can fetch them. Discord provides the current
list of reactors without reaction timestamps. Once Tincazz records the result, it retries any
failed result edit with the same winner. Deleting the giveaway post before the draw cancels it.

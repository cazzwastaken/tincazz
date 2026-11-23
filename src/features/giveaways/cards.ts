import { EmbedBuilder, escapeMarkdown, messageLink } from 'discord.js';
import { accents, discordTime } from '../ui/index.js';
import { giveaway } from './config.js';
import type { Giveaway } from './store.js';

export function giveawayEmbed(row: Giveaway, entryCount: number): EmbedBuilder {
  if (row.status === 'cancelled') {
    return new EmbedBuilder()
      .setAuthor({ name: 'Giveaway cancelled' })
      .setTitle(escapeMarkdown(row.prize))
      .setColor(accents.loss)
      .setDescription('Staff cancelled this giveaway before the draw.')
      .setFooter({ text: `Giveaway #${row.id}` });
  }
  const ended = row.status === 'ended';
  const entryText = entryCount.toLocaleString('en-US');
  const embed = new EmbedBuilder()
    .setAuthor({ name: ended ? '🏆 Giveaway ended' : '🎁 Tincazz giveaway' })
    .setTitle(escapeMarkdown(row.prize))
    .setColor(ended ? (row.winnerId ? accents.gold : accents.loss) : accents.brand)
    .setDescription(
      ended
        ? row.winnerId
          ? 'Congratulations! Contact the host to claim your prize.'
          : 'No one eligible entered before the draw.'
        : `React with ${giveaway.emoji} to enter. Remove your reaction to withdraw. Entries are read when the draw runs.`,
    )
    .addFields(
      { name: 'Host', value: `<@${row.hostId}>`, inline: true },
      { name: 'Entries', value: entryText, inline: true },
      {
        name: ended ? 'Winner' : 'Earliest draw',
        value: ended
          ? row.winnerId
            ? `<@${row.winnerId}>`
            : 'No winner'
          : row.endsAt === null
            ? 'Time will appear shortly'
            : discordTime(row.endsAt),
        inline: true,
      },
    )
    .setFooter({ text: `Giveaway #${row.id}` });
  const timestamp = row.drawnAt ?? row.endsAt;
  if (timestamp !== null) embed.setTimestamp(timestamp);
  return embed;
}

const giveawaysPerPage = 8;

export function giveawayList(rows: Giveaway[], page: number, now: number): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('🎁 Current giveaways').setColor(accents.brand);
  if (rows.length === 0) {
    return embed.setDescription('There are no active giveaways in the channels you can read.');
  }

  const totalPages = Math.ceil(rows.length / giveawaysPerPage);
  if (page > totalPages) {
    return embed.setDescription(
      `This server has ${totalPages} page${totalPages === 1 ? '' : 's'} of current giveaways you can see.`,
    );
  }

  const start = (page - 1) * giveawaysPerPage;
  for (const row of rows.slice(start, start + giveawaysPerPage)) {
    const ending =
      row.accessFailures > 0
        ? 'Bot access blocked. Restore its channel permissions to resume.'
        : row.endsAt !== null && row.endsAt > now
          ? `Earliest draw ${discordTime(row.endsAt)}`
          : 'Draw pending';
    const link = row.messageId
      ? ` · [View post](${messageLink(row.channelId, row.messageId, row.guildId)})`
      : '';
    const entries =
      row.entryCount === null
        ? 'Updating entry count'
        : `${row.entryCount.toLocaleString('en-US')} ${row.entryCount === 1 ? 'entry' : 'entries'}`;
    embed.addFields({
      name: `#${row.id} · ${escapeMarkdown(row.prize)}`,
      value: `Hosted by <@${row.hostId}> · ${entries}\n${ending}${link}`,
    });
  }
  return embed.setFooter({ text: `Page ${page} of ${totalPages}` });
}

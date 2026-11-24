import { createHash } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ContainerBuilder,
  escapeMarkdown,
} from 'discord.js';
import { accents, card, discordTime } from '../ui/index.js';
import { optionResults, outcome, voteCount, yesNoResults } from './bars.js';
import { encodePollCloseId } from './custom-ids.js';
import { pollEmojis } from './emojis.js';
import type { Poll } from './types.js';

type CardPoll = Pick<
  Poll,
  | 'guildId'
  | 'id'
  | 'hostId'
  | 'question'
  | 'options'
  | 'yesNo'
  | 'anonymous'
  | 'endsAt'
  | 'status'
  | 'closedBy'
  | 'closedAt'
>;

const anonymousNote =
  '🔒 Anonymous: this card does not list voters, but Discord still shows who reacted.';

function banner(poll: CardPoll, counts: readonly number[]): string {
  const result = outcome(counts);
  const name = (index: number) => escapeMarkdown(poll.options[index] ?? '?');
  switch (result.kind) {
    case 'none':
      return '🤷 No votes were cast.';
    case 'tie':
      return `🤝 It's a tie: ${result.indexes.map(name).join(' and ')}.`;
    case 'winner':
      return `🏆 **${name(result.index)}** win${poll.yesNo ? '' : 's'} by ${result.margin.toLocaleString('en-US')}`;
  }
}

/** The poll card: open (with a Close poll button) or closed (final results, no button). */
export function pollCard(poll: CardPoll, counts: readonly number[]): ContainerBuilder {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const closed = poll.status === 'closed';
  const results = poll.yesNo
    ? yesNoResults(counts)
    : optionResults(poll.options, pollEmojis(poll), counts, escapeMarkdown);

  const lock = poll.anonymous ? ' · 🔒' : '';
  const header = closed
    ? `📊 **Poll closed**${lock} · asked by <@${poll.hostId}>`
    : `📊 <@${poll.hostId}> asks${lock}`;
  const footer = [
    voteCount(total),
    closed
      ? `closed ${discordTime(poll.closedAt ?? poll.endsAt)}${poll.closedBy ? ` by <@${poll.closedBy}>` : ''}`
      : `closes ${discordTime(poll.endsAt)}`,
  ].join(' · ');
  const texts = [
    header,
    `## ${escapeMarkdown(poll.question)}`,
    ...(closed ? [banner(poll, counts)] : []),
    results,
    `-# ${footer}${poll.anonymous ? `\n-# ${anonymousNote}` : ''}`,
  ];
  const container = card(
    closed ? (outcome(counts).kind === 'none' ? accents.loss : accents.gold) : accents.brand,
    ...texts,
  );
  if (!closed) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('Close poll')
          .setCustomId(encodePollCloseId({ guildId: poll.guildId, pollId: poll.id }))
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return container;
}

/** Identifies what a card shows, so an unchanged card is not edited again. */
export function pollCardHash(poll: CardPoll, counts: readonly number[]): string {
  return createHash('sha1')
    .update(JSON.stringify([poll.status, poll.closedBy, poll.endsAt, counts]))
    .digest('hex');
}

import {
  type APIReaction,
  type Client,
  DiscordAPIError,
  type RESTGetAPIChannelMessageReactionUsersResult,
  type RESTGetAPIChannelMessageResult,
  RESTJSONErrorCodes,
  ReactionType,
  Routes,
} from 'discord.js';
import { giveawayEmbed } from './cards.js';
import { giveaway } from './config.js';
import type { Giveaway } from './store.js';

const encodedEmoji = encodeURIComponent(giveaway.emoji);

export async function fetchGiveawayMessage(client: Client<true>, row: Giveaway) {
  // Use the Discord snapshot directly so a cached gateway message cannot affect a draw.
  return (await client.rest.get(
    Routes.channelMessage(row.channelId, row.messageId),
  )) as RESTGetAPIChannelMessageResult;
}

export async function seedGiveawayReaction(client: Client<true>, row: Giveaway): Promise<void> {
  await client.rest.put(
    Routes.channelMessageOwnReaction(row.channelId, row.messageId, encodedEmoji),
  );
}

export async function editGiveawayMessage(client: Client<true>, row: Giveaway, entryCount: number) {
  await client.rest.patch(Routes.channelMessage(row.channelId, row.messageId), {
    body: {
      content: '',
      embeds: [giveawayEmbed(row, entryCount).toJSON()],
      allowed_mentions: { parse: [] },
    },
  });
}

export function isGiveawayMessageGone(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    (error.code === RESTJSONErrorCodes.UnknownChannel ||
      error.code === RESTJSONErrorCodes.UnknownMessage)
  );
}

export async function eligibleEntrants(
  client: Client<true>,
  row: Giveaway,
  reaction: APIReaction | undefined,
): Promise<string[]> {
  if (!reaction) return [];

  const route = Routes.channelMessageReaction(row.channelId, row.messageId, encodedEmoji);
  const entrants = new Set<string>();
  for (const type of [ReactionType.Normal, ReactionType.Burst]) {
    const count =
      type === ReactionType.Normal ? reaction.count_details.normal : reaction.count_details.burst;
    if (count === 0) continue;

    let after: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ type: String(type), limit: '100' });
      if (after) query.set('after', after);
      const users = (await client.rest.get(route, {
        query,
      })) as RESTGetAPIChannelMessageReactionUsersResult;
      const cursor = BigInt(after ?? 0);
      let highestId = cursor;
      for (const user of users) {
        if (!user.bot && user.id !== row.hostId) entrants.add(user.id);
        const id = BigInt(user.id);
        if (id > highestId) highestId = id;
      }
      if (users.length < 100) break;
      // Discord's cursor is a user snowflake, independent of reaction time.
      if (highestId === cursor) {
        throw new Error('Discord returned a reaction page without advancing its cursor');
      }
      after = highestId.toString();
    }
  }
  return [...entrants];
}

export function entryReaction(emoji: { id?: string | null; name?: string | null }): boolean {
  return !emoji.id && emoji.name === giveaway.emoji;
}

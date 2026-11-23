import {
  type APIReaction,
  type Client,
  DiscordAPIError,
  type RESTGetAPIChannelMessageReactionUsersResult,
  type RESTGetAPIChannelMessageResult,
  type RESTGetAPIChannelMessagesResult,
  RESTJSONErrorCodes,
  type RESTPostAPIChannelMessageResult,
  ReactionType,
  Routes,
} from 'discord.js';
import { giveawayEmbed } from './cards.js';
import { giveaway } from './config.js';
import type { Giveaway } from './store.js';

const encodedEmoji = encodeURIComponent(giveaway.emoji);

type PostedGiveaway = Pick<Giveaway, 'channelId'> & { messageId: string };

const setupText = (row: Giveaway) => `🎁 Setting up Tincazz giveaway #${row.id}…`;

export async function recoverOrPostGiveaway(client: Client<true>, row: Giveaway): Promise<string> {
  if (!row.creationId) throw new Error('Missing giveaway creation ID');

  const route = Routes.channelMessages(row.channelId);
  const creationTime = BigInt(row.creationId) >> 22n;
  const content = setupText(row);
  const query = new URLSearchParams({ limit: '100' });
  // The nonce also deduplicates Discord REST retries, but Discord only retains it briefly.
  // Scan back to the interaction to recover an accepted send even after a long restart.
  for (;;) {
    const messages = (await client.rest.get(route, { query })) as RESTGetAPIChannelMessagesResult;
    let oldest: bigint | undefined;
    for (const message of messages) {
      const id = BigInt(message.id);
      if (
        id >> 22n >= creationTime &&
        message.author.id === client.user.id &&
        message.content === content
      ) {
        return message.id;
      }
      if (oldest === undefined || id < oldest) oldest = id;
    }
    if (messages.length < 100 || oldest === undefined || oldest >> 22n < creationTime) break;
    const before = oldest.toString();
    if (before === query.get('before')) throw new Error('Giveaway history cursor did not advance');
    query.set('before', before);
  }

  const message = (await client.rest.post(route, {
    body: { content, nonce: row.creationId, enforce_nonce: true, allowed_mentions: { parse: [] } },
  })) as RESTPostAPIChannelMessageResult;
  return message.id;
}

export async function fetchGiveawayMessage(client: Client<true>, row: PostedGiveaway) {
  // Use the Discord snapshot directly so a cached gateway message cannot affect a draw.
  return (await client.rest.get(
    Routes.channelMessage(row.channelId, row.messageId),
  )) as RESTGetAPIChannelMessageResult;
}

export async function seedGiveawayReaction(
  client: Client<true>,
  row: PostedGiveaway,
): Promise<void> {
  await client.rest.put(
    Routes.channelMessageOwnReaction(row.channelId, row.messageId, encodedEmoji),
  );
}

export async function editGiveawayMessage(
  client: Client<true>,
  row: Giveaway & PostedGiveaway,
  entryCount: number,
) {
  return (await client.rest.patch(Routes.channelMessage(row.channelId, row.messageId), {
    body: {
      content: '',
      embeds: [giveawayEmbed(row, entryCount).toJSON()],
      allowed_mentions: { parse: [] },
    },
  })) as RESTGetAPIChannelMessageResult;
}

export function isGiveawayMessageGone(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    (error.code === RESTJSONErrorCodes.UnknownChannel ||
      error.code === RESTJSONErrorCodes.UnknownMessage)
  );
}

export function isGiveawayAccessError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.status === 403;
}

export async function eligibleEntrants(
  client: Client<true>,
  row: PostedGiveaway & Pick<Giveaway, 'hostId'>,
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

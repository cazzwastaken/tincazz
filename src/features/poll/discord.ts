import {
  type APIReaction,
  type Client,
  DiscordAPIError,
  MessageFlags,
  type RESTGetAPIChannelMessageReactionUsersResult,
  type RESTGetAPIChannelMessageResult,
  RESTJSONErrorCodes,
  type RESTPostAPIChannelMessageResult,
  ReactionType,
  Routes,
} from 'discord.js';
import { pollCard } from './cards.js';
import { optionIndexOf, pollEmojis } from './emojis.js';
import type { Poll } from './types.js';

type Posted = Pick<Poll, 'channelId'> & { messageId: string };

const encode = (emoji: string) => encodeURIComponent(emoji);

function body(row: Poll, counts: readonly number[]) {
  return {
    components: [pollCard(row, counts).toJSON()],
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: { parse: [] },
  };
}

/** Posts the poll card. The nonce makes a retried send return the same message. */
export async function postPollMessage(
  client: Client<true>,
  row: Poll,
  counts: readonly number[],
): Promise<string> {
  const message = (await client.rest.post(Routes.channelMessages(row.channelId), {
    body: { ...body(row, counts), nonce: row.creationId.slice(0, 25), enforce_nonce: true },
  })) as RESTPostAPIChannelMessageResult;
  return message.id;
}

export async function editPollMessage(
  client: Client<true>,
  row: Poll & Posted,
  counts: readonly number[],
): Promise<void> {
  await client.rest.patch(Routes.channelMessage(row.channelId, row.messageId), {
    body: body(row, counts),
  });
}

/** Best-effort removal of a poll message that never opened; failures are ignored. */
export async function deletePollMessage(
  client: Client<true>,
  row: Pick<Poll, 'channelId' | 'messageId'>,
): Promise<void> {
  if (row.messageId === null) return;
  try {
    await client.rest.delete(Routes.channelMessage(row.channelId, row.messageId));
  } catch {
    // Already gone or not ours to delete: nothing more to do.
  }
}

/** Adds the bot's own option reactions in order (a no-op for ones already there). */
export async function seedPollReactions(
  client: Client<true>,
  row: Poll & Posted,
  only?: ReadonlySet<string>,
): Promise<void> {
  for (const emoji of pollEmojis(row)) {
    if (only && !only.has(emoji)) continue;
    await client.rest.put(
      Routes.channelMessageOwnReaction(row.channelId, row.messageId, encode(emoji)),
    );
  }
}

export async function fetchPollMessage(client: Client<true>, row: Posted) {
  return (await client.rest.get(
    Routes.channelMessage(row.channelId, row.messageId),
  )) as RESTGetAPIChannelMessageResult;
}

/** Option emoji the bot has not reacted with yet. */
export function missingSeeds(
  row: Poll,
  reactions: readonly APIReaction[] | undefined,
): Set<string> {
  const mine = new Set(
    (reactions ?? [])
      .filter((reaction) => reaction.me && !reaction.emoji.id)
      .map((reaction) => reaction.emoji.name),
  );
  return new Set(pollEmojis(row).filter((emoji) => !mine.has(emoji)));
}

/** Everyone (not bots) who reacted with each option's emoji, by option index. */
export async function fetchVoters(
  client: Client<true>,
  row: Poll & Posted,
  reactions: readonly APIReaction[] | undefined,
): Promise<Map<number, Set<string>>> {
  const voters = new Map<number, Set<string>>();
  for (const reaction of reactions ?? []) {
    const name = reaction.emoji.id ? undefined : reaction.emoji.name;
    const index = name ? optionIndexOf(row, name) : undefined;
    if (index === undefined || !name) continue;

    const route = Routes.channelMessageReaction(row.channelId, row.messageId, encode(name));
    const users = voters.get(index) ?? new Set<string>();
    voters.set(index, users);
    // Only normal reactions vote: super (burst) reactions are ignored, like their live events.
    if (reaction.count_details.normal === 0) continue;
    let after: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ type: String(ReactionType.Normal), limit: '100' });
      if (after) query.set('after', after);
      const page = (await client.rest.get(route, {
        query,
      })) as RESTGetAPIChannelMessageReactionUsersResult;
      const cursor = BigInt(after ?? 0);
      let highest = cursor;
      for (const user of page) {
        if (!user.bot) users.add(user.id);
        const id = BigInt(user.id);
        if (id > highest) highest = id;
      }
      if (page.length < 100) break;
      if (highest === cursor) throw new Error('Reaction page did not advance its cursor');
      after = highest.toString();
    }
  }
  return voters;
}

export function isPollMessageGone(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    (error.code === RESTJSONErrorCodes.UnknownChannel ||
      error.code === RESTJSONErrorCodes.UnknownMessage)
  );
}

export function isPollAccessError(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.status === 403;
}

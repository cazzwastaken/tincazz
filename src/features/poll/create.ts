import type { Client } from 'discord.js';
import type { Db } from '../../db/index.js';
import { messageLinkUrl } from '../imaging/links.js';
import { discordTime } from '../ui/index.js';
import type { PollInput } from './args.js';
import { poll as config } from './config.js';
import { deletePollMessage } from './discord.js';
import { publishPoll } from './runner.js';
import { discardPoll, getPoll, type Poll, queuePoll } from './store.js';

export interface PollRequest {
  guildId: string;
  channelId: string;
  hostId: string;
  /** Idempotency key: the interaction or message ID. */
  creationId: string;
  input: PollInput;
}

export type CreatedPoll = { ok: true; url: string } | { ok: false; error: string };

export const pollPostFailed =
  'I could not post the poll here. I need View Channel, Send Messages, Add Reactions and Read Message History in this channel.';

/** The refusal shown at the cap: the open polls with links and when the first one ends. */
export function pollCapText(guildId: string, open: readonly Poll[]): string {
  const lines = open.map((row) => {
    const label = row.messageId
      ? `[${row.question.length > 60 ? `${row.question.slice(0, 57)}...` : row.question}](${messageLinkUrl(guildId, row.channelId, row.messageId)})`
      : 'a poll that is still being posted';
    return `- ${label}, closes ${discordTime(row.endsAt)}`;
  });
  const earliest = open[0];
  return [
    `You already have ${config.maxOpenPerHost} open polls. Close one with its Close poll button${
      earliest ? ` or wait for ${discordTime(earliest.endsAt)}` : ''
    }.`,
    ...lines,
  ].join('\n');
}

export const pollStillPosting = 'That poll is still being posted. Give it a moment.';

/** A repeated creation never republishes: it only points at what the first one made. */
function existingResult(guildId: string, row: Poll): CreatedPoll {
  if (row.status === 'publishing') return { ok: false, error: pollStillPosting };
  if (row.status === 'deleted' || row.messageId === null) {
    return { ok: false, error: pollPostFailed };
  }
  return { ok: true, url: messageLinkUrl(guildId, row.channelId, row.messageId) };
}

/** Reserves a slot, posts the poll and opens it. A failed post gives the slot back. */
export async function createPoll(
  client: Client<true>,
  db: Db,
  request: PollRequest,
  now: number = Date.now(),
): Promise<CreatedPoll> {
  const { input } = request;
  const queued = queuePoll(
    db,
    {
      guildId: request.guildId,
      channelId: request.channelId,
      hostId: request.hostId,
      creationId: request.creationId,
      question: input.question,
      options: input.options,
      anonymous: input.anonymous,
      durationMs: input.durationMs,
    },
    now,
  );
  if (queued.kind === 'cap') return { ok: false, error: pollCapText(request.guildId, queued.open) };
  if (queued.kind === 'existing') return existingResult(request.guildId, queued.poll);
  try {
    const opened = await publishPoll(client, db, queued.poll, now);
    return {
      ok: true,
      url: messageLinkUrl(request.guildId, opened.channelId, opened.messageId as string),
    };
  } catch (error) {
    // The message may have been posted before seeding or opening failed: do not leave it behind.
    const posted = getPoll(db, request.guildId, queued.poll.id);
    if (posted) await deletePollMessage(client, posted);
    discardPoll(db, queued.poll);
    client.logger.warn(`Poll in guild ${request.guildId} could not be posted`, error);
    return { ok: false, error: pollPostFailed };
  }
}

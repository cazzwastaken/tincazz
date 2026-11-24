import type { Db } from '../../src/db/index.js';
import { type Poll, queuePoll, updatePoll } from '../../src/features/poll/store.js';

interface OpenOptions {
  guildId?: string;
  channelId?: string;
  messageId?: string;
  hostId?: string;
  options?: string[] | undefined;
  anonymous?: boolean;
  /** Epoch ms the poll ends at. */
  endsAt: number;
  now: number;
}

/** Queues a poll and opens it as if it had been posted. */
export function openPoll(db: Db, o: OpenOptions): Poll {
  const messageId = o.messageId ?? '30';
  const queued = queuePoll(
    db,
    {
      guildId: o.guildId ?? '10',
      channelId: o.channelId ?? '20',
      hostId: o.hostId ?? '2',
      question: 'Dinner?',
      options: o.options,
      anonymous: o.anonymous ?? false,
      durationMs: o.endsAt - o.now,
      creationId: `create-${messageId}`,
    },
    o.now,
  );
  if (queued.kind === 'cap') throw new Error('Test poll hit the cap');
  const opened = updatePoll(db, queued.poll, { status: 'open', messageId, nextSyncAt: o.now });
  if (!opened) throw new Error('Could not open test poll');
  return opened;
}

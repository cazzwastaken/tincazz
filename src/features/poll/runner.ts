import { container } from '@sapphire/framework';
import type { Client } from 'discord.js';
import type { Db } from '../../db/index.js';
import { pollCardHash } from './cards.js';
import { poll as config } from './config.js';
import {
  deletePollMessage,
  editPollMessage,
  fetchPollMessage,
  fetchVoters,
  isPollAccessError,
  isPollMessageGone,
  missingSeeds,
  postPollMessage,
  seedPollReactions,
} from './discord.js';
import {
  applyRecount,
  closeDuePoll,
  discardPoll,
  duePolls,
  type Poll,
  recountRaced,
  refreshPendingPolls,
  tallyPoll,
  updatePoll,
} from './store.js';

function nextRefresh(row: Poll, now: number): number {
  if (row.status === 'publishing') return now + config.publishRetryMs;
  if (row.status === 'closed') return now + config.retryMs;
  const refreshAt = now + config.recountMs;
  return row.endsAt > now ? Math.min(row.endsAt, refreshAt) : refreshAt;
}

/**
 * Posts a `publishing` poll (if it has no message yet), seeds its reactions and opens it.
 * Throws on any Discord failure; the caller discards the row so the host's slot is not used.
 */
export async function publishPoll(
  client: Client<true>,
  db: Db,
  row: Poll,
  now: number = Date.now(),
): Promise<Poll> {
  if (row.status !== 'publishing')
    throw new Error(`Poll #${row.id} is ${row.status}, not publishing`);
  const counts = row.options.map(() => 0);
  if (row.messageId === null) {
    const messageId = await postPollMessage(client, row, counts);
    const saved = updatePoll(db, row, { messageId });
    if (!saved) {
      // Discarded mid-post: nothing records this message, so remove it here.
      await deletePollMessage(client, { channelId: row.channelId, messageId });
      throw new Error('The poll changed while it was being posted');
    }
    row = saved;
  }
  const location = { channelId: row.channelId, messageId: row.messageId as string };
  await seedPollReactions(client, { ...row, ...location });
  // Reactions added while seeding are picked up by the first recount, shortly after opening.
  const opened = updatePoll(db, row, {
    status: 'open',
    nextSyncAt: Math.min(row.endsAt, now + config.debounceMs),
    accessFailures: 0,
    lastRenderedHash: pollCardHash({ ...row, status: 'open' }, counts),
    lastRecountAt: null,
  });
  if (!opened) throw new Error('The poll changed while it was being opened');
  return opened;
}

export async function syncPoll(client: Client<true>, db: Db, row: Poll, now: number) {
  const forgetMessage = () => {
    updatePoll(db, row, { status: 'deleted', nextSyncAt: null, accessFailures: 0 });
  };

  try {
    if (row.status === 'deleted') return;
    if (row.status === 'publishing') {
      if (now - row.createdAt >= config.publishTtlMs) {
        // Stuck publishing: do not hold the host's slot forever.
        await deletePollMessage(client, row);
        discardPoll(db, row);
        return;
      }
      if (row.messageId === null) return;
      await publishPoll(client, db, row, now);
      return;
    }
    if (row.messageId === null) throw new Error('Missing poll message ID');
    const location = { channelId: row.channelId, messageId: row.messageId };

    if (row.status === 'open') {
      if (now >= row.endsAt) {
        const closed = closeDuePoll(db, row, now);
        if (!closed) return;
        row = closed;
      } else {
        let raced = false;
        const recounting =
          row.lastRecountAt === null || now - row.lastRecountAt >= config.recountMs;
        if (recounting) {
          const message = await fetchPollMessage(client, location);
          if (message.author.id !== client.user.id) {
            forgetMessage();
            return;
          }
          const missing = missingSeeds(row, message.reactions);
          if (missing.size > 0) await seedPollReactions(client, { ...row, ...location }, missing);
          const voters = await fetchVoters(client, { ...row, ...location }, message.reactions);
          // The snapshot began at `now`; a live vote event since then makes it stale.
          raced = recountRaced(row, now);
          if (!raced) applyRecount(db, row, voters, now, now);
        }
        const counts = tallyPoll(db, row);
        const hash = pollCardHash(row, counts);
        if (hash !== row.lastRenderedHash) {
          await editPollMessage(client, { ...row, ...location }, counts);
        }
        updatePoll(db, row, {
          lastRenderedHash: hash,
          accessFailures: 0,
          ...(recounting && !raced ? { lastRecountAt: now } : {}),
          ...(row.accessFailures > 0 ? { nextSyncAt: nextRefresh(row, now) } : {}),
          ...(raced ? { nextSyncAt: now + config.racedRecountRetryMs } : {}),
        });
        return;
      }
    }

    if (row.status === 'closed') {
      const counts = tallyPoll(db, row);
      await editPollMessage(client, { ...row, ...location }, counts);
      updatePoll(db, row, {
        nextSyncAt: null,
        accessFailures: 0,
        lastRenderedHash: pollCardHash(row, counts),
      });
    }
  } catch (error) {
    if (isPollMessageGone(error)) {
      forgetMessage();
      return;
    }
    const accessFailures = row.accessFailures + Number(isPollAccessError(error));
    const backoff = config.accessRetryMs * 2 ** Math.min(accessFailures - 1, 4);
    updatePoll(db, row, {
      accessFailures,
      nextSyncAt:
        accessFailures > 0
          ? now + Math.min(backoff, config.maxAccessRetryMs)
          : Math.min(now + config.retryMs, nextRefresh(row, now)),
    });
    throw error;
  }
}

/** Starts the one-second scan that edits cards, closes expired polls and recounts. */
export function startPolls(client: Client<true>): () => void {
  const { db, logger } = container;
  const inFlight = new Set<string>();
  refreshPendingPolls(db, Date.now());

  const scan = () => {
    const available = config.maxConcurrentSyncs - inFlight.size;
    if (!client.isReady() || available === 0) return;
    try {
      const now = Date.now();
      for (const row of duePolls(db, now, config.maxConcurrentSyncs)) {
        const key = `${row.guildId}:${row.id}`;
        if (inFlight.has(key)) continue;
        if (inFlight.size >= config.maxConcurrentSyncs) break;
        updatePoll(db, row, { nextSyncAt: nextRefresh(row, now) });
        inFlight.add(key);
        void syncPoll(client, db, row, now)
          .catch((error) =>
            logger.warn(`Poll #${row.id} in guild ${row.guildId} sync failed`, error),
          )
          .finally(() => inFlight.delete(key));
      }
    } catch (error) {
      logger.warn('Poll scan failed', error);
    }
  };

  scan();
  const timer = setInterval(scan, config.scanMs);
  timer.unref();
  return () => clearInterval(timer);
}

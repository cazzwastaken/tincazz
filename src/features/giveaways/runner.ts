import { randomInt } from 'node:crypto';
import { container } from '@sapphire/framework';
import type { Client } from 'discord.js';
import type { Db } from '../../db/index.js';
import { giveaway } from './config.js';
import {
  editGiveawayMessage,
  eligibleEntrants,
  entryReaction,
  fetchGiveawayMessage,
  isGiveawayMessageGone,
  seedGiveawayReaction,
} from './discord.js';
import {
  drawGiveaway,
  dueGiveaways,
  type Giveaway,
  refreshPendingGiveaways,
  updateGiveaway,
} from './store.js';

export async function syncGiveaway(client: Client<true>, db: Db, row: Giveaway, now: number) {
  const forgetMessage = () => {
    if (row.status === 'open') updateGiveaway(db, row, { status: 'deleted', nextSyncAt: null });
    else updateGiveaway(db, row, { nextSyncAt: null });
  };

  try {
    const message = await fetchGiveawayMessage(client, row);
    if (message.author.id !== client.user.id) {
      forgetMessage();
      return;
    }

    if (row.status === 'open') {
      const reaction = message.reactions?.find(({ emoji }) => entryReaction(emoji));
      const closing = now >= row.endsAt;
      if (!closing && !reaction?.me) await seedGiveawayReaction(client, row);

      const entrants = await eligibleEntrants(client, row, reaction);
      if (closing) {
        const winner =
          entrants.length === 0 ? null : (entrants[randomInt(entrants.length)] ?? null);
        row = drawGiveaway(db, row, entrants.length, winner, now);
      } else {
        if (row.entryCount !== entrants.length || !message.embeds.length) {
          await editGiveawayMessage(client, row, entrants.length);
          updateGiveaway(db, row, { entryCount: entrants.length });
        }
        return;
      }
    }

    if (row.status === 'ended') {
      await editGiveawayMessage(client, row, row.entryCount ?? 0);
      updateGiveaway(db, row, { nextSyncAt: null });
    }
  } catch (error) {
    if (isGiveawayMessageGone(error)) forgetMessage();
    else {
      updateGiveaway(db, row, { nextSyncAt: nextRefresh(row, now) });
      throw error;
    }
  }
}

function nextRefresh(row: Giveaway, now: number): number {
  const refreshAt = now + giveaway.refreshMs;
  return row.status === 'open' && row.endsAt > now ? Math.min(row.endsAt, refreshAt) : refreshAt;
}

export function startGiveaways(client: Client<true>): () => void {
  const { db, logger } = container;
  const inFlight = new Set<string>();
  refreshPendingGiveaways(db, Date.now());

  const scan = () => {
    const available = giveaway.maxConcurrentSyncs - inFlight.size;
    if (!client.isReady() || available === 0) return;
    try {
      const now = Date.now();
      const due = dueGiveaways(db, now, giveaway.maxConcurrentSyncs)
        .filter((row) => !inFlight.has(row.messageId))
        .slice(0, available);
      for (const row of due) {
        updateGiveaway(db, row, { nextSyncAt: nextRefresh(row, now) });
        inFlight.add(row.messageId);
        void syncGiveaway(client, db, row, now)
          .catch((error) =>
            logger.warn(`Giveaway #${row.id} in guild ${row.guildId} sync failed`, error),
          )
          .finally(() => inFlight.delete(row.messageId));
      }
    } catch (error) {
      logger.warn('Giveaway scan failed', error);
    }
  };

  scan();
  const timer = setInterval(scan, giveaway.scanMs);
  timer.unref();
  return () => clearInterval(timer);
}

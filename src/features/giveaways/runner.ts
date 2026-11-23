import { randomInt } from 'node:crypto';
import { container } from '@sapphire/framework';
import type { Client, RESTGetAPIChannelMessageResult } from 'discord.js';
import type { Db } from '../../db/index.js';
import { giveaway } from './config.js';
import {
  editGiveawayMessage,
  eligibleEntrants,
  entryReaction,
  fetchGiveawayMessage,
  isGiveawayAccessError,
  isGiveawayMessageGone,
  recoverOrPostGiveaway,
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
    updateGiveaway(db, row, {
      status: row.status === 'ended' ? 'ended' : 'deleted',
      nextSyncAt: null,
      accessFailures: 0,
    });
  };

  try {
    if (row.status === 'deleted') return;
    if (row.messageId === null && row.status === 'publishing') {
      const messageId = await recoverOrPostGiveaway(client, row);
      const saved = updateGiveaway(db, row, { messageId });
      if (!saved) return;
      row = saved;
    }
    if (row.messageId === null) throw new Error('Missing giveaway message ID');

    const location = { channelId: row.channelId, messageId: row.messageId };
    const message = await fetchGiveawayMessage(client, location);
    if (message.author.id !== client.user.id) {
      forgetMessage();
      return;
    }

    // An older version could schedule a draw before the placeholder was opened.
    if (row.status === 'open' && message.content === '🎁 Setting up a Tincazz giveaway…') {
      const durationMs = Math.min(
        giveaway.maxDurationMs,
        Math.max(giveaway.minDurationMs, (row.endsAt ?? now) - Date.parse(message.timestamp)),
      );
      const saved = updateGiveaway(db, row, { status: 'publishing', endsAt: null, durationMs });
      if (!saved) return;
      row = saved;
    }

    const reaction = message.reactions?.find(({ emoji }) => entryReaction(emoji));
    if (row.status === 'publishing') {
      let openedAt = publicationTime(message, row.id);
      if (openedAt === null) {
        if (!reaction?.me) await seedGiveawayReaction(client, location);
        const card = await editGiveawayMessage(client, { ...row, ...location }, 0);
        openedAt = publicationTime(card, row.id);
      }
      if (openedAt === null || row.durationMs === null) {
        throw new Error('Missing giveaway publication data');
      }

      updateGiveaway(db, row, {
        status: 'open',
        endsAt: openedAt + row.durationMs,
        nextSyncAt: now,
        accessFailures: 0,
      });
      return;
    }

    if (row.status === 'open') {
      const closing = row.endsAt !== null && now >= row.endsAt;
      if (!closing && !reaction?.me) await seedGiveawayReaction(client, location);
      const entrants = await eligibleEntrants(
        client,
        { ...location, hostId: row.hostId },
        reaction,
      );

      if (!closing) {
        const hasOldDrawLabel = message.embeds.some((embed) =>
          embed.fields?.some((field) => field.name === 'Draws'),
        );
        if (row.entryCount !== entrants.length || !message.embeds.length || hasOldDrawLabel) {
          await editGiveawayMessage(client, { ...row, ...location }, entrants.length);
        }
        if (row.entryCount !== entrants.length || row.accessFailures > 0) {
          updateGiveaway(db, row, {
            entryCount: entrants.length,
            accessFailures: 0,
            ...(row.accessFailures > 0 ? { nextSyncAt: nextRefresh(row, now) } : {}),
          });
        }
        return;
      }

      const winner = entrants.length === 0 ? null : (entrants[randomInt(entrants.length)] ?? null);
      const drawn = drawGiveaway(db, row, entrants.length, winner, now);
      if (!drawn) return;
      row = drawn;
    }

    if (row.status === 'ended') {
      await editGiveawayMessage(client, { ...row, ...location }, row.entryCount ?? 0);
      updateGiveaway(db, row, { nextSyncAt: null, accessFailures: 0 });
    }
  } catch (error) {
    if (isGiveawayMessageGone(error)) {
      forgetMessage();
      return;
    }
    const accessFailures = row.accessFailures + Number(isGiveawayAccessError(error));
    const backoff = giveaway.accessRetryMs * 2 ** Math.min(accessFailures - 1, 4);
    updateGiveaway(db, row, {
      accessFailures,
      nextSyncAt:
        accessFailures > 0
          ? now + Math.min(backoff, giveaway.maxAccessRetryMs)
          : nextRefresh(row, now),
    });
    throw error;
  }
}

function publicationTime(message: RESTGetAPIChannelMessageResult, id: number): number | null {
  if (!message.embeds.some((embed) => embed.footer?.text === `Giveaway #${id}`)) return null;
  const timestamp = Date.parse(message.edited_timestamp ?? '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function nextRefresh(row: Giveaway, now: number): number {
  if (row.status === 'publishing') return now + giveaway.publishRetryMs;
  const refreshAt = now + giveaway.refreshMs;
  return row.status === 'open' && row.endsAt !== null && row.endsAt > now
    ? Math.min(row.endsAt, refreshAt)
    : refreshAt;
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
      const due = dueGiveaways(db, now, giveaway.maxConcurrentSyncs);
      for (const row of due) {
        const key = `${row.guildId}:${row.id}`;
        if (inFlight.has(key)) continue;
        if (inFlight.size >= giveaway.maxConcurrentSyncs) break;
        updateGiveaway(db, row, { nextSyncAt: nextRefresh(row, now) });
        inFlight.add(key);
        void syncGiveaway(client, db, row, now)
          .catch((error) =>
            logger.warn(`Giveaway #${row.id} in guild ${row.guildId} sync failed`, error),
          )
          .finally(() => inFlight.delete(key));
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

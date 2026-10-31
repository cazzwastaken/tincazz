import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { guildGameChannels } from '../../db/schema.js';
import { gameChannels as gameChannelConfig } from './config.js';

/** The channels the games are limited to, oldest first. Empty means every channel. */
export function gameChannels(db: DbOrTx, guildId: string): string[] {
  return db
    .select({ channelId: guildGameChannels.channelId })
    .from(guildGameChannels)
    .where(eq(guildGameChannels.guildId, guildId))
    .orderBy(asc(guildGameChannels.createdAt), asc(guildGameChannels.channelId))
    .all()
    .map((row) => row.channelId);
}

export function addGameChannel(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  now: number,
): 'added' | 'exists' | 'full' {
  const current = gameChannels(db, guildId);
  if (current.includes(channelId)) return 'exists';
  if (current.length >= gameChannelConfig.max) return 'full';
  db.insert(guildGameChannels).values({ guildId, channelId, createdAt: now }).run();
  return 'added';
}

export function removeGameChannel(db: DbOrTx, guildId: string, channelId: string): boolean {
  const result = db
    .delete(guildGameChannels)
    .where(and(eq(guildGameChannels.guildId, guildId), eq(guildGameChannels.channelId, channelId)))
    .run();
  return result.changes > 0;
}

/** Lifts the limit: the games work everywhere again. Returns how many channels were removed. */
export function clearGameChannels(db: DbOrTx, guildId: string): number {
  return db.delete(guildGameChannels).where(eq(guildGameChannels.guildId, guildId)).run().changes;
}

/** Removes a (deleted) channel from every guild and returns the guilds it was listed in. */
export function removeGameChannelEverywhere(db: DbOrTx, channelId: string): string[] {
  const rows = db
    .select({ guildId: guildGameChannels.guildId })
    .from(guildGameChannels)
    .where(eq(guildGameChannels.channelId, channelId))
    .all();
  db.delete(guildGameChannels).where(eq(guildGameChannels.channelId, channelId)).run();
  return rows.map((row) => row.guildId);
}

interface MaybeThread {
  isThread(): boolean;
  parentId?: string | null;
}

/**
 * The reply for playing in a channel the games are not allowed in, or undefined when it is fine.
 * With no limit set every channel is allowed. A thread counts as its parent channel.
 */
export function gameChannelDenied(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  channel?: MaybeThread | null,
): string | undefined {
  const allowed = gameChannels(db, guildId);
  if (allowed.length === 0) return undefined;
  const id = channel?.isThread() && channel.parentId ? channel.parentId : channelId;
  if (allowed.includes(id)) return undefined;
  return `Games can only be played in ${allowed.map((c) => `<#${c}>`).join(', ')}.`;
}

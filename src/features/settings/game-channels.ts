import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { guildGameChannels, guildSettings } from '../../db/schema.js';
import { gameChannels as gameChannelConfig } from './config.js';

/** The channels the games are limited to, oldest first. */
export function gameChannels(db: DbOrTx, guildId: string): string[] {
  return db
    .select({ channelId: guildGameChannels.channelId })
    .from(guildGameChannels)
    .where(eq(guildGameChannels.guildId, guildId))
    .orderBy(asc(guildGameChannels.createdAt), asc(guildGameChannels.channelId))
    .all()
    .map((row) => row.channelId);
}

export function areGameChannelsRestricted(db: DbOrTx, guildId: string): boolean {
  const row = db
    .select({ restricted: guildSettings.gameChannelsRestricted })
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId))
    .get();
  return row?.restricted ?? false;
}

export function addGameChannel(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  now: number,
): 'added' | 'exists' | 'full' {
  return db.transaction((tx) => {
    const current = gameChannels(tx, guildId);
    if (current.includes(channelId)) return 'exists';
    if (current.length >= gameChannelConfig.max) return 'full';
    tx.insert(guildGameChannels).values({ guildId, channelId, createdAt: now }).run();
    if (current.length === 0) {
      tx.insert(guildSettings)
        .values({ guildId, gameChannelsRestricted: true, updatedAt: now })
        .onConflictDoUpdate({
          target: guildSettings.guildId,
          set: { gameChannelsRestricted: true, updatedAt: now },
          setWhere: eq(guildSettings.gameChannelsRestricted, false),
        })
        .run();
    }
    return 'added';
  });
}

export function removeGameChannel(db: DbOrTx, guildId: string, channelId: string): boolean {
  const result = db
    .delete(guildGameChannels)
    .where(and(eq(guildGameChannels.guildId, guildId), eq(guildGameChannels.channelId, channelId)))
    .run();
  return result.changes > 0;
}

/** Lifts the limit, even if the list is empty. Returns whether the games were restricted. */
export function clearGameChannels(db: DbOrTx, guildId: string, now: number): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(guildSettings)
      .set({ gameChannelsRestricted: false, updatedAt: now })
      .where(
        and(eq(guildSettings.guildId, guildId), eq(guildSettings.gameChannelsRestricted, true)),
      )
      .run();
    if (updated.changes === 0) return false;
    tx.delete(guildGameChannels).where(eq(guildGameChannels.guildId, guildId)).run();
    return true;
  });
}

/** Removes a deleted channel and reports which affected guilds have no allowed channels left. */
export function removeGameChannelEverywhere(
  db: DbOrTx,
  channelId: string,
): { guildId: string; paused: boolean }[] {
  const removed = db
    .delete(guildGameChannels)
    .where(eq(guildGameChannels.channelId, channelId))
    .returning({ guildId: guildGameChannels.guildId })
    .all();
  return removed.map(({ guildId }) => ({
    guildId,
    paused:
      db
        .select({ channelId: guildGameChannels.channelId })
        .from(guildGameChannels)
        .where(eq(guildGameChannels.guildId, guildId))
        .get() === undefined,
  }));
}

interface MaybeThread {
  isThread(): boolean;
  parentId?: string | null;
}

/**
 * The reply for playing in a channel the games are not allowed in, or undefined when it is fine.
 * Unrestricted guilds allow every channel. A thread counts as its parent channel.
 */
export function gameChannelDenied(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  channel?: MaybeThread | null,
): string | undefined {
  if (!areGameChannelsRestricted(db, guildId)) return undefined;
  const allowed = gameChannels(db, guildId);
  if (allowed.length === 0) {
    return 'Games are paused because there are no allowed game channels. Ask a server admin to allow one or reset the game channel settings.';
  }
  const id = channel?.isThread() && channel.parentId ? channel.parentId : channelId;
  if (allowed.includes(id)) return undefined;
  return `Games can only be played in ${allowed.map((c) => `<#${c}>`).join(', ')}.`;
}

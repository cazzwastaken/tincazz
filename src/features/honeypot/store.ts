import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { guildSettings } from '../../db/schema.js';

export interface HoneypotState {
  channelId?: string;
  messageId?: string;
  kicks: number;
}

export function honeypot(db: DbOrTx, guildId: string): HoneypotState {
  const row = db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).get();
  return {
    channelId: row?.honeypotChannelId ?? undefined,
    messageId: row?.honeypotMessageId ?? undefined,
    kicks: row?.honeypotKicks ?? 0,
  };
}

function writeHoneypot(
  db: DbOrTx,
  guildId: string,
  channelId: string | null,
  messageId: string | null,
  now: number,
): void {
  db.insert(guildSettings)
    .values({
      guildId,
      honeypotChannelId: channelId,
      honeypotMessageId: messageId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: guildSettings.guildId,
      set: { honeypotChannelId: channelId, honeypotMessageId: messageId, updatedAt: now },
    })
    .run();
}

/** Sets channel + card ID (kicks untouched); returns the previous state. */
export function setHoneypot(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  messageId: string,
  now: number,
): HoneypotState {
  const previous = honeypot(db, guildId);
  writeHoneypot(db, guildId, channelId, messageId, now);
  return previous;
}

/** Stores a re-posted card ID only while the stored channel is still `channelId`. */
export function setHoneypotMessage(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  messageId: string,
  now: number,
): boolean {
  const result = db
    .update(guildSettings)
    .set({ honeypotMessageId: messageId, updatedAt: now })
    .where(and(eq(guildSettings.guildId, guildId), eq(guildSettings.honeypotChannelId, channelId)))
    .run();
  return result.changes > 0;
}

/** Nulls channel and message (kicks kept); returns the previous state. */
export function clearHoneypot(db: DbOrTx, guildId: string, now: number): HoneypotState {
  const previous = honeypot(db, guildId);
  writeHoneypot(db, guildId, null, null, now);
  return previous;
}

/** Atomic `honeypot_kicks = honeypot_kicks + 1` upsert; returns the new total. */
export function incrementKicks(db: DbOrTx, guildId: string, now: number): number {
  const row = db
    .insert(guildSettings)
    .values({ guildId, honeypotKicks: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: guildSettings.guildId,
      set: { honeypotKicks: sql`${guildSettings.honeypotKicks} + 1`, updatedAt: now },
    })
    .returning({ kicks: guildSettings.honeypotKicks })
    .get();
  return row.kicks;
}

/** Clears a deleted channel from every guild; returns the guild IDs it was the honeypot of. */
export function clearHoneypotChannelEverywhere(
  db: DbOrTx,
  channelId: string,
  now: number,
): string[] {
  return db
    .update(guildSettings)
    .set({ honeypotChannelId: null, honeypotMessageId: null, updatedAt: now })
    .where(eq(guildSettings.honeypotChannelId, channelId))
    .returning({ guildId: guildSettings.guildId })
    .all()
    .map((row) => row.guildId);
}

export function isHoneypotChannel(db: DbOrTx, guildId: string, channelId: string): boolean {
  return honeypot(db, guildId).channelId === channelId;
}

export function honeypotGuilds(db: DbOrTx): { guildId: string; channelId: string }[] {
  return db
    .select({ guildId: guildSettings.guildId, channelId: guildSettings.honeypotChannelId })
    .from(guildSettings)
    .all()
    .flatMap((row) =>
      row.channelId === null ? [] : [{ guildId: row.guildId, channelId: row.channelId }],
    );
}

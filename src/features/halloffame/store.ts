import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import {
  guildHallExemptChannels,
  guildSettings,
  type HallStatus,
  hallOfFameEntries,
} from '../../db/schema.js';
import { hallOfFame as config } from './config.js';

export type HallEntry = typeof hallOfFameEntries.$inferSelect;

export interface HallSettings {
  channelId: string | undefined;
  threshold: number;
}

export function hallSettings(db: DbOrTx, guildId: string): HallSettings {
  const row = db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).get();
  return {
    channelId: row?.hallChannelId ?? undefined,
    threshold: row?.hallThreshold ?? config.defaultThreshold,
  };
}

/** Sets (or, with null, clears) the hall channel and returns the previous settings. */
export function setHallChannel(
  db: DbOrTx,
  guildId: string,
  channelId: string | null,
  now: number,
): HallSettings {
  const previous = hallSettings(db, guildId);
  db.insert(guildSettings)
    .values({ guildId, hallChannelId: channelId, updatedAt: now })
    .onConflictDoUpdate({
      target: guildSettings.guildId,
      set: { hallChannelId: channelId, updatedAt: now },
    })
    .run();
  return previous;
}

/** Sets the threshold (the caller validates the range) and returns the previous settings. */
export function setHallThreshold(
  db: DbOrTx,
  guildId: string,
  threshold: number,
  now: number,
): HallSettings {
  const previous = hallSettings(db, guildId);
  db.insert(guildSettings)
    .values({ guildId, hallThreshold: threshold, updatedAt: now })
    .onConflictDoUpdate({
      target: guildSettings.guildId,
      set: { hallThreshold: threshold, updatedAt: now },
    })
    .run();
  return previous;
}

/** Clears a deleted channel as the hall channel of every guild and returns those guilds. */
export function clearHallChannelEverywhere(db: DbOrTx, channelId: string, now: number): string[] {
  return db
    .update(guildSettings)
    .set({ hallChannelId: null, updatedAt: now })
    .where(eq(guildSettings.hallChannelId, channelId))
    .returning({ guildId: guildSettings.guildId })
    .all()
    .map((row) => row.guildId);
}

export function hallExemptChannels(db: DbOrTx, guildId: string): string[] {
  return db
    .select({ channelId: guildHallExemptChannels.channelId })
    .from(guildHallExemptChannels)
    .where(eq(guildHallExemptChannels.guildId, guildId))
    .orderBy(asc(guildHallExemptChannels.createdAt), asc(guildHallExemptChannels.channelId))
    .all()
    .map((row) => row.channelId);
}

export function addHallExempt(
  db: DbOrTx,
  guildId: string,
  channelId: string,
  now: number,
): 'added' | 'exists' | 'full' {
  const current = hallExemptChannels(db, guildId);
  if (current.includes(channelId)) return 'exists';
  if (current.length >= config.maxExemptChannels) return 'full';
  db.insert(guildHallExemptChannels).values({ guildId, channelId, createdAt: now }).run();
  return 'added';
}

export function removeHallExempt(db: DbOrTx, guildId: string, channelId: string): boolean {
  const result = db
    .delete(guildHallExemptChannels)
    .where(
      and(
        eq(guildHallExemptChannels.guildId, guildId),
        eq(guildHallExemptChannels.channelId, channelId),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Removes a deleted channel or category from every exempt list and returns the guilds it was in. */
export function removeExemptEverywhere(db: DbOrTx, channelId: string): string[] {
  return db
    .delete(guildHallExemptChannels)
    .where(eq(guildHallExemptChannels.channelId, channelId))
    .returning({ guildId: guildHallExemptChannels.guildId })
    .all()
    .map((row) => row.guildId);
}

export interface HallClaim {
  guildId: string;
  /** The source message. */
  messageId: string;
  channelId: string;
  authorId: string;
  hallChannelId: string;
}

export type ClaimResult =
  | { kind: 'claimed'; entry: HallEntry }
  | { kind: 'existing'; entry: HallEntry };

export function getHallEntry(
  db: DbOrTx,
  guildId: string,
  messageId: string,
): HallEntry | undefined {
  return db
    .select()
    .from(hallOfFameEntries)
    .where(and(eq(hallOfFameEntries.guildId, guildId), eq(hallOfFameEntries.messageId, messageId)))
    .get();
}

export function getHallEntryByHallMessage(
  db: DbOrTx,
  guildId: string,
  hallMessageId: string,
): HallEntry | undefined {
  return db
    .select()
    .from(hallOfFameEntries)
    .where(
      and(
        eq(hallOfFameEntries.guildId, guildId),
        eq(hallOfFameEntries.hallMessageId, hallMessageId),
      ),
    )
    .get();
}

/**
 * Reserves the one hall post a message may have, before anything is sent. Only one caller ever
 * gets `claimed`; everyone else sees the existing row (a `publishing` claim, a `posted` entry or
 * a `removed` tombstone) and must not post.
 */
export function claimHallEntry(db: DbOrTx, claim: HallClaim, now: number): ClaimResult {
  const inserted = db
    .insert(hallOfFameEntries)
    .values({ ...claim, status: 'publishing', peakCount: 0, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  const entry = getHallEntry(db, claim.guildId, claim.messageId);
  if (!entry) throw new Error('Hall of Fame claim vanished');
  return { kind: inserted.changes > 0 ? 'claimed' : 'existing', entry };
}

/**
 * Records the hall message of a claim that is still `publishing` and marks it posted. Undefined
 * means the claim is gone (the source was deleted mid-post, or recovery released it): the caller
 * owns an unrecorded hall message and must delete it.
 */
export function markHallPosted(
  db: DbOrTx,
  guildId: string,
  messageId: string,
  details: { hallMessageId: string; peakCount: number; renderedHash: string },
  now: number,
): HallEntry | undefined {
  return db
    .update(hallOfFameEntries)
    .set({
      status: 'posted',
      hallMessageId: details.hallMessageId,
      peakCount: sql`max(${hallOfFameEntries.peakCount}, ${details.peakCount})`,
      lastRenderedHash: details.renderedHash,
      updatedAt: now,
    })
    .where(
      and(
        eq(hallOfFameEntries.guildId, guildId),
        eq(hallOfFameEntries.messageId, messageId),
        eq(hallOfFameEntries.status, 'publishing'),
      ),
    )
    .returning()
    .get();
}

/** Drops a claim whose send failed (or was recovered as never sent) so the message can retry. */
export function releaseHallClaim(db: DbOrTx, guildId: string, messageId: string): boolean {
  const result = db
    .delete(hallOfFameEntries)
    .where(
      and(
        eq(hallOfFameEntries.guildId, guildId),
        eq(hallOfFameEntries.messageId, messageId),
        eq(hallOfFameEntries.status, 'publishing'),
      ),
    )
    .run();
  return result.changes > 0;
}

/**
 * Raises the peak of a posted entry to `count` (never lowers it) and returns the row as it is
 * now, which is what the card must render. Undefined when the entry is not posted.
 */
export function bumpHallPeak(
  db: DbOrTx,
  guildId: string,
  messageId: string,
  count: number,
  now: number,
): HallEntry | undefined {
  return db
    .update(hallOfFameEntries)
    .set({ peakCount: sql`max(${hallOfFameEntries.peakCount}, ${count})`, updatedAt: now })
    .where(
      and(
        eq(hallOfFameEntries.guildId, guildId),
        eq(hallOfFameEntries.messageId, messageId),
        eq(hallOfFameEntries.status, 'posted'),
      ),
    )
    .returning()
    .get();
}

export function setHallRenderedHash(
  db: DbOrTx,
  guildId: string,
  messageId: string,
  renderedHash: string,
  now: number,
): boolean {
  const result = db
    .update(hallOfFameEntries)
    .set({ lastRenderedHash: renderedHash, updatedAt: now })
    .where(
      and(
        eq(hallOfFameEntries.guildId, guildId),
        eq(hallOfFameEntries.messageId, messageId),
        eq(hallOfFameEntries.status, 'posted'),
      ),
    )
    .run();
  return result.changes > 0;
}

/**
 * Turns posted entries whose hall message was deleted into tombstones, so the source is never
 * posted again, and returns them. Rows deleted first (the source went away) are not found.
 */
export function markHallMessagesRemoved(
  db: DbOrTx,
  hallMessageIds: string[],
  now: number,
): HallEntry[] {
  if (hallMessageIds.length === 0) return [];
  return db
    .update(hallOfFameEntries)
    .set({ status: 'removed', updatedAt: now })
    .where(
      and(
        inArray(hallOfFameEntries.hallMessageId, hallMessageIds),
        eq(hallOfFameEntries.status, 'posted'),
      ),
    )
    .returning()
    .all();
}

/**
 * Deletes the entry of a deleted source message and returns it. Delete the hall message only
 * after this returns a `posted` row, so the hall message's own delete event finds no row.
 */
export function deleteHallEntry(
  db: DbOrTx,
  guildId: string,
  messageId: string,
): HallEntry | undefined {
  return db
    .delete(hallOfFameEntries)
    .where(and(eq(hallOfFameEntries.guildId, guildId), eq(hallOfFameEntries.messageId, messageId)))
    .returning()
    .get();
}

/** Same as {@link deleteHallEntry} for a bulk delete. */
export function deleteHallEntries(db: DbOrTx, guildId: string, messageIds: string[]): HallEntry[] {
  if (messageIds.length === 0) return [];
  return db
    .delete(hallOfFameEntries)
    .where(
      and(eq(hallOfFameEntries.guildId, guildId), inArray(hallOfFameEntries.messageId, messageIds)),
    )
    .returning()
    .all();
}

/** Deletes the entries of a deleted source channel or thread and returns them. */
export function deleteHallEntriesBySourceChannel(db: DbOrTx, channelId: string): HallEntry[] {
  return db
    .delete(hallOfFameEntries)
    .where(eq(hallOfFameEntries.channelId, channelId))
    .returning()
    .all();
}

/** Deletes the entries that live in a deleted hall channel; their messages went with it. */
export function deleteHallEntriesByHallChannel(db: DbOrTx, hallChannelId: string): HallEntry[] {
  return db
    .delete(hallOfFameEntries)
    .where(eq(hallOfFameEntries.hallChannelId, hallChannelId))
    .returning()
    .all();
}

/**
 * Claims still `publishing` that were made before `olderThan`: a crash or a failed cleanup left
 * them. The runner looks for the hall message in the hall channel before it releases one, so a
 * message that was sent but never recorded is adopted instead of posted twice.
 */
export function abandonedHallClaims(db: DbOrTx, olderThan: number): HallEntry[] {
  return db
    .select()
    .from(hallOfFameEntries)
    .where(
      and(
        eq(hallOfFameEntries.status, 'publishing' satisfies HallStatus),
        lt(hallOfFameEntries.createdAt, olderThan),
      ),
    )
    .orderBy(asc(hallOfFameEntries.createdAt))
    .all();
}

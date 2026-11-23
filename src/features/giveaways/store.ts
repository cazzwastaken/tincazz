import { and, asc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { giveaways } from '../../db/schema.js';
import { giveaway } from './config.js';

export type Giveaway = typeof giveaways.$inferSelect;

export function saveGiveaway(
  db: Db,
  details: Pick<Giveaway, 'guildId' | 'channelId' | 'messageId' | 'hostId' | 'prize' | 'endsAt'>,
  now: number,
): Giveaway {
  const row = db
    .insert(giveaways)
    .values({
      ...details,
      id: sql<number>`(select coalesce(max(${giveaways.id}), 0) + 1 from ${giveaways} where ${giveaways.guildId} = ${details.guildId})`,
      nextSyncAt: now,
    })
    .onConflictDoNothing({ target: giveaways.messageId })
    .returning()
    .get();
  const saved =
    row ?? db.select().from(giveaways).where(eq(giveaways.messageId, details.messageId)).get();
  if (!saved) throw new Error('Could not persist the giveaway post');
  return saved;
}

export function requestGiveawayRefresh(
  db: Db,
  guildId: string,
  messageId: string,
  now: number,
): void {
  const nextSyncAt = now + giveaway.debounceMs;
  db.update(giveaways)
    .set({ nextSyncAt })
    .where(
      and(
        eq(giveaways.messageId, messageId),
        eq(giveaways.guildId, guildId),
        eq(giveaways.status, 'open'),
        gt(giveaways.nextSyncAt, nextSyncAt),
      ),
    )
    .run();
}

export function dueGiveaways(db: Db, now: number, limit: number): Giveaway[] {
  return db
    .select()
    .from(giveaways)
    .where(lte(giveaways.nextSyncAt, now))
    .orderBy(asc(giveaways.nextSyncAt), asc(giveaways.messageId))
    .limit(limit)
    .all();
}

export function updateGiveaway(
  db: Db,
  row: Giveaway,
  changes: Partial<Pick<Giveaway, 'status' | 'entryCount' | 'nextSyncAt'>>,
): void {
  db.update(giveaways)
    .set(changes)
    .where(and(eq(giveaways.messageId, row.messageId), eq(giveaways.status, row.status)))
    .run();
}

export function drawGiveaway(
  db: Db,
  row: Giveaway,
  entryCount: number,
  winnerId: string | null,
  now: number,
): Giveaway {
  return (
    db
      .update(giveaways)
      .set({ status: 'ended', entryCount, winnerId, drawnAt: now, nextSyncAt: now })
      .where(
        and(
          eq(giveaways.messageId, row.messageId),
          eq(giveaways.status, 'open'),
          lte(giveaways.endsAt, now),
        ),
      )
      .returning()
      .get() ??
    db.select().from(giveaways).where(eq(giveaways.messageId, row.messageId)).get() ??
    row
  );
}

export function refreshPendingGiveaways(db: Db, now: number): void {
  db.update(giveaways).set({ nextSyncAt: now }).where(isNotNull(giveaways.nextSyncAt)).run();
}

export function activeGiveaways(db: Db, guildId: string): Giveaway[] {
  return db
    .select()
    .from(giveaways)
    .where(and(eq(giveaways.guildId, guildId), eq(giveaways.status, 'open')))
    .orderBy(asc(giveaways.endsAt), asc(giveaways.id))
    .all();
}

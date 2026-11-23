import { and, asc, eq, gt, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { giveaways } from '../../db/schema.js';
import { giveaway } from './config.js';

export type Giveaway = typeof giveaways.$inferSelect;

type Creation = Pick<Giveaway, 'guildId' | 'channelId' | 'hostId' | 'prize'> & {
  creationId: string;
  durationMs: number;
};

export function queueGiveaway(db: Db, details: Creation, now: number): Giveaway {
  const row = db
    .insert(giveaways)
    .values({
      ...details,
      id: sql<number>`(select coalesce(max(${giveaways.id}), 0) + 1 from ${giveaways} where ${giveaways.guildId} = ${details.guildId})`,
      status: 'publishing',
      nextSyncAt: now,
    })
    .onConflictDoNothing({ target: giveaways.creationId })
    .returning()
    .get();
  const saved =
    row ?? db.select().from(giveaways).where(eq(giveaways.creationId, details.creationId)).get();
  if (!saved) throw new Error('Could not queue the giveaway');
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
        eq(giveaways.accessFailures, 0),
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
    .orderBy(
      sql`case when ${giveaways.status} = 'open' and ${giveaways.endsAt} <= ${now} then 0 else 1 end`,
      asc(giveaways.nextSyncAt),
      asc(giveaways.guildId),
      asc(giveaways.id),
    )
    .limit(limit)
    .all();
}

function identity(row: Giveaway) {
  return and(eq(giveaways.guildId, row.guildId), eq(giveaways.id, row.id));
}

type Changes = Partial<
  Pick<
    Giveaway,
    | 'status'
    | 'entryCount'
    | 'nextSyncAt'
    | 'accessFailures'
    | 'messageId'
    | 'endsAt'
    | 'durationMs'
  >
>;

export function updateGiveaway(db: Db, row: Giveaway, changes: Changes): Giveaway | undefined {
  return db
    .update(giveaways)
    .set(changes)
    .where(and(identity(row), eq(giveaways.status, row.status)))
    .returning()
    .get();
}

export function drawGiveaway(
  db: Db,
  row: Giveaway,
  entryCount: number,
  winnerId: string | null,
  now: number,
): Giveaway | undefined {
  return db
    .update(giveaways)
    .set({
      status: 'ended',
      entryCount,
      winnerId,
      drawnAt: now,
      nextSyncAt: now,
      accessFailures: 0,
    })
    .where(and(identity(row), eq(giveaways.status, 'open'), lte(giveaways.endsAt, now)))
    .returning()
    .get();
}

export function refreshPendingGiveaways(db: Db, now: number): void {
  db.update(giveaways)
    .set({ nextSyncAt: now })
    .where(and(isNotNull(giveaways.nextSyncAt), eq(giveaways.accessFailures, 0)))
    .run();
}

export function activeGiveaways(db: Db, guildId: string): Giveaway[] {
  return db
    .select()
    .from(giveaways)
    .where(
      and(
        eq(giveaways.guildId, guildId),
        or(
          eq(giveaways.status, 'open'),
          and(ne(giveaways.status, 'deleted'), gt(giveaways.accessFailures, 0)),
        ),
      ),
    )
    .orderBy(asc(giveaways.endsAt), asc(giveaways.id))
    .all();
}

export function cancelGiveawayPosts(db: Db, guildId: string, messageIds: string[]): void {
  db.update(giveaways)
    .set({ status: 'deleted', nextSyncAt: null, accessFailures: 0 })
    .where(
      and(
        eq(giveaways.guildId, guildId),
        inArray(giveaways.messageId, messageIds),
        inArray(giveaways.status, ['publishing', 'open']),
      ),
    )
    .run();
}

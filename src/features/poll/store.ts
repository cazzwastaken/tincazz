import { and, asc, eq, gt, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/index.js';
import { polls, pollVotes } from '../../db/schema.js';
import { poll as config, yesNoOptions } from './config.js';
import type { Poll } from './types.js';

export type { Poll } from './types.js';

export interface PollCreation {
  guildId: string;
  channelId: string;
  hostId: string;
  question: string;
  /** Undefined for a yes/no poll. */
  options: readonly string[] | undefined;
  anonymous: boolean;
  durationMs: number;
  /** Idempotency key, such as the interaction or message ID. */
  creationId: string;
}

export type QueuedPoll =
  | { kind: 'queued' | 'existing'; poll: Poll }
  | { kind: 'cap'; open: Poll[] };

const slotStatuses = ['publishing', 'open'] as const;

/** The polls that count against a host's cap, soonest to expire first. */
export function openPollsByHost(db: Db, guildId: string, hostId: string): Poll[] {
  return db
    .select()
    .from(polls)
    .where(
      and(
        eq(polls.guildId, guildId),
        eq(polls.hostId, hostId),
        inArray(polls.status, slotStatuses),
      ),
    )
    .orderBy(asc(polls.endsAt), asc(polls.id))
    .all();
}

/**
 * Reserves a poll row (`publishing`) unless the host is at the cap. The cap check and the insert
 * share one transaction, so concurrent creations cannot overshoot it. Repeating a `creationId`
 * returns the row it created.
 */
export function queuePoll(db: Db, details: PollCreation, now: number): QueuedPoll {
  return db.transaction((tx) => {
    const existing = tx.select().from(polls).where(eq(polls.creationId, details.creationId)).get();
    if (existing) return { kind: 'existing', poll: existing };

    const open = tx
      .select()
      .from(polls)
      .where(
        and(
          eq(polls.guildId, details.guildId),
          eq(polls.hostId, details.hostId),
          inArray(polls.status, slotStatuses),
        ),
      )
      .orderBy(asc(polls.endsAt), asc(polls.id))
      .all();
    if (open.length >= config.maxOpenPerHost) return { kind: 'cap', open };

    const saved = tx
      .insert(polls)
      .values({
        id: sql<number>`(select coalesce(max(${polls.id}), 0) + 1 from ${polls} where ${polls.guildId} = ${details.guildId})`,
        guildId: details.guildId,
        channelId: details.channelId,
        creationId: details.creationId,
        hostId: details.hostId,
        question: details.question,
        options: [...(details.options ?? yesNoOptions)],
        yesNo: details.options === undefined,
        anonymous: details.anonymous,
        endsAt: now + details.durationMs,
        status: 'publishing',
      })
      .returning()
      .get();
    return { kind: 'queued', poll: saved };
  });
}

export function getPoll(db: Db, guildId: string, id: number): Poll | undefined {
  return db
    .select()
    .from(polls)
    .where(and(eq(polls.guildId, guildId), eq(polls.id, id)))
    .get();
}

export function getPollByMessage(db: DbOrTx, guildId: string, messageId: string): Poll | undefined {
  return db
    .select()
    .from(polls)
    .where(and(eq(polls.guildId, guildId), eq(polls.messageId, messageId)))
    .get();
}

const identity = (row: Poll) => and(eq(polls.guildId, row.guildId), eq(polls.id, row.id));

type Changes = Partial<
  Pick<
    Poll,
    'status' | 'messageId' | 'nextSyncAt' | 'accessFailures' | 'lastRenderedHash' | 'lastRecountAt'
  >
>;

/** Applies `changes` only while the row is still in the status the caller saw. */
export function updatePoll(db: Db, row: Poll, changes: Changes): Poll | undefined {
  return db
    .update(polls)
    .set(changes)
    .where(and(identity(row), eq(polls.status, row.status)))
    .returning()
    .get();
}

/** Removes a poll that never finished publishing, which frees the host's slot. */
export function discardPoll(db: DbOrTx, row: Pick<Poll, 'guildId' | 'id'>): boolean {
  return db.transaction((tx) => {
    const where = and(
      eq(polls.guildId, row.guildId),
      eq(polls.id, row.id),
      eq(polls.status, 'publishing'),
    );
    const removed = tx.delete(polls).where(where).returning({ id: polls.id }).get();
    if (!removed) return false;
    tx.delete(pollVotes)
      .where(and(eq(pollVotes.guildId, row.guildId), eq(pollVotes.pollId, row.id)))
      .run();
    return true;
  });
}

function openPollForMessage(db: DbOrTx, guildId: string, messageId: string, now: number) {
  const found = getPollByMessage(db, guildId, messageId);
  return found && found.status === 'open' && found.endsAt > now ? found : undefined;
}

export interface CastVote {
  poll: Poll;
  /** The option this voter had chosen before, if any. Equal to the new one for a repeat. */
  previous: number | undefined;
}

/** Records or moves a vote (the latest reaction wins). Undefined if the poll is not open. */
export function castVote(
  db: Db,
  guildId: string,
  messageId: string,
  userId: string,
  optionIndex: number,
  now: number,
): CastVote | undefined {
  const result = db.transaction((tx): CastVote | undefined => {
    const found = openPollForMessage(tx, guildId, messageId, now);
    if (!found || optionIndex < 0 || optionIndex >= found.options.length) return undefined;
    const previous = tx
      .select({ optionIndex: pollVotes.optionIndex })
      .from(pollVotes)
      .where(
        and(
          eq(pollVotes.guildId, guildId),
          eq(pollVotes.pollId, found.id),
          eq(pollVotes.userId, userId),
        ),
      )
      .get()?.optionIndex;
    tx.insert(pollVotes)
      .values({ guildId, pollId: found.id, userId, optionIndex, votedAt: now })
      .onConflictDoUpdate({
        target: [pollVotes.guildId, pollVotes.pollId, pollVotes.userId],
        set: { optionIndex, votedAt: now },
      })
      .run();
    return { poll: found, previous };
  });
  if (result) requestPollRefresh(db, guildId, messageId, now);
  return result;
}

/**
 * Drops a vote only if it is still for `optionIndex`. The bot removes a voter's old reaction when
 * they switch, and that removal must not wipe the new vote.
 */
export function clearVote(
  db: Db,
  guildId: string,
  messageId: string,
  userId: string,
  optionIndex: number,
  now: number,
): boolean {
  const found = openPollForMessage(db, guildId, messageId, now);
  if (!found) return false;
  const removed = db
    .delete(pollVotes)
    .where(
      and(
        eq(pollVotes.guildId, guildId),
        eq(pollVotes.pollId, found.id),
        eq(pollVotes.userId, userId),
        eq(pollVotes.optionIndex, optionIndex),
      ),
    )
    .returning({ userId: pollVotes.userId })
    .get();
  if (removed) requestPollRefresh(db, guildId, messageId, now);
  return removed !== undefined;
}

/** Clears every vote for one option (the emoji was removed for everyone). */
export function clearOptionVotes(
  db: Db,
  guildId: string,
  messageId: string,
  optionIndex: number,
  now: number,
): number {
  const found = openPollForMessage(db, guildId, messageId, now);
  if (!found) return 0;
  const removed = db
    .delete(pollVotes)
    .where(
      and(
        eq(pollVotes.guildId, guildId),
        eq(pollVotes.pollId, found.id),
        eq(pollVotes.optionIndex, optionIndex),
      ),
    )
    .returning({ userId: pollVotes.userId })
    .all().length;
  if (removed > 0) requestPollRefresh(db, guildId, messageId, now);
  return removed;
}

/** Clears every vote (all reactions were removed from the message). */
export function clearAllVotes(db: Db, guildId: string, messageId: string, now: number): number {
  const found = openPollForMessage(db, guildId, messageId, now);
  if (!found) return 0;
  const removed = db
    .delete(pollVotes)
    .where(and(eq(pollVotes.guildId, guildId), eq(pollVotes.pollId, found.id)))
    .returning({ userId: pollVotes.userId })
    .all().length;
  if (removed > 0) requestPollRefresh(db, guildId, messageId, now);
  return removed;
}

/** Votes per option, read from the database. */
export function tallyPoll(db: Db, row: Pick<Poll, 'guildId' | 'id' | 'options'>): number[] {
  const counts = row.options.map(() => 0);
  const rows = db
    .select({ optionIndex: pollVotes.optionIndex, votes: sql<number>`count(*)` })
    .from(pollVotes)
    .where(and(eq(pollVotes.guildId, row.guildId), eq(pollVotes.pollId, row.id)))
    .groupBy(pollVotes.optionIndex)
    .all();
  for (const { optionIndex, votes } of rows) {
    if (optionIndex >= 0 && optionIndex < counts.length) counts[optionIndex] = votes;
  }
  return counts;
}

/** Schedules an edit after the debounce window; later requests inside it coalesce. */
export function requestPollRefresh(db: Db, guildId: string, messageId: string, now: number): void {
  const nextSyncAt = now + config.debounceMs;
  db.update(polls)
    .set({ nextSyncAt })
    .where(
      and(
        eq(polls.messageId, messageId),
        eq(polls.guildId, guildId),
        eq(polls.status, 'open'),
        eq(polls.accessFailures, 0),
        gt(polls.nextSyncAt, nextSyncAt),
      ),
    )
    .run();
}

/** Rows to sync now: scheduled ones, and open polls past their end whatever the backoff says. */
export function duePolls(db: Db, now: number, limit: number): Poll[] {
  return db
    .select()
    .from(polls)
    .where(or(lte(polls.nextSyncAt, now), and(eq(polls.status, 'open'), lte(polls.endsAt, now))))
    .orderBy(
      sql`case when ${polls.status} = 'open' and ${polls.endsAt} <= ${now} then 0 else 1 end`,
      asc(polls.nextSyncAt),
      asc(polls.guildId),
      asc(polls.id),
    )
    .limit(limit)
    .all();
}

/** Closes a poll at its end time. Atomic: only an open poll that is actually due closes. */
export function closeDuePoll(db: Db, row: Poll, now: number): Poll | undefined {
  return db
    .update(polls)
    .set({
      status: 'closed',
      closedAt: now,
      nextSyncAt: now,
      accessFailures: 0,
      lastRenderedHash: null,
    })
    .where(and(identity(row), eq(polls.status, 'open'), lte(polls.endsAt, now)))
    .returning()
    .get();
}

/** Closes an open poll early on behalf of `closedBy`. Undefined if it is not open any more. */
export function closePollEarly(
  db: Db,
  guildId: string,
  id: number,
  closedBy: string,
  now: number,
): Poll | undefined {
  return db
    .update(polls)
    .set({
      status: 'closed',
      closedBy,
      closedAt: now,
      nextSyncAt: now,
      accessFailures: 0,
      lastRenderedHash: null,
    })
    .where(and(eq(polls.guildId, guildId), eq(polls.id, id), eq(polls.status, 'open')))
    .returning()
    .get();
}

/** Marks polls whose message was deleted, which frees their hosts' slots. */
export function markPollMessagesDeleted(db: Db, guildId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  db.update(polls)
    .set({ status: 'deleted', nextSyncAt: null, accessFailures: 0 })
    .where(
      and(
        eq(polls.guildId, guildId),
        inArray(polls.messageId, messageIds),
        inArray(polls.status, slotStatuses),
      ),
    )
    .run();
}

/** Marks every poll in a deleted channel. */
export function markPollChannelDeleted(db: Db, guildId: string, channelId: string): void {
  db.update(polls)
    .set({ status: 'deleted', nextSyncAt: null, accessFailures: 0 })
    .where(
      and(
        eq(polls.guildId, guildId),
        eq(polls.channelId, channelId),
        inArray(polls.status, slotStatuses),
      ),
    )
    .run();
}

/**
 * At startup: schedules every pending row (open polls also get a full recount, since reactions
 * may have changed while offline), resumes `publishing` rows that have a message and discards
 * the ones that never got one.
 */
export function refreshPendingPolls(db: Db, now: number): void {
  db.transaction((tx) => {
    const orphans = tx
      .select()
      .from(polls)
      .where(and(eq(polls.status, 'publishing'), sql`${polls.messageId} is null`))
      .all();
    for (const orphan of orphans) discardPoll(tx, orphan);

    tx.update(polls).set({ lastRecountAt: null }).where(eq(polls.status, 'open')).run();
    tx.update(polls)
      .set({ nextSyncAt: now })
      .where(
        or(
          and(isNotNull(polls.nextSyncAt), eq(polls.accessFailures, 0)),
          eq(polls.status, 'publishing'),
        ),
      )
      .run();
  });
}

/**
 * Reconciles stored votes with who reacted on Discord (bots already excluded). A voter whose
 * reaction is gone loses the vote; a voter still reacting elsewhere is moved there; a reactor
 * without a vote gets one. Returns whether anything changed.
 */
export function applyRecount(
  db: Db,
  row: Poll,
  reactions: ReadonlyMap<number, ReadonlySet<string>>,
  now: number,
): boolean {
  return db.transaction((tx) => {
    const current = tx.select({ status: polls.status }).from(polls).where(identity(row)).get();
    if (current?.status !== 'open') return false;

    const choices = new Map<string, number[]>();
    for (const [index, users] of [...reactions].sort(([a], [b]) => a - b)) {
      if (index < 0 || index >= row.options.length) continue;
      for (const user of users) choices.set(user, [...(choices.get(user) ?? []), index]);
    }

    const where = and(eq(pollVotes.guildId, row.guildId), eq(pollVotes.pollId, row.id));
    const stored = tx.select().from(pollVotes).where(where).all();
    let changed = false;
    for (const vote of stored) {
      const picks = choices.get(vote.userId);
      if (!picks) {
        tx.delete(pollVotes)
          .where(and(where, eq(pollVotes.userId, vote.userId)))
          .run();
        changed = true;
      } else if (!picks.includes(vote.optionIndex)) {
        tx.update(pollVotes)
          .set({ optionIndex: picks[0] ?? 0, votedAt: now })
          .where(and(where, eq(pollVotes.userId, vote.userId)))
          .run();
        changed = true;
      }
    }
    const known = new Set(stored.map((vote) => vote.userId));
    for (const [userId, picks] of choices) {
      if (known.has(userId)) continue;
      tx.insert(pollVotes)
        .values({
          guildId: row.guildId,
          pollId: row.id,
          userId,
          optionIndex: picks[0] ?? 0,
          votedAt: now,
        })
        .run();
      changed = true;
    }
    return changed;
  });
}

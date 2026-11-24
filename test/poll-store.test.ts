import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { pollVotes } from '../src/db/schema.js';
import { poll } from '../src/features/poll/config.js';
import {
  applyRecount,
  castVote,
  clearAllVotes,
  clearOptionVotes,
  clearVote,
  closeDuePoll,
  closePollEarly,
  discardPoll,
  duePolls,
  getPoll,
  markPollChannelDeleted,
  markPollMessagesDeleted,
  openPollsByHost,
  type PollCreation,
  queuePoll,
  recountRaced,
  refreshPendingPolls,
  requestPollRefresh,
  tallyPoll,
  updatePoll,
} from '../src/features/poll/store.js';
import { openPoll } from './support/polls.js';

const now = Date.UTC(2026, 10, 24);
const hour = 3_600_000;

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => closeDatabase(db));

const details = (over: Partial<PollCreation> = {}): PollCreation => ({
  guildId: '10',
  channelId: '20',
  hostId: '2',
  question: 'Dinner?',
  options: undefined,
  anonymous: false,
  durationMs: hour,
  creationId: 'c1',
  ...over,
});

function pollWithOptions() {
  return openPoll(db, { options: ['Tacos', 'Pizza', 'Sushi'], endsAt: now + hour, now });
}

describe('queuePoll', () => {
  it('creates a publishing yes/no poll with per-guild ids', () => {
    const first = queuePoll(db, details(), now);
    expect(first).toMatchObject({
      kind: 'queued',
      poll: {
        id: 1,
        status: 'publishing',
        yesNo: true,
        options: ['Yes', 'No'],
        endsAt: now + hour,
      },
    });
    const second = queuePoll(db, details({ creationId: 'c2', hostId: '3' }), now);
    const other = queuePoll(db, details({ creationId: 'c3', guildId: '11' }), now);
    expect(second).toMatchObject({ poll: { id: 2 } });
    expect(other).toMatchObject({ poll: { id: 1 } });
  });

  it('stores custom options', () => {
    const queued = queuePoll(db, details({ options: ['a', 'b', 'c'] }), now);
    expect(queued).toMatchObject({ poll: { yesNo: false, options: ['a', 'b', 'c'] } });
  });

  it('is idempotent on creationId', () => {
    const first = queuePoll(db, details(), now);
    const again = queuePoll(db, details(), now + 5);
    expect(again.kind).toBe('existing');
    expect(again.kind === 'existing' && first.kind === 'queued' && again.poll.id).toBe(1);
    expect(openPollsByHost(db, '10', '2')).toHaveLength(1);
  });

  it('refuses a fourth open poll and lists the open ones soonest first', () => {
    for (const [index, duration] of [3, 1, 2].entries()) {
      queuePoll(db, details({ creationId: `c${index}`, durationMs: duration * hour }), now);
    }
    const refused = queuePoll(db, details({ creationId: 'c9' }), now);
    expect(refused.kind).toBe('cap');
    if (refused.kind === 'cap') {
      expect(refused.open.map((row) => row.endsAt)).toEqual([1, 2, 3].map((n) => now + n * hour));
    }
    expect(poll.maxOpenPerHost).toBe(3);
    expect(openPollsByHost(db, '10', '2')).toHaveLength(3);
  });

  it('counts per host and per guild', () => {
    for (let i = 0; i < 3; i++) queuePoll(db, details({ creationId: `a${i}` }), now);
    expect(queuePoll(db, details({ creationId: 'x', hostId: '3' }), now).kind).toBe('queued');
    expect(queuePoll(db, details({ creationId: 'y', guildId: '11' }), now).kind).toBe('queued');
  });

  it('frees the slot when a poll closes early, expires, is deleted or discarded', () => {
    const rows = [0, 1, 2].map((i) => {
      const queued = queuePoll(db, details({ creationId: `c${i}`, durationMs: hour }), now);
      if (queued.kind === 'cap') throw new Error('cap');
      return queued.poll;
    });
    rows.forEach((row, i) => {
      updatePoll(db, row, { status: 'open', messageId: `m${i}` });
    });
    expect(queuePoll(db, details({ creationId: 'n1' }), now).kind).toBe('cap');

    expect(closePollEarly(db, '10', rows[0]?.id ?? 0, '2', now + 1)).toBeDefined();
    expect(queuePoll(db, details({ creationId: 'n2' }), now).kind).toBe('queued');
    expect(queuePoll(db, details({ creationId: 'n3' }), now).kind).toBe('cap');

    const second = getPoll(db, '10', rows[1]?.id ?? 0);
    expect(second && closeDuePoll(db, second, now + hour)).toBeDefined();
    expect(queuePoll(db, details({ creationId: 'n4' }), now).kind).toBe('queued');
    expect(queuePoll(db, details({ creationId: 'n5' }), now).kind).toBe('cap');

    markPollMessagesDeleted(db, '10', ['m2']);
    const fresh = queuePoll(db, details({ creationId: 'n6' }), now);
    expect(fresh.kind).toBe('queued');
    expect(queuePoll(db, details({ creationId: 'n7' }), now).kind).toBe('cap');

    if (fresh.kind === 'queued') expect(discardPoll(db, fresh.poll)).toBe(true);
    expect(queuePoll(db, details({ creationId: 'n8' }), now).kind).toBe('queued');
  });

  it('never reuses the id of a discarded poll', () => {
    const first = queuePoll(db, details({ creationId: 'r1' }), now);
    if (first.kind !== 'queued') throw new Error('queue');
    expect(discardPoll(db, first.poll)).toBe(true);
    expect(getPoll(db, '10', first.poll.id)).toMatchObject({ status: 'deleted', messageId: null });
    const second = queuePoll(db, details({ creationId: 'r2' }), now);
    expect(second.kind === 'queued' && second.poll.id).toBeGreaterThan(first.poll.id);
  });

  it('does not discard a poll that is already open', () => {
    const row = pollWithOptions();
    expect(discardPoll(db, row)).toBe(false);
    expect(getPoll(db, '10', row.id)).toBeDefined();
  });
});

describe('votes', () => {
  it('records a vote and tallies from the database', () => {
    const row = pollWithOptions();
    expect(castVote(db, '10', '30', 'u1', 0, now)).toMatchObject({ previous: undefined });
    castVote(db, '10', '30', 'u2', 0, now);
    castVote(db, '10', '30', 'u3', 2, now);
    expect(tallyPoll(db, row)).toEqual([2, 0, 1]);
  });

  it('moves a vote when the voter switches (latest wins)', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'u1', 0, now);
    expect(castVote(db, '10', '30', 'u1', 1, now + 1)).toMatchObject({ previous: 0 });
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
    expect(castVote(db, '10', '30', 'u1', 1, now + 2)).toMatchObject({ previous: 1 });
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
  });

  it('ignores unknown messages, bad options, closed and expired polls', () => {
    const row = pollWithOptions();
    expect(castVote(db, '10', 'nope', 'u1', 0, now)).toBeUndefined();
    expect(castVote(db, '99', '30', 'u1', 0, now)).toBeUndefined();
    expect(castVote(db, '10', '30', 'u1', 3, now)).toBeUndefined();
    expect(castVote(db, '10', '30', 'u1', -1, now)).toBeUndefined();
    expect(castVote(db, '10', '30', 'u1', 0, now + hour)).toBeUndefined();
    closePollEarly(db, '10', row.id, '2', now + 1);
    expect(castVote(db, '10', '30', 'u1', 0, now + 2)).toBeUndefined();
    expect(tallyPoll(db, row)).toEqual([0, 0, 0]);
  });

  it('clears a vote only when the stored option matches (the bot removal trap)', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'u1', 0, now);
    castVote(db, '10', '30', 'u1', 1, now + 1);
    // The bot removes the stale option-0 reaction, which Discord reports as a removal.
    expect(clearVote(db, '10', '30', 'u1', 0, now + 2)).toBe(false);
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
    expect(clearVote(db, '10', '30', 'u1', 1, now + 3)).toBe(true);
    expect(tallyPoll(db, row)).toEqual([0, 0, 0]);
    expect(clearVote(db, '10', '30', 'u1', 1, now + 4)).toBe(false);
  });

  it('clears one option or everything', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'u1', 0, now);
    castVote(db, '10', '30', 'u2', 0, now);
    castVote(db, '10', '30', 'u3', 1, now);
    expect(clearOptionVotes(db, '10', '30', 0, now)).toBe(2);
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
    expect(clearAllVotes(db, '10', '30', now)).toBe(1);
    expect(tallyPoll(db, row)).toEqual([0, 0, 0]);
    expect(clearAllVotes(db, '10', '30', now)).toBe(0);
  });

  it('keeps votes after the poll closes', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'u1', 2, now);
    closePollEarly(db, '10', row.id, '2', now + 1);
    expect(tallyPoll(db, row)).toEqual([0, 0, 1]);
    expect(clearAllVotes(db, '10', '30', now + 2)).toBe(0);
  });
});

describe('refresh and close', () => {
  it('debounces refreshes and never postpones one', () => {
    const row = pollWithOptions();
    updatePoll(db, row, { nextSyncAt: now + poll.recountMs });
    requestPollRefresh(db, '10', '30', now);
    expect(getPoll(db, '10', row.id)?.nextSyncAt).toBe(now + poll.debounceMs);
    requestPollRefresh(db, '10', '30', now + 1000);
    expect(getPoll(db, '10', row.id)?.nextSyncAt).toBe(now + poll.debounceMs);
  });

  it('does not refresh while access is failing', () => {
    const row = pollWithOptions();
    updatePoll(db, row, { nextSyncAt: now + poll.recountMs, accessFailures: 2 });
    requestPollRefresh(db, '10', '30', now);
    expect(getPoll(db, '10', row.id)?.nextSyncAt).toBe(now + poll.recountMs);
  });

  it('closes atomically only once the end time has passed', () => {
    const row = pollWithOptions();
    expect(closeDuePoll(db, row, now + hour - 1)).toBeUndefined();
    const closed = closeDuePoll(db, row, now + hour);
    expect(closed).toMatchObject({ status: 'closed', closedBy: null, closedAt: now + hour });
    expect(closeDuePoll(db, row, now + hour + 1)).toBeUndefined();
    expect(closePollEarly(db, '10', row.id, '2', now + hour + 1)).toBeUndefined();
  });

  it('records who closed it early', () => {
    const row = pollWithOptions();
    expect(closePollEarly(db, '10', row.id, '77', now + 5)).toMatchObject({
      status: 'closed',
      closedBy: '77',
      closedAt: now + 5,
      nextSyncAt: now + 5,
    });
  });

  it('lists open polls past their end even while backing off', () => {
    const row = pollWithOptions();
    updatePoll(db, row, { nextSyncAt: now + 10 * hour, accessFailures: 3 });
    expect(duePolls(db, now + 1, 10)).toEqual([]);
    expect(duePolls(db, now + hour, 10).map((r) => r.id)).toEqual([row.id]);
  });

  it('marks a deleted channel', () => {
    const row = pollWithOptions();
    markPollChannelDeleted(db, '10', '20');
    expect(getPoll(db, '10', row.id)).toMatchObject({ status: 'deleted', nextSyncAt: null });
  });
});

describe('startup recovery', () => {
  it('discards publishing polls with no message and resumes ones with a message', () => {
    const orphan = queuePoll(db, details({ creationId: 'o' }), now);
    const posted = queuePoll(db, details({ creationId: 'p' }), now);
    if (orphan.kind !== 'queued' || posted.kind !== 'queued') throw new Error('queue');
    updatePoll(db, posted.poll, { messageId: '31' });
    const open = pollWithOptions();
    updatePoll(db, open, { lastRecountAt: now - 1, nextSyncAt: now + hour });

    refreshPendingPolls(db, now);
    expect(getPoll(db, '10', orphan.poll.id)).toMatchObject({ status: 'deleted', messageId: null });
    expect(getPoll(db, '10', posted.poll.id)).toMatchObject({
      status: 'publishing',
      nextSyncAt: now,
    });
    expect(getPoll(db, '10', open.id)).toMatchObject({ nextSyncAt: now, lastRecountAt: null });
  });
});

describe('due poll scan', () => {
  it('uses indexes for both branches, so finished rows are not scanned', () => {
    const plan = db.all<{ detail: string }>(
      sql`explain query plan select * from polls where next_sync_at <= 1 or (status = 'open' and ends_at <= 1)`,
    );
    const text = plan.map((row) => row.detail).join('\n');
    expect(text).toContain('polls_next_sync_idx');
    expect(text).toContain('polls_status_ends_idx');
    expect(text).not.toMatch(/SCAN polls\b(?! USING)/);
  });
});

describe('applyRecount', () => {
  const set = (...ids: string[]) => new Set(ids);

  it('drops votes with no reaction, adds reactors, and moves a stale vote', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'gone', 0, now);
    castVote(db, '10', '30', 'kept', 1, now);
    castVote(db, '10', '30', 'moved', 0, now);
    const changed = applyRecount(
      db,
      row,
      new Map([
        [1, set('kept', 'new')],
        [2, set('moved')],
      ]),
      now + 5,
    );
    expect(changed).toBe(true);
    expect(tallyPoll(db, row)).toEqual([0, 2, 1]);
  });

  it('keeps the stored vote when a stale reaction remains on another option', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'u', 0, now);
    castVote(db, '10', '30', 'u', 2, now + 1);
    expect(
      applyRecount(
        db,
        row,
        new Map([
          [0, set('u')],
          [2, set('u')],
        ]),
        now + 2,
      ),
    ).toBe(false);
    expect(tallyPoll(db, row)).toEqual([0, 0, 1]);
  });

  it('leaves a reactor with several options and no stored vote unvoted', () => {
    const row = pollWithOptions();
    const changed = applyRecount(
      db,
      row,
      new Map([
        [0, set('multi', 'single')],
        [2, set('multi')],
      ]),
      now,
    );
    expect(changed).toBe(true);
    expect(tallyPoll(db, row)).toEqual([1, 0, 0]);
  });

  it('skips the whole apply when a vote event arrived since the snapshot began', () => {
    const row = pollWithOptions();
    castVote(db, '10', '30', 'kept', 1, now - 5);
    castVote(db, '10', '30', 'late', 2, now + 1);
    expect(recountRaced(row, now)).toBe(true);
    expect(applyRecount(db, row, new Map(), now + 2, now)).toBe(false);
    expect(tallyPoll(db, row)).toEqual([0, 1, 1]);
  });

  it('leaves voters whose vote changed since the snapshot began', () => {
    const row = pollWithOptions();
    db.insert(pollVotes)
      .values([
        { guildId: '10', pollId: row.id, userId: 'old', optionIndex: 0, votedAt: now - 10 },
        { guildId: '10', pollId: row.id, userId: 'fresh', optionIndex: 1, votedAt: now + 1 },
      ])
      .run();
    expect(recountRaced(row, now)).toBe(false);
    applyRecount(db, row, new Map(), now + 2, now);
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
  });

  it('does nothing for a closed poll', () => {
    const row = pollWithOptions();
    closePollEarly(db, '10', row.id, '2', now);
    expect(applyRecount(db, row, new Map([[0, set('u')]]), now)).toBe(false);
    expect(tallyPoll(db, row)).toEqual([0, 0, 0]);
  });
});

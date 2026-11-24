import { type Client, Routes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { createPoll, type PollRequest, pollStillPosting } from '../src/features/poll/create.js';
import {
  closePollEarly,
  getPoll,
  markPollMessagesDeleted,
  queuePoll,
} from '../src/features/poll/store.js';

const now = Date.UTC(2026, 10, 24);

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => closeDatabase(db));

function stub() {
  const post = vi.fn(async () => ({ id: '30' }));
  const put = vi.fn(async () => undefined);
  const del = vi.fn(async (_route: string) => undefined);
  const client = {
    rest: { post, put, delete: del },
    logger: { warn: vi.fn() },
  } as unknown as Client<true>;
  return { client, post, put, del };
}

const request = (extra: Partial<PollRequest> = {}): PollRequest => ({
  guildId: '10',
  channelId: '20',
  hostId: '2',
  creationId: 'abc',
  input: {
    question: 'Dinner?',
    options: ['a', 'b'],
    anonymous: false,
    durationMs: 3_600_000,
  },
  ...extra,
});

describe('createPoll idempotency', () => {
  it('does not republish a repeated creation of an open poll', async () => {
    const api = stub();
    const first = await createPoll(api.client, db, request(), now);
    expect(first.ok).toBe(true);
    const calls = api.post.mock.calls.length;
    const again = await createPoll(api.client, db, request(), now);
    expect(again).toEqual(first);
    expect(api.post.mock.calls.length).toBe(calls);
  });

  it('returns the link of a closed poll without touching it', async () => {
    const api = stub();
    await createPoll(api.client, db, request(), now);
    closePollEarly(db, '10', 1, '2', now);
    const before = getPoll(db, '10', 1);
    const again = await createPoll(api.client, db, request(), now);
    expect(again.ok).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(getPoll(db, '10', 1)).toEqual(before);
  });

  it('reports a deleted poll as failed and does not revive it', async () => {
    const api = stub();
    await createPoll(api.client, db, request(), now);
    markPollMessagesDeleted(db, '10', ['30']);
    const again = await createPoll(api.client, db, request(), now);
    expect(again.ok).toBe(false);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(getPoll(db, '10', 1)?.status).toBe('deleted');
  });

  it('does nothing for a poll that is mid-publish', async () => {
    const api = stub();
    queuePoll(
      db,
      { ...request().input, guildId: '10', channelId: '20', hostId: '2', creationId: 'abc' },
      now,
    );
    const again = await createPoll(api.client, db, request(), now);
    expect(again).toEqual({ ok: false, error: pollStillPosting });
    expect(api.post).not.toHaveBeenCalled();
    expect(getPoll(db, '10', 1)?.status).toBe('publishing');
  });

  it('deletes the posted message and discards the row when seeding fails', async () => {
    const api = stub();
    api.put.mockRejectedValueOnce(new Error('no reactions'));
    const result = await createPoll(api.client, db, request(), now);
    expect(result.ok).toBe(false);
    expect(api.del).toHaveBeenCalledTimes(1);
    expect(api.del.mock.calls[0]?.[0]).toBe(Routes.channelMessage('20', '30'));
    expect(getPoll(db, '10', 1)).toMatchObject({ status: 'deleted', messageId: null });
    const next = await createPoll(api.client, db, request({ creationId: 'def' }), now);
    expect(next.ok).toBe(true);
    expect(getPoll(db, '10', 2)).toBeDefined();
  });
});

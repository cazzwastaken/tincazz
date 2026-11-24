import { container } from '@sapphire/framework';
import { type Client, DiscordAPIError, RESTJSONErrorCodes, Routes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { polls } from '../src/db/schema.js';
import { optionEmojis, poll } from '../src/features/poll/config.js';
import { publishPoll, startPolls, syncPoll } from '../src/features/poll/runner.js';
import {
  castVote,
  clearVote,
  closePollEarly,
  discardPoll,
  getPoll,
  openPollsByHost,
  queuePoll,
  requestPollRefresh,
  tallyPoll,
  updatePoll,
} from '../src/features/poll/store.js';
import { openPoll } from './support/polls.js';

const now = Date.UTC(2026, 10, 24);
const hour = 3_600_000;
const messagePath = Routes.channelMessage('20', '30');
const emojis = optionEmojis.slice(0, 3);
const reactionPath = (emoji: string) =>
  Routes.channelMessageReaction('20', '30', encodeURIComponent(emoji));

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
  container.db = db;
  container.logger = { warn: vi.fn() } as unknown as typeof container.logger;
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase(db);
});

const save = (endsAt = now + 2 * poll.recountMs, extra: { hostId?: string } = {}) =>
  openPoll(db, { options: ['Tacos', 'Pizza', 'Sushi'], endsAt, now, ...extra });
const read = () => db.select().from(polls).get();

function discord(voters: Record<string, { id: string; bot: boolean }[]> = {}) {
  const bot = { id: '1', bot: true };
  const message = {
    author: bot,
    reactions: emojis.map((name) => ({
      emoji: { id: null, name },
      me: true,
      count_details: { normal: (voters[name] ?? []).length + 1, burst: 0 },
    })),
  };
  const get = vi.fn(async (route: string, _options?: unknown) => {
    if (route === messagePath) return message;
    for (const name of emojis) {
      if (route === reactionPath(name)) return [bot, ...(voters[name] ?? [])];
    }
    throw new Error(`Unexpected route ${route}`);
  });
  const put = vi.fn(async (_route: string) => undefined);
  const patch = vi.fn(async () => ({}));
  const post = vi.fn(async () => ({ id: '30' }));
  const client = {
    user: bot,
    rest: { get, put, patch, post },
    isReady: () => true,
  } as unknown as Client<true>;
  return { client, message, get, put, patch, post };
}

const apiError = (status: number, code: number, method = 'PATCH') =>
  new DiscordAPIError({ message: 'x', code }, code, status, method, messagePath, {});

describe('poll runner', () => {
  it('coalesces a burst of votes into one edit and recounts rarely', async () => {
    save();
    vi.useFakeTimers({ now });
    const api = discord();
    const stop = startPolls(api.client);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      // The first sync after startup recounts and draws the card.
      expect(api.patch).toHaveBeenCalledTimes(1);
      const gets = api.get.mock.calls.length;

      for (const user of ['a', 'b', 'c']) castVote(db, '10', '30', user, 0, Date.now());
      await vi.advanceTimersByTimeAsync(1000);
      castVote(db, '10', '30', 'd', 1, Date.now());
      await vi.advanceTimersByTimeAsync(poll.debounceMs + 1000);
      expect(api.patch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(api.patch.mock.calls[1])).toContain('4 votes');
      // A vote-driven sync reads the database, not Discord.
      expect(api.get.mock.calls.length).toBe(gets);

      // Nothing changed: no further edits.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.patch).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('closes at the end time, edits the final card and frees the slot', async () => {
    save(now + 10_000);
    save(now + 10_000);
    vi.useFakeTimers({ now });
    const api = discord();
    const stop = startPolls(api.client);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      castVote(db, '10', '30', 'a', 2, Date.now());
      await vi.advanceTimersByTimeAsync(11_000);
      const last = JSON.stringify(api.patch.mock.calls.at(-1));
      expect(last).toContain('Poll closed');
      expect(last).toContain('Sushi');
      expect(read()).toMatchObject({ status: 'closed', nextSyncAt: null, closedBy: null });
      expect(openPollsByHost(db, '10', '2')).toHaveLength(0);
      const edits = api.patch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.patch.mock.calls.length).toBe(edits);
      expect(castVote(db, '10', '30', 'b', 0, Date.now())).toBeUndefined();
    } finally {
      stop();
    }
  });

  it('shows who closed an early-closed poll', async () => {
    const row = save();
    const api = discord();
    closePollEarly(db, '10', row.id, '77', now);
    const closed = getPoll(db, '10', row.id);
    if (!closed) throw new Error('missing');
    await syncPoll(api.client, db, closed, now);
    expect(JSON.stringify(api.patch.mock.calls)).toContain('<@77>');
    expect(read()).toMatchObject({ nextSyncAt: null });
  });

  it('rescans every open poll on restart and recounts it', async () => {
    const row = save();
    updatePoll(db, row, { lastRecountAt: now, nextSyncAt: now + poll.recountMs });
    vi.useFakeTimers({ now });
    const api = discord({ [emojis[1] ?? '']: [{ id: '8', bot: false }] });
    const stop = startPolls(api.client);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.get).toHaveBeenCalledWith(messagePath);
      expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
    } finally {
      stop();
    }
  });

  it('reconciles votes with Discord reactions and ignores bots', async () => {
    const row = save();
    castVote(db, '10', '30', '501', 0, now - 1);
    castVote(db, '10', '30', '502', 1, now - 1);
    const api = discord({
      [emojis[1] ?? '']: [
        { id: '502', bot: false },
        { id: '504', bot: true },
      ],
      [emojis[2] ?? '']: [{ id: '503', bot: false }],
    });
    await syncPoll(api.client, db, row, now);
    expect(tallyPoll(db, row)).toEqual([0, 1, 1]);
    expect(read()?.lastRecountAt).toBe(now);
  });

  it('re-seeds missing bot reactions during a recount', async () => {
    const row = save();
    const api = discord();
    for (const reaction of api.message.reactions) reaction.me = false;
    await syncPoll(api.client, db, row, now);
    expect(api.put).toHaveBeenCalledTimes(3);
  });

  it('does not recount on a plain refresh', async () => {
    const row = save();
    updatePoll(db, row, { lastRecountAt: now });
    const api = discord();
    await syncPoll(api.client, db, getPoll(db, '10', row.id) ?? row, now + 1000);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  it('keeps a switched vote when the bot removes the old reaction', () => {
    const row = save();
    castVote(db, '10', '30', '602', 0, now);
    const moved = castVote(db, '10', '30', '602', 1, now + 1);
    expect(moved?.previous).toBe(0);
    expect(clearVote(db, '10', '30', '602', 0, now + 2)).toBe(false);
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
  });

  it('backs off after access failures and stops debouncing', async () => {
    const row = save();
    const api = discord();
    api.patch.mockRejectedValue(apiError(403, RESTJSONErrorCodes.MissingAccess));
    await expect(syncPoll(api.client, db, row, now)).rejects.toThrow();
    expect(read()).toMatchObject({ accessFailures: 1, nextSyncAt: now + poll.accessRetryMs });

    requestPollRefresh(db, '10', '30', now);
    expect(read()?.nextSyncAt).toBe(now + poll.accessRetryMs);

    const again = read();
    if (!again) throw new Error('missing');
    await expect(syncPoll(api.client, db, again, now + poll.accessRetryMs)).rejects.toThrow();
    expect(read()).toMatchObject({
      accessFailures: 2,
      nextSyncAt: now + poll.accessRetryMs * 3,
    });

    api.patch.mockResolvedValue({});
    const third = read();
    if (!third) throw new Error('missing');
    await syncPoll(api.client, db, third, now + poll.accessRetryMs * 3);
    expect(read()).toMatchObject({ accessFailures: 0 });
  });

  it('still closes an expired poll while access is blocked', async () => {
    const row = save(now + 1000);
    updatePoll(db, row, { accessFailures: 2, nextSyncAt: now + 10 * hour });
    vi.useFakeTimers({ now: now + 2000 });
    const api = discord();
    api.patch.mockRejectedValue(apiError(403, RESTJSONErrorCodes.MissingAccess));
    const stop = startPolls(api.client);
    try {
      await vi.advanceTimersByTimeAsync(1500);
      expect(read()?.status).toBe('closed');
      expect(openPollsByHost(db, '10', '2')).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('marks the poll deleted when the message is gone', async () => {
    const row = save();
    const api = discord();
    api.get.mockRejectedValueOnce(apiError(404, RESTJSONErrorCodes.UnknownMessage, 'GET'));
    await syncPoll(api.client, db, row, now);
    expect(read()).toMatchObject({ status: 'deleted', nextSyncAt: null });
    expect(openPollsByHost(db, '10', '2')).toHaveLength(0);
  });

  it('retries other failures after a short delay', async () => {
    const row = save();
    const api = discord();
    api.patch.mockRejectedValueOnce(new Error('boom'));
    await expect(syncPoll(api.client, db, row, now)).rejects.toThrow('boom');
    expect(read()).toMatchObject({ accessFailures: 0, nextSyncAt: now + poll.retryMs });
  });
});

describe('recount racing live votes', () => {
  /** Discord's snapshot lists `listed` for option 0 while `during` runs mid-fetch. */
  async function recountWith(listed: string[], during: () => void) {
    const row = save();
    const api = discord({ [emojis[0] as string]: listed.map((id) => ({ id, bot: false })) });
    const fetchUsers = api.get.getMockImplementation() as (route: string) => Promise<unknown>;
    api.get.mockImplementation((async (route: string) => {
      const result = await fetchUsers(route);
      if (route === reactionPath(emojis[0] as string)) during();
      return result;
    }) as never);
    await syncPoll(api.client, db, row, now);
    return row;
  }
  const tally = (row: { guildId: string; id: number; options: string[] }) => tallyPoll(db, row);

  it('keeps a vote added during the fetch and retries soon', async () => {
    const row = await recountWith([], () => castVote(db, '10', '30', '601', 1, now + 1));
    expect(tally(row)).toEqual([0, 1, 0]);
    expect(read()).toMatchObject({
      lastRecountAt: null,
      nextSyncAt: now + poll.racedRecountRetryMs,
    });
  });

  it('does not resurrect a vote removed during the fetch', async () => {
    const row = save();
    castVote(db, '10', '30', '600', 0, now - 10);
    const api = discord({ [emojis[0] as string]: [{ id: '600', bot: false }] });
    const fetchUsers = api.get.getMockImplementation() as (route: string) => Promise<unknown>;
    api.get.mockImplementation((async (route: string) => {
      const result = await fetchUsers(route);
      if (route === reactionPath(emojis[0] as string)) {
        clearVote(db, '10', '30', '600', 0, now + 1);
      }
      return result;
    }) as never);
    await syncPoll(api.client, db, row, now);
    expect(tally(row)).toEqual([0, 0, 0]);
  });

  it('does not undo a switch made during the fetch', async () => {
    const row = save();
    castVote(db, '10', '30', '602', 0, now - 10);
    const api = discord({ [emojis[0] as string]: [{ id: '602', bot: false }] });
    const fetchUsers = api.get.getMockImplementation() as (route: string) => Promise<unknown>;
    api.get.mockImplementation((async (route: string) => {
      const result = await fetchUsers(route);
      if (route === reactionPath(emojis[0] as string)) castVote(db, '10', '30', '602', 2, now + 1);
      return result;
    }) as never);
    await syncPoll(api.client, db, row, now);
    expect(tally(row)).toEqual([0, 0, 1]);
  });

  it('recounts normally when nothing happened during the fetch', async () => {
    const row = await recountWith(['603'], () => undefined);
    expect(tally(row)).toEqual([1, 0, 0]);
    expect(read()?.lastRecountAt).toBe(now);
  });
});

describe('recount and super reactions', () => {
  it('only reads normal reactions and ignores a burst-only emoji', async () => {
    const row = save();
    castVote(db, '10', '30', '700', 0, now - 1);
    const api = discord({ [emojis[1] as string]: [{ id: '701', bot: false }] });
    for (const reaction of api.message.reactions) {
      if (reaction.emoji.name === emojis[0]) reaction.count_details = { normal: 0, burst: 2 };
    }
    await syncPoll(api.client, db, row, now);
    const userCalls = api.get.mock.calls.filter(([route]) => route !== messagePath);
    for (const call of userCalls) {
      const options = call[1] as { query: URLSearchParams } | undefined;
      expect(options?.query.get('type')).toBe('0');
    }
    expect(userCalls.some(([route]) => route === reactionPath(emojis[0] as string))).toBe(false);
    // The burst-only option has no normal reactors, so its stored vote goes; the other is added.
    expect(tallyPoll(db, row)).toEqual([0, 1, 0]);
  });
});

describe('publishPoll', () => {
  function queued() {
    const result = queuePoll(
      db,
      {
        guildId: '10',
        channelId: '20',
        hostId: '2',
        question: 'Dinner?',
        options: ['a', 'b', 'c'],
        anonymous: false,
        durationMs: hour,
        creationId: 'abc',
      },
      now,
    );
    if (result.kind === 'cap') throw new Error('cap');
    return result.poll;
  }

  it('deletes the message it just posted when the row was discarded mid-post', async () => {
    const api = discord();
    const row = queued();
    api.post.mockImplementation((async () => {
      discardPoll(db, row);
      return { id: '30' };
    }) as never);
    const del = vi.fn(async (_route: string) => undefined);
    (api.client.rest as unknown as { delete: typeof del }).delete = del;
    await expect(publishPoll(api.client, db, row, now)).rejects.toThrow(
      'while it was being posted',
    );
    expect(del).toHaveBeenCalledWith(messagePath);
  });

  it('posts, seeds the reactions in order and opens the poll', async () => {
    const api = discord();
    const opened = await publishPoll(api.client, db, queued(), now);
    expect(opened).toMatchObject({ status: 'open', messageId: '30' });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.put.mock.calls.map(([route]) => decodeURIComponent(String(route)))).toEqual(
      emojis.map((emoji) => expect.stringContaining(emoji)),
    );
    expect(openPollsByHost(db, '10', '2')).toHaveLength(1);
  });

  it('refuses to publish a poll that is not publishing', async () => {
    const api = discord();
    const opened = await publishPoll(api.client, db, queued(), now);
    await expect(publishPoll(api.client, db, opened, now)).rejects.toThrow('not publishing');
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('resumes a publishing poll that already has a message without posting again', async () => {
    const api = discord();
    const row = queued();
    const saved = updatePoll(db, row, { messageId: '30' });
    if (!saved) throw new Error('missing');
    await publishPoll(api.client, db, saved, now);
    expect(api.post).not.toHaveBeenCalled();
    expect(read()?.status).toBe('open');
  });

  it('leaves the row publishing when posting fails so the caller can discard it', async () => {
    const api = discord();
    api.post.mockRejectedValueOnce(new Error('no'));
    await expect(publishPoll(api.client, db, queued(), now)).rejects.toThrow('no');
    expect(read()?.status).toBe('publishing');
  });

  it('gives up on a poll stuck publishing after the TTL and frees the slot', async () => {
    const row = queued();
    vi.useFakeTimers({ now });
    const api = discord();
    const del = vi.fn(async (_route: string) => undefined);
    Object.assign(api.client.rest, { delete: del });
    updatePoll(db, row, { messageId: '30' });
    const stop = startPolls(api.client);
    try {
      // Make the resumed publish fail so the row stays publishing until the TTL.
      api.put.mockRejectedValue(new Error('no reactions'));
      await vi.advanceTimersByTimeAsync(poll.publishTtlMs + 10_000);
      expect(read()).toMatchObject({ status: 'deleted', messageId: null });
      expect(del).toHaveBeenCalledWith(messagePath);
      expect(openPollsByHost(db, '10', '2')).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('gives up on a publishing row that never got a message', async () => {
    queued();
    vi.useFakeTimers({ now });
    const api = discord();
    const stop = startPolls(api.client);
    try {
      await vi.advanceTimersByTimeAsync(poll.publishTtlMs + 5000);
      expect(read()?.status).toBe('deleted');
    } finally {
      stop();
    }
  });

  it('resumes publishing polls at startup', async () => {
    const row = queued();
    updatePoll(db, row, { messageId: '30' });
    vi.useFakeTimers({ now });
    const api = discord();
    const stop = startPolls(api.client);
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(read()?.status).toBe('open');
      expect(api.put).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });
});

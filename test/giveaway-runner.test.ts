import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { container } from '@sapphire/framework';
import { type Client, DiscordAPIError, RESTJSONErrorCodes, Routes } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { giveaways } from '../src/db/schema.js';
import { giveaway } from '../src/features/giveaways/config.js';
import { startGiveaways, syncGiveaway } from '../src/features/giveaways/runner.js';
import {
  activeGiveaways,
  cancelGiveawayPosts,
  dueGiveaways,
  queueGiveaway,
  refreshPendingGiveaways,
  requestGiveawayRefresh,
  updateGiveaway,
} from '../src/features/giveaways/store.js';
import { testEnv } from './support/env.js';
import { openGiveaway } from './support/giveaways.js';

const now = Date.UTC(2026, 9, 15);
const path = Routes.channelMessage('20', '30');
const reactionPath = Routes.channelMessageReaction('20', '30', encodeURIComponent(giveaway.emoji));
const user = (id: number, bot = false) => ({ id: String(id), bot });

let folder: string;
let db: Db;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'tincazz-giveaway-test-'));
  file = join(folder, 'bot.sqlite');
  db = openDatabase(file);
});

afterEach(() => {
  vi.useRealTimers();
  closeDatabase(db);
  rmSync(folder, { recursive: true, force: true });
});

function save(endsAt = now + 60_000) {
  return openGiveaway(db, '10', '20', '30', 'Nitro', '2', endsAt, now);
}

const read = () => db.select().from(giveaways).get();

function discord() {
  const message = {
    author: user(1, true),
    content: '',
    timestamp: new Date(now).toISOString(),
    edited_timestamp: null as string | null,
    embeds: [] as { footer?: { text: string } }[],
    reactions: [
      {
        emoji: { id: null, name: giveaway.emoji },
        me: false,
        count_details: { normal: 1, burst: 0 },
      },
    ],
  };
  const history = vi.fn((_query?: URLSearchParams) => [] as object[]);
  const list = vi.fn((_query?: URLSearchParams) => [user(7)]);
  const get = vi.fn(async (route: string, options?: { query: URLSearchParams }) => {
    if (route === path) return message;
    if (route === Routes.channelMessages('20')) return history(options?.query);
    if (route === reactionPath) return list(options?.query);
    throw new Error(`Unexpected route ${route}`);
  });
  const put = vi.fn();
  const patch = vi.fn();
  const post = vi.fn(async () => ({ id: '30' }));
  const client = {
    user: message.author,
    rest: { get, put, patch, post },
    isReady: () => true,
  } as unknown as Client<true>;
  return { client, message, list, get, put, patch, post, history };
}

describe('giveaway lifecycle', () => {
  it('recounts quiet giveaways infrequently and coalesces reaction events', async () => {
    save(now + 2 * giveaway.recountMs);
    vi.useFakeTimers({ now });
    container.db = db;
    const api = discord();
    const stop = startGiveaways(api.client);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(read()?.nextSyncAt).toBe(now + giveaway.recountMs);
      requestGiveawayRefresh(db, '10', '30', Date.now());
      requestGiveawayRefresh(db, '10', '30', Date.now() + 1000);
      await vi.advanceTimersByTimeAsync(giveaway.debounceMs);
      expect(api.list).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(giveaway.recountMs);
      expect(api.list).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it('seeds the reaction, updates the public count and reflects withdrawals', async () => {
    const row = save();
    const api = discord();
    await syncGiveaway(api.client, db, row, now);
    expect(api.put).toHaveBeenCalledWith(`${reactionPath}/@me`);
    expect(api.patch).toHaveBeenCalledWith(path, {
      body: {
        content: '',
        embeds: [
          expect.objectContaining({
            title: 'Nitro',
            fields: [
              expect.objectContaining({ name: 'Host', value: '<@2>' }),
              expect.objectContaining({ name: 'Entries', value: '1' }),
              expect.objectContaining({ name: 'Earliest draw' }),
            ],
          }),
        ],
        allowed_mentions: { parse: [] },
      },
    });
    expect(read()?.entryCount).toBe(1);

    api.message.reactions = [];
    await syncGiveaway(api.client, db, read() ?? row, now + 3000);
    expect(read()?.entryCount).toBe(0);
    expect(read()?.status).toBe('open');
  });

  it('paginates past 100, deduplicates super reactions and excludes bots and the host', async () => {
    const row = save(now);
    const api = discord();
    const reaction = api.message.reactions[0];
    if (!reaction) throw new Error('Missing test reaction');
    reaction.count_details = { normal: 101, burst: 2 };
    api.list.mockImplementation((query) => {
      if (query?.get('type') === '1') return [user(101), user(102)];
      if (query?.get('after') === '100') return [user(101)];
      return Array.from({ length: 100 }, (_, i) => user(i + 1, i === 0));
    });
    await syncGiveaway(api.client, db, row, now);
    expect(api.list.mock.calls.map(([query]) => [...(query ?? [])])).toEqual([
      [
        ['type', '0'],
        ['limit', '100'],
      ],
      [
        ['type', '0'],
        ['limit', '100'],
        ['after', '100'],
      ],
      [
        ['type', '1'],
        ['limit', '100'],
      ],
    ]);
    const ended = read();
    expect(ended).toMatchObject({ status: 'ended', entryCount: 100, nextSyncAt: null });
    expect(Number(ended?.winnerId)).toBeGreaterThanOrEqual(3);
    expect(Number(ended?.winnerId)).toBeLessThanOrEqual(102);
    expect(JSON.stringify(api.patch.mock.calls)).toContain(`<@${ended?.winnerId}>`);
  });

  it('settles an overdue giveaway at startup and retries the same result after a failed edit', async () => {
    const row = save(now - 500);
    updateGiveaway(db, row, { nextSyncAt: now + 60_000 });
    closeDatabase(db);
    db = openDatabase(file);

    const api = discord();
    api.patch.mockRejectedValueOnce(new Error('Discord temporarily unavailable'));
    vi.useFakeTimers({ now });
    const logger = createClient(testEnv).logger;
    container.logger = logger;
    container.db = db;
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let stop = startGiveaways(api.client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(api.patch).toHaveBeenCalledTimes(1);
      expect(read()).toMatchObject({
        endsAt: row.endsAt,
        status: 'ended',
        winnerId: '7',
        entryCount: 1,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      stop();

      closeDatabase(db);
      db = openDatabase(file);
      container.db = db;
      api.list.mockReturnValue([user(8)]);
      stop = startGiveaways(api.client);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.list).toHaveBeenCalledTimes(1);
      expect(api.patch).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(api.patch.mock.calls[1])).toContain('<@7>');
      expect(read()).toMatchObject({ winnerId: '7', nextSyncAt: null });
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it('keeps the draw pending if Discord cannot return the reaction list', async () => {
    const row = save(now);
    const api = discord();
    api.list.mockImplementationOnce(() => {
      throw new Error('Discord temporarily unavailable');
    });

    await expect(syncGiveaway(api.client, db, row, now)).rejects.toThrow('temporarily unavailable');
    expect(api.patch).not.toHaveBeenCalled();
    expect(read()).toMatchObject({
      status: 'open',
      drawnAt: null,
      nextSyncAt: now + giveaway.retryMs,
    });

    await syncGiveaway(api.client, db, read() ?? row, now + giveaway.retryMs);
    expect(read()).toMatchObject({
      status: 'ended',
      winnerId: '7',
      entryCount: 1,
      nextSyncAt: null,
    });
  });

  it('closes empty giveaways without a winner and abandons a deleted post', async () => {
    const row = save(now);
    const api = discord();
    api.message.reactions = [];
    await syncGiveaway(api.client, db, row, now);
    expect(read()).toMatchObject({ status: 'ended', entryCount: 0, winnerId: null });
    expect(JSON.stringify(api.patch.mock.calls)).toContain('No winner');

    updateGiveaway(db, read() ?? row, { status: 'open' });
    api.get.mockRejectedValueOnce(
      new DiscordAPIError(
        { message: 'Unknown Message', code: RESTJSONErrorCodes.UnknownMessage },
        RESTJSONErrorCodes.UnknownMessage,
        404,
        'GET',
        path,
        {},
      ),
    );
    await syncGiveaway(api.client, db, read() ?? row, now);
    expect(read()).toMatchObject({ status: 'deleted', nextSyncAt: null });
  });
});

describe('giveaway publication and recovery', () => {
  function queue() {
    return queueGiveaway(
      db,
      {
        guildId: '10',
        channelId: '20',
        creationId: '100',
        hostId: '2',
        prize: 'Nitro',
        durationMs: 60_000,
      },
      now,
    );
  }

  function publishedCard(time: number) {
    return {
      embeds: [{ footer: { text: 'Giveaway #1' } }],
      edited_timestamp: new Date(time).toISOString(),
    };
  }

  it('starts the full duration after the entry card goes live, even after setup retries', async () => {
    const api = discord();
    api.message.reactions = [];
    const row = queue();
    api.put.mockRejectedValueOnce(new Error('Cannot seed yet'));

    await expect(syncGiveaway(api.client, db, row, now)).rejects.toThrow('Cannot seed yet');
    expect(api.post).toHaveBeenCalledWith(Routes.channelMessages('20'), {
      body: {
        content: '🎁 Setting up Tincazz giveaway #1…',
        nonce: '100',
        enforce_nonce: true,
        allowed_mentions: { parse: [] },
      },
    });
    expect(api.patch).not.toHaveBeenCalled();
    expect(read()).toMatchObject({
      status: 'publishing',
      messageId: '30',
      endsAt: null,
      nextSyncAt: now + giveaway.publishRetryMs,
    });

    const openedAt = now + 80_000;
    api.patch.mockResolvedValueOnce(publishedCard(openedAt));
    await syncGiveaway(api.client, db, read() ?? row, openedAt);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(read()).toMatchObject({ status: 'open', endsAt: openedAt + 60_000, winnerId: null });
    expect(api.list).not.toHaveBeenCalled();
  });

  it('keeps the giveaway in setup when Discord returns the edit without the entry card', async () => {
    const row = queue();
    const api = discord();
    api.patch.mockResolvedValueOnce({ embeds: [], edited_timestamp: new Date(now).toISOString() });

    await expect(syncGiveaway(api.client, db, row, now)).rejects.toThrow(
      'Missing giveaway publication data',
    );
    expect(read()).toMatchObject({ status: 'publishing', endsAt: null, winnerId: null });
  });

  it('reuses a setup post with a lost response after restart, including past the first page', async () => {
    const row = queue();
    const api = discord();
    api.post.mockRejectedValueOnce(new Error('Send response lost'));
    await expect(syncGiveaway(api.client, db, row, now)).rejects.toThrow('Send response lost');
    closeDatabase(db);
    db = openDatabase(file);

    const setup = {
      id: '30',
      author: user(1, true),
      content: '🎁 Setting up Tincazz giveaway #1…',
    };
    api.history.mockImplementation((query) => {
      if (query?.get('before') === '200') return [setup];
      return Array.from({ length: 100 }, (_, index) => ({
        ...setup,
        id: String(200 + index),
        author: user(9),
      }));
    });
    const openedAt = now + 3_600_000;
    api.patch.mockResolvedValueOnce(publishedCard(openedAt));

    await syncGiveaway(api.client, db, read() ?? row, openedAt);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(read()).toMatchObject({ status: 'open', messageId: '30', endsAt: openedAt + 60_000 });
  });

  it('recovers the deadline from an already published card after an interrupted edit', async () => {
    const row = queue();
    updateGiveaway(db, row, { messageId: '30' });
    const api = discord();
    api.message.edited_timestamp = new Date(now + 2_000).toISOString();
    api.message.embeds = [{ footer: { text: 'Giveaway #1' } }];

    await syncGiveaway(api.client, db, read() ?? row, now + 5_000);
    expect(read()).toMatchObject({ status: 'open', endsAt: now + 62_000 });
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('recovers an overdue legacy placeholder without selecting a winner', async () => {
    db.insert(giveaways)
      .values({
        id: 1,
        guildId: '10',
        channelId: '20',
        messageId: '30',
        hostId: '2',
        prize: 'Nitro',
        endsAt: now + 60_000,
        nextSyncAt: now,
      })
      .run();
    const api = discord();
    api.message.content = '🎁 Setting up a Tincazz giveaway…';
    api.patch.mockResolvedValueOnce(publishedCard(now + 80_000));

    const row = read();
    if (!row) throw new Error('Missing test giveaway');
    await syncGiveaway(api.client, db, row, now + 80_000);
    expect(read()).toMatchObject({ status: 'open', endsAt: now + 140_000, winnerId: null });
    expect(api.list).not.toHaveBeenCalled();
  });

  it('prioritizes a due draw over older maintenance and uses the requested draw snapshot', async () => {
    const later = openGiveaway(db, '10', '20', '31', 'Later', '2', now + 60_000, now - 5_000);
    const due = save(now - 1_000);
    expect(dueGiveaways(db, now, 1).map((row) => row.messageId)).toEqual([due.messageId]);

    const api = discord();
    api.list.mockReturnValue([user(8)]);
    await syncGiveaway(api.client, db, due, now);
    expect(db.select().from(giveaways).all()).toContainEqual(
      expect.objectContaining({
        messageId: due.messageId,
        status: 'ended',
        winnerId: '8',
      }),
    );
    expect(activeGiveaways(db, '10')).toEqual([later]);
  });

  it('cancels a draw if a deletion arrives while the entrant list is fetched', async () => {
    const row = save(now);
    const api = discord();
    api.list.mockImplementation(() => {
      cancelGiveawayPosts(db, row.guildId, ['30']);
      return [user(7)];
    });

    await syncGiveaway(api.client, db, row, now);
    expect(read()).toMatchObject({ status: 'deleted', winnerId: null });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('backs off after access errors, preserves that schedule, then resumes the draw', async () => {
    const row = save(now);
    const api = discord();
    const error = new DiscordAPIError(
      { message: 'Missing Access', code: RESTJSONErrorCodes.MissingAccess },
      RESTJSONErrorCodes.MissingAccess,
      403,
      'GET',
      path,
      {},
    );
    api.get.mockRejectedValueOnce(error).mockRejectedValueOnce(error);
    await expect(syncGiveaway(api.client, db, row, now)).rejects.toThrow('Missing Access');
    const blocked = read() ?? row;
    expect(blocked).toMatchObject({
      status: 'open',
      accessFailures: 1,
      nextSyncAt: now + giveaway.accessRetryMs,
    });

    requestGiveawayRefresh(db, row.guildId, '30', now + 1_000);
    refreshPendingGiveaways(db, now + 1_000);
    expect(dueGiveaways(db, now + 1_000, 1)).toEqual([]);
    expect(activeGiveaways(db, row.guildId)).toEqual([blocked]);
    const retryAt = now + giveaway.accessRetryMs;
    await expect(syncGiveaway(api.client, db, blocked, retryAt)).rejects.toThrow('Missing Access');
    expect(read()).toMatchObject({
      accessFailures: 2,
      nextSyncAt: retryAt + 2 * giveaway.accessRetryMs,
    });

    await syncGiveaway(api.client, db, read() ?? row, retryAt + 2 * giveaway.accessRetryMs);
    expect(read()).toMatchObject({
      status: 'ended',
      winnerId: '7',
      accessFailures: 0,
      nextSyncAt: null,
    });
  });

  it('keeps a recorded winner on permission failure and retries only the result edit', async () => {
    const row = save(now);
    const api = discord();
    const error = new DiscordAPIError(
      { message: 'Missing Permissions', code: RESTJSONErrorCodes.MissingPermissions },
      RESTJSONErrorCodes.MissingPermissions,
      403,
      'PATCH',
      path,
      {},
    );
    api.patch.mockRejectedValueOnce(error);
    await expect(syncGiveaway(api.client, db, row, now)).rejects.toThrow('Missing Permissions');
    const blocked = read() ?? row;
    expect(blocked).toMatchObject({
      status: 'ended',
      winnerId: '7',
      accessFailures: 1,
      nextSyncAt: now + giveaway.accessRetryMs,
    });
    expect(activeGiveaways(db, row.guildId)).toEqual([blocked]);

    api.list.mockReturnValue([user(8)]);
    await syncGiveaway(api.client, db, blocked, now + giveaway.accessRetryMs);
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(read()).toMatchObject({ winnerId: '7', accessFailures: 0, nextSyncAt: null });
    expect(activeGiveaways(db, row.guildId)).toEqual([]);
  });
});

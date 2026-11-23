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
import { saveGiveaway, updateGiveaway } from '../src/features/giveaways/store.js';
import { testEnv } from './support/env.js';

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
  return saveGiveaway(
    db,
    { guildId: '10', channelId: '20', messageId: '30', hostId: '2', prize: 'Nitro', endsAt },
    now,
  );
}

const read = () => db.select().from(giveaways).get();

function discord() {
  const message = {
    author: user(1, true),
    embeds: [] as object[],
    reactions: [
      {
        emoji: { id: null, name: giveaway.emoji },
        me: false,
        count_details: { normal: 1, burst: 0 },
      },
    ],
  };
  const list = vi.fn((_query?: URLSearchParams) => [user(7)]);
  const get = vi.fn(async (route: string, options?: { query: URLSearchParams }) => {
    if (route === path) return message;
    if (route === reactionPath) return list(options?.query);
    throw new Error(`Unexpected route ${route}`);
  });
  const put = vi.fn();
  const patch = vi.fn();
  const client = {
    user: message.author,
    rest: { get, put, patch },
    isReady: () => true,
  } as unknown as Client<true>;
  return { client, message, list, get, put, patch };
}

describe('giveaway lifecycle', () => {
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
              expect.objectContaining({ name: 'Draws' }),
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
      nextSyncAt: now + giveaway.refreshMs,
    });

    await syncGiveaway(api.client, db, read() ?? row, now + giveaway.refreshMs);
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

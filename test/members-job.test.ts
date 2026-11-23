import { container } from '@sapphire/framework';
import type { Client } from 'discord.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ledger, wallets } from '../src/db/schema.js';
import { members } from '../src/features/members/config.js';
import { createMemberReconcileJob } from '../src/features/members/job.js';
import { reconcileGuild } from '../src/features/members/reconcile.js';
import { setLogChannel } from '../src/features/settings/store.js';
import { expectLedgerConsistent } from './support/ledger.js';

const now = 100 * members.graceMs;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container.db = openDatabase(':memory:');
  send = vi.fn(async () => ({}));
  container.logger = { warn: vi.fn(), info: vi.fn() } as unknown as typeof container.logger;
  container.client = {
    channels: { cache: new Map([['50', { id: '50', isSendable: () => true, send }]]) },
  } as never;
  setLogChannel(container.db, '2', 'economy', '50', 0);
});

function seed(userId: string, balance: number, departedAt: number | null) {
  container.db
    .insert(wallets)
    .values({ guildId: '2', userId, balance, createdAt: 0, departedAt })
    .run();
  container.db
    .insert(ledger)
    .values({
      guildId: '2',
      userId,
      delta: balance,
      balanceAfter: balance,
      reason: 'admin_grant',
      createdAt: 0,
    })
    .run();
}

const guild = (
  ids: string[],
  memberCount = ids.length,
  id = '2',
  lookup: () => Promise<void> = async () => {
    throw Object.assign(new Error('unknown member'), { code: 10007 });
  },
) => ({
  id,
  memberCount,
  members: {
    fetch: async (options?: { force: true }) => {
      if (options) await lookup();
      return new Map(ids.map((i) => [i, {}]));
    },
  },
});

const departedAtOf = (userId: string) =>
  container.db
    .select()
    .from(wallets)
    .all()
    .find((w) => w.userId === userId)?.departedAt;

it('applies a mixed plan and returns the counts', async () => {
  seed('1', 10, null); // missing -> depart
  seed('2', 20, 5); // present -> restore
  seed('3', 700, now - members.graceMs); // purge
  seed('4', 5, null); // stays
  const result = await reconcileGuild(container.db, guild(['2', '4']), now);
  expect(result).toEqual({ departed: 1, restored: 1, purged: ['3'], coinsRemoved: 700 });
  expect(departedAtOf('1')).toBe(now);
  expect(departedAtOf('2')).toBeNull();
  expect(departedAtOf('3')).toBeUndefined();
  expectLedgerConsistent(container.db);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
});

it('does nothing when fetch rejects', async () => {
  seed('1', 10, null);
  const bad = {
    id: '2',
    memberCount: 1,
    members: { fetch: async () => Promise.reject(new Error('x')) },
  };
  expect(await reconcileGuild(container.db, bad, now)).toBeUndefined();
  expect(departedAtOf('1')).toBeNull();
});

it('does nothing when the fetch looks incomplete', async () => {
  seed('1', 10, null);
  const ids = Array.from({ length: 94 }, (_, i) => String(1000 + i));
  expect(await reconcileGuild(container.db, guild(ids, 100), now)).toBeUndefined();
  expect(departedAtOf('1')).toBeNull();
});

it('does nothing when the guild reports no members', async () => {
  seed('1', 10, null);
  expect(await reconcileGuild(container.db, guild([], 0), now)).toBeUndefined();
  expect(departedAtOf('1')).toBeNull();
  expect(container.logger.warn).toHaveBeenCalled();
});

it('sends no log when there is nothing to do', async () => {
  seed('1', 10, null);
  const result = await reconcileGuild(container.db, guild(['1']), now);
  expect(result).toEqual({ departed: 0, restored: 0, purged: [], coinsRemoved: 0 });
  await Promise.resolve();
  expect(send).not.toHaveBeenCalled();
});

it('reconciles the second guild when the first fails, and resolves false', async () => {
  container.db
    .insert(wallets)
    .values({ guildId: '8', userId: '1', balance: 1, createdAt: 0 })
    .run();
  const bad = {
    id: '7',
    memberCount: 1,
    members: { fetch: async () => Promise.reject(new Error('x')) },
  };
  const good = guild(['99'], 1, '8');
  const client = {
    guilds: {
      cache: new Map([
        ['7', bad],
        ['8', good],
      ]),
    },
  } as unknown as Client<true>;
  const job = createMemberReconcileJob();
  expect(job.name).toBe('member-reconcile');
  expect(job.everyMs).toBe(86_400_000);
  expect(await job.run(client, now)).toBe(false);
  const w = container.db
    .select()
    .from(wallets)
    .all()
    .find((x) => x.guildId === '8');
  expect(w?.departedAt).toBe(now);
});

it('resolves true when every guild reconciles, honouring a single guild id (uncached guild retries)', async () => {
  const client = {
    guilds: { cache: new Map([['8', guild(['99'], 1, '8')]]) },
  } as unknown as Client<true>;
  expect(await createMemberReconcileJob().run(client, now)).toBe(true);
  expect(await createMemberReconcileJob('8').run(client, now)).toBe(true);
  expect(await createMemberReconcileJob('9').run(client, now)).toBe(false);
});

it('checks individual members before purging from an incomplete roster', async () => {
  const ids = Array.from({ length: 95 }, (_, i) => String(1000 + i));
  seed('1', 20, 0);
  await reconcileGuild(
    container.db,
    guild(ids, 100, '2', async () => {
      throw new Error('timeout');
    }),
    now,
  );
  expect(departedAtOf('1')).toBe(0);
  await reconcileGuild(
    container.db,
    guild(ids, 100, '2', async () => {}),
    now,
  );
  expect(departedAtOf('1')).toBeNull();
  expect(container.db.select().from(wallets).get()?.balance).toBe(20);
});

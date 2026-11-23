import { container } from '@sapphire/framework';
import { Events } from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { wallets } from '../src/db/schema.js';
import { screeningJob } from '../src/features/settings/screening.js';
import { addAutoRole, autoRoles, setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';

let client: ReturnType<typeof createClient>;
let add: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
  add = vi.fn(async () => ({}));
  send = vi.fn(async () => ({}));
  client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
  setLogChannel(container.db, '2', 'mod', '50', 1);
  addAutoRole(container.db, '2', '10', 'member', 1);
});

function member(pending: boolean) {
  return {
    pending,
    joinedTimestamp: 42,
    user: { id: '7', bot: false },
    guild: {
      id: '2',
      roles: {
        cache: new Map([
          [
            '10',
            {
              id: '10',
              guild: { id: '2' },
              position: 2,
              managed: false,
              permissions: { bitfield: 0n },
            },
          ],
        ]),
      },
      members: { me: { roles: { highest: { position: 10 } }, permissions: { has: () => true } } },
    },
    roles: { add },
  } as never;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

it('assigns on join for a non-pending member', async () => {
  client.emit(Events.GuildMemberAdd, member(false));
  await settle();
  expect(add).toHaveBeenCalledWith(['10'], 'auto-role');
});

it('waits on join for a pending member', async () => {
  client.emit(Events.GuildMemberAdd, member(true));
  await settle();
  expect(add).not.toHaveBeenCalled();
});

it('assigns when screening completes', async () => {
  client.emit(Events.GuildMemberUpdate, member(true), member(false));
  await settle();
  expect(add).toHaveBeenCalledTimes(1);
});

it('ignores updates that do not complete screening', async () => {
  client.emit(Events.GuildMemberUpdate, member(false), member(false));
  await settle();
  expect(add).not.toHaveBeenCalled();
});

it('removes a deleted role from both lists and logs once', async () => {
  addAutoRole(container.db, '2', '5', 'member', 2);
  addAutoRole(container.db, '2', '5', 'bot', 2);
  client.emit(Events.GuildRoleDelete, { id: '5', guild: { id: '2' } } as never);
  await settle();
  expect(autoRoles(container.db, '2', 'member')).toEqual(['10']);
  expect(autoRoles(container.db, '2', 'bot')).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
});

describe('leave and rejoin', () => {
  const addWallet = () =>
    container.db
      .insert(wallets)
      .values({ guildId: '2', userId: '7', balance: 40, createdAt: 0 })
      .run();
  const wallet = () => container.db.select().from(wallets).get();

  it('marks a leaver departed and logs it', async () => {
    addWallet();
    setLogChannel(container.db, '2', 'economy', '50', 1);
    client.emit(Events.GuildMemberRemove, member(false));
    await settle();
    expect(wallet()?.departedAt).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('posts nothing when the leaver has no wallet', async () => {
    setLogChannel(container.db, '2', 'economy', '50', 1);
    client.emit(Events.GuildMemberRemove, member(false));
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it('restores on rejoin and logs it', async () => {
    addWallet();
    container.db.update(wallets).set({ departedAt: 5 }).run();
    setLogChannel(container.db, '2', 'economy', '50', 1);
    client.emit(Events.GuildMemberAdd, member(false));
    await settle();
    expect(wallet()?.departedAt).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('restores a pending rejoiner without assigning roles', async () => {
    addWallet();
    container.db.update(wallets).set({ departedAt: 5 }).run();
    client.emit(Events.GuildMemberAdd, member(true));
    await settle();
    expect(wallet()?.departedAt).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });
});

it('uses a saved join after cache loss and consumes it once', async () => {
  client.emit(Events.GuildMemberAdd, member(true));
  await settle();
  client.emit(Events.GuildMemberUpdate, member(false), member(false));
  await settle();
  client.emit(Events.GuildMemberUpdate, member(false), member(false));
  await settle();
  expect(add).toHaveBeenCalledTimes(1);
});

it('recovers offline screening completion and retries a failed role assignment', async () => {
  client.emit(Events.GuildMemberAdd, member(true));
  await settle();
  const fetch = vi.fn(async () => member(false));
  const recoveredClient = { guilds: { cache: new Map([['2', { members: { fetch } }]]) } } as never;
  add.mockRejectedValueOnce(new Error('unavailable'));
  for (let attempt = 0; attempt < 3; attempt++) await screeningJob.run(recoveredClient, 1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(add).toHaveBeenCalledTimes(2);
});

import { container } from '@sapphire/framework';
import { Events, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { findWallet } from '../src/features/economy/index.js';
import { setHoneypot } from '../src/features/honeypot/index.js';
import { testEnv } from './support/env.js';

let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
});

function makeMessage(content: string, overrides: Record<string, unknown> = {}) {
  return {
    content,
    createdTimestamp: 1000,
    author: { bot: false, id: '1' },
    webhookId: null,
    system: false,
    guild: { id: '2', members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) } },
    guildId: '2',
    channelId: '3',
    channel: {
      id: '3',
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
    },
    client,
    reply: vi.fn(async () => ({ createdTimestamp: 1042, edit: vi.fn() })),
    ...overrides,
  };
}

it('rewards a plain message', async () => {
  client.emit(Events.MessageCreate, makeMessage('hello') as never);
  await vi.waitFor(() => expect(findWallet(container.db, '2', '1')?.balance).toBe(1_005), {
    timeout: 2000,
  });
});

it('ignores commands and bots', async () => {
  client.emit(Events.MessageCreate, makeMessage('?ping') as never);
  client.emit(
    Events.MessageCreate,
    makeMessage('hello', { author: { bot: true, id: '1' } }) as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(findWallet(container.db, '2', '1')).toBeUndefined();
});

it('pays nothing in the honeypot channel', async () => {
  setHoneypot(container.db, '2', '3', 'card-1', 1);
  // staff member so the honeypot listener ignores it; only the reward skip is under test
  client.emit(
    Events.MessageCreate,
    makeMessage('hello', {
      member: {
        joinedTimestamp: 0,
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages),
        roles: { highest: { position: 1 } },
      },
    }) as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(findWallet(container.db, '2', '1')).toBeUndefined();
});

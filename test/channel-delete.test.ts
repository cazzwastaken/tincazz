import { container } from '@sapphire/framework';
import { Events } from 'discord.js';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { honeypot, incrementKicks, setHoneypot } from '../src/features/honeypot/index.js';
import { logChannelId, setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';

let client: ReturnType<typeof createClient>;
let send: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
  send = vi.fn(async () => ({}));
  client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
});

it('clears both log kinds that pointed at a deleted channel', async () => {
  setLogChannel(container.db, '2', 'economy', '50', 1);
  setLogChannel(container.db, '2', 'mod', '50', 1);
  client.emit(Events.ChannelDelete, { id: '50', guildId: '2' } as never);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(logChannelId(container.db, '2', 'economy')).toBeUndefined();
  expect(logChannelId(container.db, '2', 'mod')).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

it('clears a deleted honeypot channel, keeps the kicks and logs it', async () => {
  setLogChannel(container.db, '2', 'mod', '50', 1);
  setHoneypot(container.db, '2', '70', 'card-1', 1);
  incrementKicks(container.db, '2', 2);
  client.emit(Events.ChannelDelete, { id: '70', guildId: '2' } as never);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(honeypot(container.db, '2')).toEqual({
    channelId: undefined,
    messageId: undefined,
    kicks: 1,
  });
  expect(JSON.stringify(send.mock.calls[0])).toContain('Honeypot channel <#70> was removed');
});

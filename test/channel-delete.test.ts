import { container } from '@sapphire/framework';
import { Events } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import {
  addHallExempt,
  hallExemptChannels,
  hallSettings,
  setHallChannel,
  setHallThreshold,
} from '../src/features/halloffame/index.js';
import { honeypot, incrementKicks, setHoneypot } from '../src/features/honeypot/index.js';
import {
  addGameChannel,
  gameChannelDenied,
  gameChannels,
} from '../src/features/settings/game-channels.js';
import { logChannelId, setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';
import { installNativeHallRunner, stubHallRunner } from './support/hall-runner-stub.js';

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

it('preserves the game restriction and never sends to the deleted mod log', async () => {
  setLogChannel(container.db, '2', 'economy', '50', 1);
  setLogChannel(container.db, '2', 'mod', '50', 1);
  addGameChannel(container.db, '2', '50', 1);
  client.emit(Events.ChannelDelete, { id: '50', guildId: '2' } as never);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(logChannelId(container.db, '2', 'economy')).toBeUndefined();
  expect(logChannelId(container.db, '2', 'mod')).toBeUndefined();
  expect(gameChannels(container.db, '2')).toEqual([]);
  expect(gameChannelDenied(container.db, '2', '50')).toContain('Games are paused');
  expect(send).not.toHaveBeenCalled();
});

it('notifies the mod log of a removed game channel while another is still allowed', async () => {
  setLogChannel(container.db, '2', 'mod', '50', 1);
  addGameChannel(container.db, '2', '70', 1);
  addGameChannel(container.db, '2', '71', 2);
  client.emit(Events.ChannelDelete, { id: '70', guildId: '2' } as never);

  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const notice = JSON.stringify(send.mock.calls[0]);
  expect(notice).toContain('Game channel <#70> was removed');
  expect(notice).not.toContain('Games are paused');
  expect(gameChannels(container.db, '2')).toEqual(['71']);
  expect(gameChannelDenied(container.db, '2', '71')).toBeUndefined();
});

it('logs the pause only after the deleted channel settings are committed', async () => {
  setLogChannel(container.db, '2', 'mod', '50', 1);
  setLogChannel(container.db, '2', 'economy', '70', 1);
  addGameChannel(container.db, '2', '70', 1);
  send.mockImplementation(async () => ({
    inTransaction: container.db.$client.inTransaction,
    economyLog: logChannelId(container.db, '2', 'economy'),
    denial: gameChannelDenied(container.db, '2', '71'),
  }));
  client.emit(Events.ChannelDelete, { id: '70', guildId: '2' } as never);

  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  const gameNotice = send.mock.calls.findIndex((args) =>
    JSON.stringify(args).includes('Game channel <#70> was removed'),
  );
  expect(gameNotice).not.toBe(-1);
  expect(JSON.stringify(send.mock.calls[gameNotice])).toContain('Games are paused');
  await expect(send.mock.results[gameNotice]?.value).resolves.toEqual({
    inTransaction: false,
    economyLog: undefined,
    denial: expect.stringContaining('Games are paused'),
  });
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

describe('hall of fame channel deletes', () => {
  let runner: ReturnType<typeof stubHallRunner>;
  let uninstall: () => void;
  beforeEach(() => {
    setLogChannel(container.db, '2', 'mod', '50', 1);
    runner = stubHallRunner();
    uninstall = installNativeHallRunner(runner);
  });
  afterEach(() => uninstall());

  const notices = () => send.mock.calls.map((args) => JSON.stringify(args));

  it('clears a deleted hall channel once, keeps the threshold and logs it', async () => {
    setHallChannel(container.db, '2', '70', 1);
    setHallThreshold(container.db, '2', 9, 1);
    // Discord sends the cached event and the raw packet for the same deletion.
    client.emit(Events.ChannelDelete, { id: '70', guildId: '2' } as never);
    client.emit(Events.Raw, { t: 'CHANNEL_DELETE', d: { id: '70', guild_id: '2' } } as never);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hallSettings(container.db, '2')).toEqual({ channelId: undefined, threshold: 9 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(notices()[0]).toContain('Hall of Fame channel <#70> was removed');
    // The runner drops the entries that lived there; the setting is not its business.
    expect(runner.onHallChannelDeleted).toHaveBeenCalledExactlyOnceWith('70');
    expect(runner.onSourceChannelDeleted).toHaveBeenCalledExactlyOnceWith('70');
  });

  it('removes a deleted channel or category from the exempt list and logs it', async () => {
    addHallExempt(container.db, '2', '71', 1);
    addHallExempt(container.db, '2', '72', 2);
    setHallChannel(container.db, '2', '73', 1);
    client.emit(Events.ChannelDelete, { id: '71', guildId: '2' } as never);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(hallExemptChannels(container.db, '2')).toEqual(['72']);
    expect(hallSettings(container.db, '2').channelId).toBe('73');
    expect(notices()[0]).toContain('Hall of Fame exempt channel <#71> was removed');
  });

  it('does nothing for a channel the hall does not know', async () => {
    setHallChannel(container.db, '2', '73', 1);
    addHallExempt(container.db, '2', '72', 1);
    client.emit(Events.ChannelDelete, { id: '99', guildId: '2' } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
    expect(hallSettings(container.db, '2').channelId).toBe('73');
    expect(hallExemptChannels(container.db, '2')).toEqual(['72']);
  });

  it('clears the hall channel in every guild that used it, in one transaction', async () => {
    setHallChannel(container.db, '2', '70', 1);
    setHallChannel(container.db, '3', '70', 1);
    client.emit(Events.ChannelDelete, { id: '70', guildId: '2' } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hallSettings(container.db, '2').channelId).toBeUndefined();
    expect(hallSettings(container.db, '3').channelId).toBeUndefined();
  });
});

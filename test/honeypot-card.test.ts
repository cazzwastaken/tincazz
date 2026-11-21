import { container } from '@sapphire/framework';
import { Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import {
  deleteCard,
  ensureAllCards,
  ensureCard,
  honeypot,
  honeypotConfig,
  honeypotDm,
  honeypotWarningCard,
  incrementKicks,
  onCardDeleted,
  resetCardSync,
  scheduleCardRefresh,
  setHoneypot,
} from '../src/features/honeypot/index.js';
import { testEnv } from './support/env.js';

describe('honeypot copy', () => {
  it('pins the spec values', () => {
    expect(honeypotConfig.deleteMessageSeconds).toBe(3600);
    expect(honeypotConfig.cooldownMs).toBe(60_000);
    expect(honeypotConfig.cardDebounceMs).toBe(3_000);
    expect(honeypotConfig.staffPermission).toBe(PermissionFlagsBits.ManageMessages);
  });
  it('shows the warning copy and kick count', () => {
    const out = JSON.stringify(honeypotWarningCard(1234));
    expect(out).toContain('DO NOT SEND MESSAGES IN THIS CHANNEL');
    expect(out).toContain(
      'This channel is used to catch spam bots. Any messages sent here will result in a **softban**.',
    );
    expect(out).toContain('🍯 Kicks: 1,234');
  });
  it('names the server in the DM', () => {
    const text = honeypotDm('Cazz');
    for (const needle of ['**Cazz**', 'compromised', 'password', 'rejoin']) {
      expect(text).toContain(needle);
    }
  });
});

function honeypotChannel(id: string) {
  return {
    id,
    isSendable: () => true,
    send: vi.fn(async (_options: unknown): Promise<{ id: string }> => ({ id: 'card-2' })),
    messages: {
      edit: vi.fn(async (_id: string, _options: unknown): Promise<unknown> => ({})),
      delete: vi.fn(async (_id: string): Promise<void> => undefined),
    },
  };
}

type ChannelStub = ReturnType<typeof honeypotChannel>;

let client: ReturnType<typeof createClient>;
let channel: ChannelStub;
const unknownMessage = Object.assign(new Error('Unknown Message'), { code: 10008 });

function putChannel(id: string): ChannelStub {
  const stub = honeypotChannel(id);
  client.channels.cache.set(id, stub as never);
  return stub;
}

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
  resetCardSync();
  channel = putChannel('70');
  setHoneypot(container.db, '2', '70', 'card-1', 1);
});

afterEach(() => {
  resetCardSync();
  vi.useRealTimers();
  client.guilds.cache.clear();
});

describe('honeypot card sync', () => {
  it('edits the stored card with the current count', async () => {
    incrementKicks(container.db, '2', 2);
    expect(await ensureCard('2')).toBe('edited');
    expect(channel.messages.edit).toHaveBeenCalledWith('card-1', expect.anything());
    expect(JSON.stringify(channel.messages.edit.mock.calls[0])).toContain('🍯 Kicks: 1');
  });

  it('re-posts and stores the new ID when the card is gone', async () => {
    channel.messages.edit.mockRejectedValueOnce(unknownMessage);
    expect(await ensureCard('2')).toBe('reposted');
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0]?.[0]).toMatchObject({ flags: MessageFlags.IsComponentsV2 });
    expect(channel.send.mock.calls[0]?.[0]).not.toHaveProperty('allowedMentions');
    expect(honeypot(container.db, '2').messageId).toBe('card-2');
  });

  it('does not duplicate the card on other errors', async () => {
    channel.messages.edit.mockRejectedValueOnce(
      Object.assign(new Error('Missing'), { code: 50013 }),
    );
    expect(await ensureCard('2')).toBe('failed');
    expect(channel.send).not.toHaveBeenCalled();
    expect(container.logger.warn).toHaveBeenCalled();
    expect(honeypot(container.db, '2').messageId).toBe('card-1');
  });

  it('fails without throwing when the channel is not sendable', async () => {
    client.channels.cache.set('70', { id: '70', isSendable: () => false } as never);
    expect(await ensureCard('2')).toBe('failed');
    expect(container.logger.warn).toHaveBeenCalled();
  });

  it('returns unset without a honeypot', async () => {
    expect(await ensureCard('3')).toBe('unset');
    expect(channel.messages.edit).not.toHaveBeenCalled();
  });

  it('serializes concurrent refreshes so a missing card is posted once', async () => {
    channel.messages.edit.mockRejectedValueOnce(unknownMessage);
    expect(await Promise.all([ensureCard('2'), ensureCard('2')])).toEqual(['reposted', 'edited']);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.messages.edit).toHaveBeenLastCalledWith('card-2', expect.anything());
  });

  it('drops a re-posted card when the honeypot moved meanwhile', async () => {
    channel.messages.edit.mockRejectedValueOnce(unknownMessage);
    channel.send.mockImplementationOnce(async () => {
      setHoneypot(container.db, '2', '71', 'card-x', 5);
      return { id: 'card-2' };
    });
    expect(await ensureCard('2')).toBe('stale');
    expect(channel.messages.delete).toHaveBeenCalledWith('card-2');
    expect(honeypot(container.db, '2').messageId).toBe('card-x');
  });

  it('coalesces refreshes per guild into one edit with the latest count', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      incrementKicks(container.db, '2', i);
      scheduleCardRefresh('2');
      await vi.advanceTimersByTimeAsync(900);
    }
    // t = 2700
    expect(channel.messages.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300); // t = 3000
    expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(channel.messages.edit.mock.calls[0])).toContain('🍯 Kicks: 3');
    scheduleCardRefresh('2');
    await vi.advanceTimersByTimeAsync(honeypotConfig.cardDebounceMs);
    expect(channel.messages.edit).toHaveBeenCalledTimes(2); // a new window after the edit
  });

  it('debounces each guild on its own timer', async () => {
    vi.useFakeTimers();
    const other = putChannel('80');
    setHoneypot(container.db, '3', '80', 'card-3', 1);
    scheduleCardRefresh('2');
    await vi.advanceTimersByTimeAsync(1_000);
    scheduleCardRefresh('3');
    scheduleCardRefresh('2');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    expect(other.messages.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    expect(other.messages.edit).toHaveBeenCalledTimes(1);
    expect(other.messages.edit).toHaveBeenCalledWith('card-3', expect.anything());
  });

  it('deletes a card best effort', async () => {
    expect(await deleteCard('70', 'card-1')).toBe(true);
    expect(channel.messages.delete).toHaveBeenCalledWith('card-1');
    channel.messages.delete.mockRejectedValueOnce(unknownMessage);
    expect(await deleteCard('70', 'card-1')).toBe(false);
  });

  it('refreshes every honeypot guild the bot is in, staggered', async () => {
    vi.useFakeTimers();
    const third = putChannel('80');
    const absent = putChannel('90');
    setHoneypot(container.db, '3', '80', 'card-3', 1);
    setHoneypot(container.db, '4', '90', 'card-4', 1);
    client.guilds.cache.set('2', { id: '2' } as never);
    client.guilds.cache.set('3', { id: '3' } as never);
    const done = ensureAllCards();
    await vi.advanceTimersByTimeAsync(0);
    expect(channel.messages.edit).toHaveBeenCalledTimes(1);
    expect(third.messages.edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(honeypotConfig.readyStaggerMs);
    expect(third.messages.edit).toHaveBeenCalledTimes(1);
    await done;
    expect(absent.messages.edit).not.toHaveBeenCalled();
    expect(absent.send).not.toHaveBeenCalled();
  });

  it('re-posts only when the deleted message is the stored card', async () => {
    channel.messages.edit.mockRejectedValue(unknownMessage);
    expect(await onCardDeleted({ id: 'old', guildId: '2' })).toBe(false);
    expect(await onCardDeleted({ id: 'card-1', guildId: null })).toBe(false);
    expect(await onCardDeleted({ id: 'card-1', guildId: '2' })).toBe(true);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('re-posts the card through the messageDelete listener', async () => {
    channel.messages.edit.mockRejectedValue(unknownMessage);
    client.emit(Events.MessageDelete, {
      id: 'card-1',
      guildId: '2',
      channelId: '70',
      partial: true,
    } as never);
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledTimes(1));
    expect(honeypot(container.db, '2').messageId).toBe('card-2');
  });

  it('ignores the delete of a card the store no longer points at', async () => {
    setHoneypot(container.db, '2', '71', 'card-9', 2); // moved: the bot then deletes card-1 itself
    client.emit(Events.MessageDelete, {
      id: 'card-1',
      guildId: '2',
      channelId: '70',
      partial: true,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.messages.edit).not.toHaveBeenCalled();
  });
});

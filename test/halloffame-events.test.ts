import { container } from '@sapphire/framework';
import { Events } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { testEnv } from './support/env.js';
import { installNativeHallRunner, stubHallRunner } from './support/hall-runner-stub.js';

let mocked = stubHallRunner();

describe('hall of fame events', () => {
  let client: ReturnType<typeof createClient>;
  let error: ReturnType<typeof vi.fn>;

  let uninstall: (() => void) | undefined;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(async () => {
    mocked = stubHallRunner();
    uninstall = installNativeHallRunner(mocked);
    container.db = openDatabase(':memory:');
    error = vi.fn();
    container.logger = { error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never;
  });

  afterEach(() => {
    uninstall?.();
    client.users.cache.clear();
  });

  const emit = (t: string, d: Record<string, unknown>) =>
    client.emit(Events.Raw, { t, d } as never);
  const reaction = (extra: Record<string, unknown> = {}) => ({
    guild_id: '10',
    channel_id: '20',
    message_id: '30',
    user_id: '5',
    emoji: { id: null, name: '⭐' },
    ...extra,
  });
  /** The other raw listeners (polls) log into the same logger without a database here. */
  const hallErrors = () =>
    error.mock.calls.filter(([message]) => String(message).includes('hall of fame'));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  describe('reaction added', () => {
    it('passes the reaction on, with the author when Discord says who it is', () => {
      emit('MESSAGE_REACTION_ADD', reaction({ message_author_id: '7' }));
      expect(mocked.onReactionAdd).toHaveBeenCalledWith({
        guildId: '10',
        channelId: '20',
        messageId: '30',
        userId: '5',
        messageAuthorId: '7',
        isBot: false,
        burst: false,
        emoji: { id: null, name: '⭐' },
      });
    });

    it('leaves the author out when the payload has none', () => {
      emit('MESSAGE_REACTION_ADD', reaction());
      expect(mocked.onReactionAdd.mock.calls[0]?.[0].messageAuthorId).toBeUndefined();
    });

    it('flags a bot reactor from the member payload', () => {
      emit('MESSAGE_REACTION_ADD', reaction({ member: { user: { bot: true } } }));
      expect(mocked.onReactionAdd.mock.calls[0]?.[0].isBot).toBe(true);
    });

    it('flags a bot reactor from the user cache', () => {
      client.users.cache.set('5', { id: '5', bot: true } as never);
      emit('MESSAGE_REACTION_ADD', reaction());
      expect(mocked.onReactionAdd.mock.calls[0]?.[0].isBot).toBe(true);
    });

    it('flags a super reaction', () => {
      emit('MESSAGE_REACTION_ADD', reaction({ burst: true }));
      expect(mocked.onReactionAdd.mock.calls[0]?.[0].burst).toBe(true);
    });

    it('ignores a reaction in a direct message', () => {
      emit('MESSAGE_REACTION_ADD', reaction({ guild_id: undefined }));
      expect(mocked.onReactionAdd).not.toHaveBeenCalled();
    });
  });

  describe('reaction removed or cleared', () => {
    it.each([
      'MESSAGE_REACTION_REMOVE',
      'MESSAGE_REACTION_REMOVE_EMOJI',
      'MESSAGE_REACTION_REMOVE_ALL',
    ])('%s refreshes the message', (t) => {
      emit(t, reaction());
      expect(mocked.onReactionChange).toHaveBeenCalledWith({
        guildId: '10',
        channelId: '20',
        messageId: '30',
      });
      expect(mocked.onReactionAdd).not.toHaveBeenCalled();
    });

    it.each([
      'MESSAGE_REACTION_REMOVE',
      'MESSAGE_REACTION_REMOVE_EMOJI',
      'MESSAGE_REACTION_REMOVE_ALL',
    ])('%s in a direct message is ignored', (t) => {
      emit(t, reaction({ guild_id: undefined }));
      expect(mocked.onReactionChange).not.toHaveBeenCalled();
    });

    it('does not refresh for a super reaction taken back', () => {
      emit('MESSAGE_REACTION_REMOVE', reaction({ burst: true }));
      expect(mocked.onReactionChange).not.toHaveBeenCalled();
    });
  });

  describe('message update', () => {
    it('re-renders a guild message', () => {
      emit('MESSAGE_UPDATE', { id: '30', guild_id: '10', channel_id: '20' });
      expect(mocked.onMessageUpdate).toHaveBeenCalledWith('10', '30');
    });

    it('ignores a direct message', () => {
      emit('MESSAGE_UPDATE', { id: '30', channel_id: '20' });
      expect(mocked.onMessageUpdate).not.toHaveBeenCalled();
    });
  });

  describe('message delete', () => {
    it('handles the message as both a source and a hall post', async () => {
      emit('MESSAGE_DELETE', { id: '30', guild_id: '10', channel_id: '20' });
      await flush();
      expect(mocked.onSourceMessagesDeleted).toHaveBeenCalledWith('10', ['30']);
      expect(mocked.onHallMessagesDeleted).toHaveBeenCalledWith('10', ['30']);
    });

    it('does the same for a bulk delete', async () => {
      emit('MESSAGE_DELETE_BULK', { ids: ['30', '31'], guild_id: '10', channel_id: '20' });
      await flush();
      expect(mocked.onSourceMessagesDeleted).toHaveBeenCalledWith('10', ['30', '31']);
      expect(mocked.onHallMessagesDeleted).toHaveBeenCalledWith('10', ['30', '31']);
    });

    it('ignores direct messages', () => {
      emit('MESSAGE_DELETE', { id: '30', channel_id: '20' });
      emit('MESSAGE_DELETE_BULK', { ids: ['30'], channel_id: '20' });
      expect(mocked.onSourceMessagesDeleted).not.toHaveBeenCalled();
      expect(mocked.onHallMessagesDeleted).not.toHaveBeenCalled();
    });

    it('logs a failing delete instead of throwing', async () => {
      mocked.onSourceMessagesDeleted.mockRejectedValueOnce(new Error('boom'));
      expect(() => emit('MESSAGE_DELETE', { id: '30', guild_id: '10' })).not.toThrow();
      await flush();
      expect(hallErrors()).toHaveLength(1);
    });
  });

  describe('channel delete', () => {
    it('removes the posts that came from it and the ones that lived in it', async () => {
      emit('CHANNEL_DELETE', { id: '20', guild_id: '10', type: 0 });
      await flush();
      expect(mocked.onSourceChannelDeleted).toHaveBeenCalledWith('20');
      expect(mocked.onHallChannelDeleted).toHaveBeenCalledWith('20');
    });

    it('removes the posts that came from a deleted thread only', async () => {
      emit('THREAD_DELETE', { id: '21', guild_id: '10', parent_id: '20', type: 11 });
      await flush();
      expect(mocked.onSourceChannelDeleted).toHaveBeenCalledWith('21');
      expect(mocked.onHallChannelDeleted).not.toHaveBeenCalled();
    });

    it('logs a failing cleanup instead of throwing', async () => {
      mocked.onSourceChannelDeleted.mockRejectedValueOnce(new Error('boom'));
      expect(() => emit('CHANNEL_DELETE', { id: '20', guild_id: '10' })).not.toThrow();
      await flush();
      expect(hallErrors()).toHaveLength(1);
    });
  });

  describe('malformed or unrelated packets', () => {
    it('never throws, and logs a handler that does', () => {
      const bad: [string, unknown][] = [
        ['MESSAGE_REACTION_ADD', undefined],
        ['MESSAGE_REACTION_ADD', null],
        ['MESSAGE_REACTION_ADD', {}],
        ['MESSAGE_REACTION_ADD', { guild_id: '10' }],
        ['MESSAGE_REACTION_REMOVE', {}],
        ['MESSAGE_REACTION_REMOVE_ALL', 'x'],
        ['MESSAGE_UPDATE', {}],
        ['MESSAGE_DELETE', {}],
        ['MESSAGE_DELETE_BULK', { guild_id: '10' }],
        ['MESSAGE_DELETE_BULK', { guild_id: '10', ids: 'nope' }],
        ['CHANNEL_DELETE', {}],
        ['THREAD_DELETE', {}],
        ['PRESENCE_UPDATE', {}],
      ];
      for (const [t, d] of bad) {
        expect(() => client.emit(Events.Raw, { t, d } as never), t).not.toThrow();
      }
      expect(mocked.onReactionAdd).not.toHaveBeenCalled();
      expect(mocked.onReactionChange).not.toHaveBeenCalled();
      expect(mocked.onMessageUpdate).not.toHaveBeenCalled();
      expect(mocked.onSourceMessagesDeleted).not.toHaveBeenCalled();
      expect(mocked.onSourceChannelDeleted).not.toHaveBeenCalled();
    });

    it('logs and survives a runner that throws', () => {
      mocked.onReactionAdd.mockImplementationOnce(() => {
        throw new Error('boom');
      });
      expect(() => emit('MESSAGE_REACTION_ADD', reaction())).not.toThrow();
      expect(hallErrors()).toHaveLength(1);
    });
  });
});

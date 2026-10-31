import { container } from '@sapphire/framework';
import { Events } from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { findWallet } from '../src/features/economy/index.js';
import {
  addGameChannel,
  clearGameChannels,
  gameChannelDenied,
  gameChannels,
  removeGameChannel,
  removeGameChannelEverywhere,
} from '../src/features/settings/game-channels.js';
import { testEnv } from './support/env.js';
import { makeChatInput } from './support/interaction.js';

let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
});

const json = (value: unknown) => JSON.stringify(value);

describe('game channel store', () => {
  it('allows every channel by default', () => {
    expect(gameChannels(container.db, 'g')).toEqual([]);
    expect(gameChannelDenied(container.db, 'g', 'c1')).toBeUndefined();
  });

  it('limits the games to the listed channels', () => {
    expect(addGameChannel(container.db, 'g', 'c1', 1)).toBe('added');
    expect(addGameChannel(container.db, 'g', 'c1', 2)).toBe('exists');
    expect(addGameChannel(container.db, 'g', 'c2', 3)).toBe('added');
    expect(gameChannelDenied(container.db, 'g', 'c1')).toBeUndefined();
    expect(gameChannelDenied(container.db, 'g', 'c2')).toBeUndefined();
    expect(gameChannelDenied(container.db, 'g', 'c3')).toBe(
      'Games can only be played in <#c1>, <#c2>.',
    );
    // Another guild is unaffected.
    expect(gameChannelDenied(container.db, 'other', 'c3')).toBeUndefined();
  });

  it('treats a thread as its parent channel', () => {
    addGameChannel(container.db, 'g', 'c1', 1);
    const thread = { isThread: () => true, parentId: 'c1' };
    const other = { isThread: () => true, parentId: 'c9' };
    expect(gameChannelDenied(container.db, 'g', 't1', thread)).toBeUndefined();
    expect(gameChannelDenied(container.db, 'g', 't1', other)).toBeDefined();
  });

  it('caps the list', () => {
    for (let i = 0; i < 25; i++) addGameChannel(container.db, 'g', `c${i}`, i);
    expect(addGameChannel(container.db, 'g', 'extra', 99)).toBe('full');
  });

  it('removes, resets and cleans up deleted channels', () => {
    addGameChannel(container.db, 'g', 'c1', 1);
    addGameChannel(container.db, 'g', 'c2', 2);
    addGameChannel(container.db, 'h', 'c1', 3);
    expect(removeGameChannel(container.db, 'g', 'c2')).toBe(true);
    expect(removeGameChannel(container.db, 'g', 'c2')).toBe(false);
    expect(removeGameChannelEverywhere(container.db, 'c1').sort()).toEqual(['g', 'h']);
    expect(gameChannels(container.db, 'g')).toEqual([]);
    addGameChannel(container.db, 'g', 'c1', 4);
    expect(clearGameChannels(container.db, 'g')).toBe(1);
    expect(gameChannels(container.db, 'g')).toEqual([]);
  });
});

describe('game channel gating', () => {
  beforeEach(() => {
    // The runIn precondition fetches the channel over REST, which needs a token.
    vi.spyOn(client.channels, 'fetch').mockResolvedValue({
      id: '3',
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
    } as never);
  });

  async function slash(commandName: string, options: Record<string, unknown> = {}) {
    // The stub interaction is in channel '3' of guild '2'.
    const interaction = makeChatInput(client, { commandName, userId: '1', options });
    client.emit(Events.InteractionCreate, interaction as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return interaction;
  }

  it('refuses gamba, dice and coinflip outside the game channels, without touching coins', async () => {
    addGameChannel(container.db, '2', 'c1', 1);
    for (const name of ['gamba', 'dice']) {
      const interaction = await slash(name);
      expect(json(interaction.reply.mock.calls[0])).toContain('Games can only be played in <#c1>.');
    }
    const flip = makeChatInput(client, { commandName: 'coinflip', userId: '1', subcommand: 'bot' });
    client.emit(Events.InteractionCreate, flip as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(json(flip.reply.mock.calls[0])).toContain('Games can only be played in <#c1>.');
    expect(findWallet(container.db, '2', '1')).toBeUndefined();
  });

  it('plays normally in an allowed channel', async () => {
    addGameChannel(container.db, '2', '3', 1);
    const interaction = await slash('gamba');
    expect(json(interaction.reply.mock.calls[0])).not.toContain('Games can only');
    expect(findWallet(container.db, '2', '1')).toBeDefined();
  });

  it('leaves non-game commands alone', async () => {
    addGameChannel(container.db, '2', 'c1', 1);
    const interaction = await slash('balance');
    expect(json(interaction.reply.mock.calls[0])).toContain('<@1> has');
  });
});

describe('?bal and ?balance', () => {
  function message(content: string) {
    return {
      content,
      createdTimestamp: 1000,
      author: { bot: false, id: '1', toString: () => '<@1>' },
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
      reply: vi.fn(async () => ({})),
    };
  }

  it.each(['?bal', '?balance'])('%s shows the caller balance', async (content) => {
    const msg = message(content);
    client.emit(Events.MessageCreate, msg as never);
    await vi.waitFor(() => expect(msg.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(json(msg.reply.mock.calls[0])).toContain('<@1> has **1,000** coins');
    expect(findWallet(container.db, '2', '1')?.balance).toBe(1000);
  });
});

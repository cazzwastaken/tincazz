import { Events, MessageFlags } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { wager as flipWager } from '../src/features/coinflip/config.js';
import { wager as diceWager } from '../src/features/dice/config.js';
import { bailout, cashback, chatReward, collect, daily } from '../src/features/economy/config.js';
import { wager } from '../src/features/gamba/config.js';
import { helpCard } from '../src/features/help/index.js';
import { testEnv } from './support/env.js';
import { makeChatInput } from './support/interaction.js';

// Sapphire keeps global state, so share one client across the tests in this file.
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

const text = (prefix = '?') => JSON.stringify(helpCard(prefix).toJSON());
const n = (value: number) => value.toLocaleString('en-US');

describe('helpCard', () => {
  it('has the Games, Coins and Bets sections', () => {
    const card = text();
    for (const heading of ['## Games', '## Coins', '## Bets']) {
      expect(card).toContain(heading);
    }
  });

  it('lists each game in slash and prefix form with an example', () => {
    const card = text();
    for (const form of ['/gamba', '?gamba', '/coinflip', '?cf', '/dice', '?dice']) {
      expect(card).toContain(form);
    }
    for (const example of ['?gamba 50', '?cf 100 tails', '?dice =12 50']) {
      expect(card).toContain(example);
    }
  });

  it('uses the configured prefix', () => {
    const card = text('!');
    expect(card).toContain('!cf 100 tails');
    expect(card).toContain('!dice =12 50');
    expect(card).not.toContain('?cf');
  });

  it('builds the coin lines from the economy config', () => {
    const card = text();
    expect(card).toContain(`${n(daily.base)}`);
    expect(card).toContain(`${n(collect.perHour)} coins per hour`);
    expect(card).toContain(`up to ${collect.maxHours} hours`);
    expect(card).toContain(
      `\`/daily\`: ${n(daily.base)} coins plus ${n(daily.perStreakDay)} per streak day (up to ${daily.streakCap} days)`,
    );
    expect(card).toContain(
      `\`/bailout\`: ${n(bailout.base)} coins plus ${n(bailout.perStreakDay)} per daily streak day when you hold under ${n(bailout.belowBalance)} coins, every ${bailout.cooldownMs / 60_000} minutes`,
    );
    expect(card).toContain(`${n(chatReward.amount)} coins`);
    expect(card).toContain(`${cashback.percent}%`);
    expect(card).toContain(`up to ${n(cashback.max)}`);
  });

  it('builds a bets line per game from its wager limits', () => {
    const card = text();
    for (const [game, limits] of [
      ['Gamba', wager],
      ['Coinflip', flipWager],
      ['Dice', diceWager],
    ] as const) {
      expect(card).toContain(
        `${game}: ${n(limits.minBet)} to ${n(limits.maxBet)}, ${n(limits.defaultBet)} when you leave the bet out`,
      );
    }
    expect(card).toContain('all, half or 2.5k');
  });

  it('has a Fun section with the image commands', () => {
    const card = text();
    expect(card).toContain('## Fun');
    for (const entry of ['/bubble', '?bubble', '/meme', '?meme']) {
      expect(card).toContain(entry);
    }
  });

  it('lists every image command, so a new one cannot skip help', () => {
    const commands = [...client.stores.get('commands').values()].filter(
      (command) => command.category === 'image',
    );
    expect(commands.length).toBeGreaterThanOrEqual(2);
    const card = text();
    for (const command of commands) {
      expect(card, `/${command.name} is missing from /help`).toContain(`/${command.name}`);
    }
  });

  it('lists every misc command, so a new game cannot skip help', () => {
    const commands = [...client.stores.get('commands').values()].filter(
      (command) => command.category === 'misc',
    );
    expect(commands.length).toBeGreaterThanOrEqual(3);
    const card = text();
    for (const command of commands) {
      expect(card, `/${command.name} is missing from /help`).toContain(`/${command.name}`);
    }
  });
});

describe('help command', () => {
  it('?help replies with the card', async () => {
    const message = {
      content: '?help',
      createdTimestamp: 1000,
      author: { bot: false, id: '1' },
      webhookId: null,
      system: false,
      guild: { id: '2', members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) } },
      guildId: '2',
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
    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [options] = message.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(JSON.stringify(options)).toContain('## Games');
    expect(options.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(options.flags & MessageFlags.Ephemeral).toBeFalsy();
  });

  it('/help replies with the card, ephemeral', async () => {
    const interaction = makeChatInput(client, { commandName: 'help', userId: '1' });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(JSON.stringify(options)).toContain('## Bets');
    expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
  });
});

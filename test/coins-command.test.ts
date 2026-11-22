import { container, type SapphireClient } from '@sapphire/framework';
import {
  ApplicationCommandOptionType,
  ComponentType,
  type ContainerBuilder,
  Events,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { type LedgerReason, ledger, wallets } from '../src/db/schema.js';
import { testEnv } from './support/env.js';
import { makeChatInput } from './support/interaction.js';

let client: SapphireClient;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
});

afterEach(() => {
  closeDatabase(container.db);
});

async function historyText() {
  const interaction = makeChatInput(client, {
    commandName: 'coins',
    subcommand: 'history',
    guildId: '2',
    userId: '1',
  });
  client.emit(Events.InteractionCreate, interaction as never);
  await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
  const [reply] = interaction.reply.mock.calls[0] as unknown as [
    { components: [ContainerBuilder]; flags: number },
  ];
  expect(reply.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  expect(reply.components).toHaveLength(1);
  const card = reply.components[0].toJSON();
  expect(card.type).toBe(ComponentType.Container);
  return card.components.map((component) => {
    if (component.type !== ComponentType.TextDisplay) throw new Error('Expected a text-only card');
    return component.content;
  });
}

describe('/coins history', () => {
  it('registers a guild-only subcommand with no options', () => {
    const command = client.stores.get('commands').get('coins');
    const registerChatInputCommand = vi.fn(
      (build: (builder: SlashCommandBuilder) => SlashCommandBuilder) =>
        build(new SlashCommandBuilder()).toJSON(),
    );
    command?.registerApplicationCommands?.({ registerChatInputCommand } as never);
    expect(registerChatInputCommand.mock.results[0]?.value).toMatchObject({
      name: 'coins',
      contexts: [InteractionContextType.Guild],
      options: [{ name: 'history', type: ApplicationCommandOptionType.Subcommand, options: [] }],
    });
  });

  it('privately shows only the caller’s ten newest guild entries by id', async () => {
    // The timestamps are deliberately not in insertion order.
    const entries: [LedgerReason, number, number, number][] = [
      ['start', 1000, 1000, 500_000],
      ['daily', 25, 1025, 110_000],
      ['collect', 12, 1037, 206_000],
      ['chat', 3, 1040, 109_000],
      ['bet', -30, 1010, 108_000],
      ['payout', 60, 1070, 107_000],
      ['dice_bet', -6, 1064, 106_000],
      ['dice_win', 12, 1076, 105_000],
      ['flip_bet', -14, 1062, 104_000],
      ['flip_win', 26, 1088, 103_000],
      ['admin_take', -88, 1000, 102_000],
      ['free_prize', 1200, 2200, 101_000],
    ];
    const { db } = container;
    db.insert(ledger)
      .values(
        entries.map(([reason, delta, balanceAfter, createdAt]) => ({
          guildId: '2',
          userId: '1',
          reason,
          delta,
          balanceAfter,
          createdAt,
          ...(reason === 'admin_take' ? { note: 'Staff only', actorId: '98765', ref: 56789 } : {}),
        })),
      )
      .run();
    db.insert(ledger)
      .values([
        { guildId: '2', userId: '3', reason: 'start', delta: 999, balanceAfter: 999, createdAt: 1 },
        { guildId: '4', userId: '1', reason: 'start', delta: 998, balanceAfter: 998, createdAt: 1 },
      ])
      .run();
    const before = db.select().from(ledger).all();

    expect(await historyText()).toEqual([
      '## Coin history',
      [
        '**+1,200** coins · Free spin prize (legacy) · Balance after: 2,200 · <t:101:R>',
        '**-88** coins · Moderator deduction · Balance after: 1,000 · <t:102:R>',
        '**+26** coins · Coinflip win · Balance after: 1,088 · <t:103:R>',
        '**-14** coins · Coinflip bet · Balance after: 1,062 · <t:104:R>',
        '**+12** coins · Dice win · Balance after: 1,076 · <t:105:R>',
        '**-6** coins · Dice bet · Balance after: 1,064 · <t:106:R>',
        '**+60** coins · Gamba payout · Balance after: 1,070 · <t:107:R>',
        '**-30** coins · Gamba bet · Balance after: 1,010 · <t:108:R>',
        '**+3** coins · Chat reward · Balance after: 1,040 · <t:109:R>',
        '**+12** coins · Hourly collect · Balance after: 1,037 · <t:206:R>',
      ].join('\n'),
    ]);
    expect(db.select().from(ledger).all()).toEqual(before);
    expect(db.select().from(wallets).all()).toEqual([]);
  });

  it('privately reports no history without opening a wallet', async () => {
    expect(await historyText()).toEqual(['## Coin history', 'No coin history in this server yet.']);
    expect(container.db.select().from(wallets).all()).toEqual([]);
    expect(container.db.select().from(ledger).all()).toEqual([]);
  });
});

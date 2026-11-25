import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { container } from '@sapphire/framework';
import { Events, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { rolls } from '../src/db/schema.js';
import { clearBudgets, setFrameDelay } from '../src/features/animation/index.js';
import {
  type DiceCall,
  decodeCall,
  defaultCall,
  diceErrorText,
  diceUsage,
  type Roll,
  rollFrames,
  rollResult,
} from '../src/features/dice/index.js';
import {
  adminAdjust,
  debit,
  findWallet,
  getOrCreateWallet,
  InsufficientFundsError,
  startingBalance,
} from '../src/features/economy/index.js';
import { pot } from '../src/features/gamba/config.js';
import { setLogChannel } from '../src/features/settings/store.js';
import { cardReply } from '../src/features/ui/index.js';
import { testEnv } from './support/env.js';
import { makeChatInput } from './support/interaction.js';

// See gamba-command.test.ts: patch the real crypto.randomInt for natively loaded pieces.
function mockRandomInt(...values: number[]) {
  const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(values.at(-1) as never);
  for (const value of values.slice(0, -1).reverse()) {
    spy.mockReturnValueOnce(value as never);
  }
  syncBuiltinESMExports();
}

const json = (value: unknown) => JSON.stringify(value);
/** An edit as the card alone: edits also tell Discord to replace the old frame's attachment. */
const cardJson = (value: unknown) =>
  JSON.stringify(value, (key, item) => (key === 'attachments' ? undefined : item));

/** One reply for the first frame, then one edit per remaining frame plus the result. */
const editCount = (await rollFrames('1', { bet: 10, call: defaultCall, die1: 1 })).length;

/** The result card a settled 6 + 6 roll ends on, as the first roll in a fresh database. */
async function doubleSixCard(
  userId: string,
  bet: number,
  call: DiceCall,
  payout: number,
  edge: number,
) {
  const roll: Roll = {
    bet,
    call,
    die1: 6,
    die2: 6,
    total: 12,
    won: true,
    payout,
    edge,
    balance: startingBalance - bet + payout,
    pot: pot.seed + edge,
    rollId: 1,
  };
  return json(cardReply(await rollResult(userId, roll)));
}

const author = '100000000000000001';

type ReplyOptions = string | Record<string, unknown>;

function makeMessage(client: ReturnType<typeof createClient>, content: string) {
  const sent = { id: 'sent-1', edit: vi.fn(async (_options: unknown) => ({})) };
  return {
    content,
    createdTimestamp: 1000,
    author: { bot: false, id: author, toString: () => `<@${author}>` },
    webhookId: null,
    system: false,
    guild: { id: '2', members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) } },
    guildId: '2',
    member: { roles: { add: vi.fn(async () => undefined) } },
    channel: {
      id: '3',
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
      isSendable: () => true,
      permissionsFor: () => ({ has: () => true }),
    },
    client,
    reply: vi.fn(async (_options: ReplyOptions) => sent),
    sent,
  };
}

describe('/dice and ?dice', () => {
  // Sapphire keeps global state, so a second client in the same process loses its built-in
  // preconditions. Share one client across the tests in this file.
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    setFrameDelay(0);
    clearBudgets();
    // The runIn precondition fetches the channel over REST, which needs a token.
    vi.spyOn(client.channels, 'fetch').mockResolvedValue({
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
    } as never);
  });

  afterEach(() => {
    setFrameDelay(undefined);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  const rollRows = () => container.db.select().from(rolls).all();
  const drain = (userId: string, leave: number) => {
    getOrCreateWallet(container.db, '2', userId, 1);
    debit(container.db, {
      guildId: '2',
      userId,
      amount: startingBalance - leave,
      reason: 'bet',
      now: 2,
    });
  };

  it('registers /dice with an optional bet and the 14 calls, with ?roll as an alias', () => {
    const command = client.stores.get('commands').get('dice');
    expect(command?.aliases).toEqual(['roll']);

    let json: ReturnType<SlashCommandBuilder['toJSON']> | undefined;
    const registry = {
      registerChatInputCommand: (build: (builder: SlashCommandBuilder) => SlashCommandBuilder) => {
        json = build(new SlashCommandBuilder()).toJSON();
      },
    };
    command?.registerApplicationCommands?.(registry as never);

    const options = (json?.options ?? []) as {
      name: string;
      required?: boolean;
      choices?: { name: string; value: string }[];
    }[];
    expect(options.map((option) => option.name)).toEqual(['bet', 'on']);
    expect(options.every((option) => !option.required)).toBe(true);
    const choices = options[1]?.choices ?? [];
    expect(choices.map((choice) => choice.value)).toEqual([
      'h',
      'l',
      '7',
      'd',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
      'e8',
      'e9',
      'e10',
      'e11',
      'e12',
    ]);
    expect(choices.map((choice) => choice.name)).toEqual([
      'High',
      'Low',
      'Seven',
      'Doubles',
      'Exact 2',
      'Exact 3',
      'Exact 4',
      'Exact 5',
      'Exact 6',
      'Exact 8',
      'Exact 9',
      'Exact 10',
      'Exact 11',
      'Exact 12',
    ]);
    for (const { value } of choices) {
      expect(decodeCall(value)).toBeDefined();
    }
  });

  describe('/dice', () => {
    async function run(options: Record<string, unknown> = {}) {
      const interaction = makeChatInput(client, { commandName: 'dice', userId: '1', options });
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });
      return interaction;
    }

    it('with no options rolls 10 on high and animates to the roll card', async () => {
      mockRandomInt(5);
      const interaction = await run();

      // Coins move before the first frame is shown.
      expect(rollRows()).toMatchObject([{ bet: 10, call: 'high', target: null, die1: 6, die2: 6 }]);
      expect(json(interaction.reply.mock.calls[0])).toContain('tumbling');
      await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledTimes(editCount));
      expect(cardJson(interaction.editReply.mock.calls.at(-1)?.[0])).toBe(
        await doubleSixCard('1', 10, { kind: 'high' }, 24, 1),
      );
      // Every edit replaces the previous frame's picture rather than adding another attachment.
      for (const [edit] of interaction.editReply.mock.calls) {
        expect(edit).toMatchObject({ attachments: [] });
      }
      expect(findWallet(container.db, '2', '1')?.balance).toBe(startingBalance - 10 + 24);
    });

    it('on:e12 bet:50 settles an exact 12', async () => {
      mockRandomInt(5);
      const interaction = await run({ on: 'e12', bet: '50' });

      expect(rollRows()).toMatchObject([{ bet: 50, call: 'exact', target: 12, won: 1 }]);
      await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledTimes(editCount));
      expect(cardJson(interaction.editReply.mock.calls.at(-1)?.[0])).toBe(
        await doubleSixCard('1', 50, { kind: 'exact', target: 12 }, 1_782, 1),
      );
    });

    it('replies ephemerally with the funds error and settles nothing', async () => {
      drain('1', 50);
      const interaction = await run({ bet: '100' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain(
        json(diceErrorText(new InsufficientFundsError(50, 100))).slice(1, -1),
      );
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(rollRows()).toHaveLength(0);
    });
  });

  describe('economy log', () => {
    let send: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      send = vi.fn(async () => ({}));
      client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
      setLogChannel(container.db, '2', 'economy', '50', 1);
      adminAdjust(container.db, {
        guildId: '2',
        userId: '1',
        actorId: '9',
        action: 'give',
        amount: 5_000,
        reason: 'setup',
        now: 1,
      });
    });

    async function run(options: Record<string, unknown>) {
      const interaction = makeChatInput(client, { commandName: 'dice', userId: '1', options });
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalledTimes(editCount), {
        timeout: 2000,
      });
      return interaction;
    }

    it('keeps a 5,000 roll out of the log', async () => {
      mockRandomInt(0);
      await run({ bet: '5000', on: 'h' });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(send).not.toHaveBeenCalled();
    });

    it('does not log a small roll', async () => {
      mockRandomInt(0);
      await run({ bet: '100' });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('?dice', () => {
    async function run(content: string) {
      const message = makeMessage(client, content);
      client.emit(Events.MessageCreate, message as never);
      await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
      return message;
    }

    const firstReply = (message: ReturnType<typeof makeMessage>) =>
      message.reply.mock.calls[0]?.[0] as ReplyOptions;

    it('?dice =12 50 settles an exact 12 and edits the sent card to the result', async () => {
      mockRandomInt(5);
      const message = await run('?dice =12 50');

      expect(rollRows()).toMatchObject([{ bet: 50, call: 'exact', target: 12, won: 1 }]);
      expect(json(firstReply(message))).toContain('tumbling');
      await vi.waitFor(() => expect(message.sent.edit).toHaveBeenCalledTimes(editCount));
      expect(cardJson(message.sent.edit.mock.calls.at(-1)?.[0])).toBe(
        await doubleSixCard(author, 50, { kind: 'exact', target: 12 }, 1_782, 1),
      );
    });

    it('?roll with no args rolls 10 on high', async () => {
      mockRandomInt(0);
      const message = await run('?roll');

      await vi.waitFor(() => expect(message.sent.edit).toHaveBeenCalledTimes(editCount));
      expect(rollRows()).toMatchObject([{ bet: 10, call: 'high', die1: 1, die2: 1, won: 0 }]);
    });

    it('?roll 10 20 replies with the usage', async () => {
      const message = await run('?roll 10 20');

      expect(firstReply(message)).toBe(diceUsage);
      expect(rollRows()).toHaveLength(0);
    });

    it('replies in plain text with the funds error', async () => {
      drain(author, 50);
      const message = await run('?dice 100 low');

      expect(firstReply(message)).toBe(diceErrorText(new InsufficientFundsError(50, 100)));
      expect(message.sent.edit).not.toHaveBeenCalled();
      expect(rollRows()).toHaveLength(0);
    });
  });
});

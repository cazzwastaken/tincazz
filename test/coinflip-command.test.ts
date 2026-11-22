import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { container } from '@sapphire/framework';
import { Events, MessageFlags } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { flips, ledger } from '../src/db/schema.js';
import {
  clearBudgets,
  clearBusy,
  setFrameDelay,
  stillRolling,
  tryBegin,
} from '../src/features/animation/index.js';
import {
  cannotChallengeBot,
  cannotChallengeSelf,
  clearChallenges,
  flipAnimation,
  restoreChallengeCards,
} from '../src/features/coinflip/index.js';
import { adminAdjust, findWallet, startingBalance } from '../src/features/economy/index.js';
import { setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';
import { makeChatInput, makeUser } from './support/interaction.js';

// See gamba-command.test.ts: patch the real crypto.randomInt for natively loaded pieces.
function mockRandomInt(...values: number[]) {
  const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(values.at(-1) as never);
  for (const value of values.slice(0, -1).reverse()) {
    spy.mockReturnValueOnce(value as never);
  }
  syncBuiltinESMExports();
}

const json = (value: unknown) => JSON.stringify(value);

describe('/coinflip', () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    clearChallenges();
    setFrameDelay(0);
    clearBusy();
    clearBudgets();
    // The runIn precondition fetches the channel over REST, which needs a token.
    vi.spyOn(client.channels, 'fetch').mockResolvedValue({
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
    } as never);
  });

  afterEach(() => {
    clearChallenges();
    clearBusy();
    setFrameDelay(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  async function run(subcommand: string, options: Record<string, unknown> = {}) {
    const interaction = makeChatInput(client, {
      commandName: 'coinflip',
      userId: '1',
      subcommand,
      options,
    });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    return interaction;
  }

  const flipCount = () => container.db.select().from(flips).all().length;
  const ledgerReasons = () =>
    container.db
      .select()
      .from(ledger)
      .all()
      .map((row) => row.reason);

  describe('bot', () => {
    it('flips against the bot and pays a win', async () => {
      mockRandomInt(0);
      const interaction = await run('bot', { bet: '100', side: 'heads' });

      // The reply is the first toss frame; the rest of the frames and the result are edits.
      expect(json(interaction.reply.mock.calls[0])).toContain('tossed');
      await vi.waitFor(() =>
        expect(interaction.editReply).toHaveBeenCalledTimes(flipAnimation.stages.length),
      );
      const result = json(interaction.editReply.mock.calls.at(-1));
      expect(result).toContain('Heads');
      expect(result).toContain('+94');
      expect(result).toContain('Flip again');
      expect(findWallet(container.db, '2', '1')?.balance).toBe(startingBalance + 94);
      expect(flipCount()).toBe(1);
    });

    it('bets 10 coins by default', async () => {
      mockRandomInt(1);
      await run('bot');

      expect(findWallet(container.db, '2', '1')?.balance).toBe(startingBalance - 10);
    });

    it('a /coinflip bot while the same user is animating gets the busy text and settles nothing', async () => {
      tryBegin('1');
      const interaction = await run('bot', { bet: '100' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain(stillRolling);
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(interaction.editReply).not.toHaveBeenCalled();
      expect(flipCount()).toBe(0);
      expect(findWallet(container.db, '2', '1')).toBeUndefined();
    });

    it('replies ephemerally to a bad bet', async () => {
      const interaction = await run('bot', { bet: 'lots' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain("isn't a bet");
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
      expect(flipCount()).toBe(0);
    });
  });

  describe('economy log', () => {
    it('keeps a 5,000 bot flip out of the log', async () => {
      const send = vi.fn(async () => ({}));
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
      mockRandomInt(0);
      await run('bot', { bet: '5000', side: 'heads' });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('challenge', () => {
    it('posts a card that pings only the opponent and moves no coins', async () => {
      const interaction = await run('challenge', { opponent: makeUser('3'), bet: '100' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [
        { allowedMentions: { users: string[] } },
      ];
      expect(options.allowedMentions.users).toEqual(['3']);
      expect(json(options).match(/cf:(accept|decline|cancel):/g)).toHaveLength(3);
      expect(ledgerReasons()).toEqual(['start']);
      expect(flipCount()).toBe(0);
    });

    it('refuses to challenge yourself or a bot', async () => {
      const self = await run('challenge', { opponent: makeUser('1') });
      expect(json(self.reply.mock.calls[0])).toContain(cannotChallengeSelf);
      const bot = await run('challenge', { opponent: makeUser('9', true) });
      expect(json(bot.reply.mock.calls[0])).toContain(cannotChallengeBot);
    });

    it('refuses a bet above the balance', async () => {
      const interaction = await run('challenge', { opponent: makeUser('3'), bet: '5000' });

      expect(json(interaction.reply.mock.calls[0])).toContain('You have 1,000 coins');
      expect(json(interaction.reply.mock.calls[0])).not.toContain('Coinflip challenge');
    });
  });

  describe('open', () => {
    it('posts an open card that pings nobody and expires', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const interaction = await run('open', { bet: '100' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [
        { allowedMentions?: unknown },
      ];
      expect(options.allowedMentions).toBeUndefined();
      expect(json(options).match(/cf:(accept|decline|cancel):/g)).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      expect(json(interaction.editReply.mock.calls[0])).toContain('Challenge expired.');
    });

    it('restores an already expired challenge after the database is reopened', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tincazz-coinflip-'));
      const path = join(dir, 'bot.db');
      closeDatabase(container.db);
      container.db = openDatabase(path);
      try {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const interaction = await run('open', { bet: '100' });
        clearChallenges();
        closeDatabase(container.db);
        vi.setSystemTime(Date.now() + 120_001);
        container.db = openDatabase(path);

        const edit = vi.fn(async (_messageId: string, _options: unknown) => ({}));
        vi.mocked(client.channels.fetch).mockResolvedValue({
          isSendable: () => true,
          messages: { edit },
        } as never);
        restoreChallengeCards(client);
        await vi.advanceTimersByTimeAsync(1);

        expect(interaction.editReply).not.toHaveBeenCalled();
        expect(edit).toHaveBeenCalledExactlyOnceWith('card-1', expect.anything());
        expect(json(edit.mock.calls[0]?.[1])).toContain('Challenge expired.');
        expect(json(edit.mock.calls[0]?.[1])).not.toContain('cf:accept');
        expect(flipCount()).toBe(0);
        expect(ledgerReasons()).toEqual(['start']);

        clearChallenges();
        restoreChallengeCards(client);
        await vi.advanceTimersByTimeAsync(1);
        expect(edit).toHaveBeenCalledTimes(1);
      } finally {
        clearChallenges();
        closeDatabase(container.db);
        rmSync(dir, { recursive: true });
      }
    });
  });
});

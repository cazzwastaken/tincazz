import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { container } from '@sapphire/framework';
import { Events, MessageFlags } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { spins } from '../src/db/schema.js';
import { findWallet } from '../src/features/economy/index.js';
import { clearActiveCards, isActiveCard } from '../src/features/gamba/index.js';
import { testEnv } from './support/env.js';
import { makeChatInput } from './support/interaction.js';

// Sapphire loads the command with Node's native loader, so vi.mock cannot reach it. Patch the real
// crypto.randomInt instead and re-sync the builtin ESM exports so native imports see it.
function mockRandomInt(...values: number[]) {
  const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(values.at(-1) as never);
  for (const value of values.slice(0, -1).reverse()) {
    spy.mockReturnValueOnce(value as never);
  }
  syncBuiltinESMExports();
}

const json = (value: unknown) => JSON.stringify(value);

function buildClient() {
  return createClient(testEnv);
}

function makeMessage(
  client: ReturnType<typeof buildClient>,
  content: string,
  overrides: Record<string, unknown> = {},
) {
  const reply = vi.fn(async (_options: Record<string, unknown>) => ({}));
  return {
    content,
    createdTimestamp: 1000,
    author: { bot: false, id: '1', toString: () => '<@1>' },
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
    reply: vi.fn(async (_options: Record<string, unknown>) => ({ reply })),
    spinReply: reply,
    ...overrides,
  };
}

describe('gamba', () => {
  // Sapphire keeps global state, so a second client in the same process loses its built-in
  // preconditions. Share one client across the tests in this file.
  let client: ReturnType<typeof buildClient>;

  beforeAll(async () => {
    client = buildClient();
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  async function run(content: string, overrides: Record<string, unknown> = {}) {
    const message = makeMessage(client, content, overrides);
    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    return message;
  }

  describe('?gamba', () => {
    it('treats a bare ?gamba as a 1-coin bet with no follow-up on a loss', async () => {
      mockRandomInt(0, 3, 6);
      const message = await run('?gamba');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const [options] = message.reply.mock.calls[0] as unknown as [
        { content: string; flags?: number },
      ];
      expect(options.flags).toBeUndefined();
      expect(options.content).toMatch(/^(<:\w+:\d+> ){2}<:\w+:\d+>\nbet 1 → 0 · balance 999$/);
      expect(options).toMatchObject({ allowedMentions: { repliedUser: true } });
      expect(message.spinReply).not.toHaveBeenCalled();
    });

    it('sends a follow-up after the roll on a triple and pings only the winner', async () => {
      mockRandomInt(0);
      const message = await run('?gamba 10');
      await vi.waitFor(() => expect(message.spinReply).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });

      expect(message.spinReply.mock.calls[0]?.[0]).toMatchObject({
        content: expect.stringContaining('<@1> won! +100 coins'),
        allowedMentions: { users: ['1'] },
      });
      expect(message.reply.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(message.spinReply).mock.invocationCallOrder[0] as number,
      );
    });

    it('settles a lost wager', async () => {
      mockRandomInt(0, 3, 6);
      const message = await run('?gamba 100');

      expect(json(message.reply.mock.calls[0])).toContain('bet 100 → 0 · balance 900');
      expect(findWallet(container.db, '2', '1')?.balance).toBe(900);
    });

    it('bets at most 10,000 on all', async () => {
      mockRandomInt(0, 3, 6, 0, 3, 6);
      await run('?gamba');
      container.db.$client.prepare('update wallets set balance = 50000').run();
      const message = await run('?gamba all');

      expect(json(message.reply.mock.calls[0])).toContain('bet 10,000 → 0');
    });

    it('replies with plain text for a bad bet', async () => {
      const message = await run('?gamba lol');

      expect(message.reply.mock.calls[0]?.[0]).toEqual(expect.stringContaining("isn't a bet"));
      expect(container.db.select().from(spins).all()).toEqual([]);
    });

    it('explains an unaffordable bet', async () => {
      const message = await run('?gamba 5000');

      expect(json(message.reply.mock.calls[0])).toContain(
        'You have 1,000 coins. Try a smaller bet.',
      );
    });

    it('points to /bailout when the balance is under the bailout threshold', async () => {
      mockRandomInt(0, 3, 6);
      await run('?gamba');
      container.db.$client.prepare('update wallets set balance = 5').run();
      const message = await run('?gamba 10');

      expect(json(message.reply.mock.calls[0])).toContain(
        'You have 5 coins. `/bailout` is available.',
      );
    });

    it('does not run in DMs, and the denial is answered', async () => {
      mockRandomInt(0);
      const message = makeMessage(client, '?gamba', {
        guild: null,
        guildId: null,
        channel: { id: '3', type: 1, isDMBased: () => true, isThread: () => false },
      });

      client.emit(Events.MessageCreate, message as never);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(message.reply).toHaveBeenCalledTimes(1);
      expect(message.reply).toHaveBeenCalledWith(expect.stringMatching(/\S/));
      expect(message.member?.roles.add).not.toHaveBeenCalled();
    });

    it('jackpot assigns the role', async () => {
      mockRandomInt(20);
      const message = await run('?gamba');
      await vi.waitFor(() => expect(message.spinReply).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });

      expect(message.member?.roles.add).toHaveBeenCalledWith(
        '1561827731400822845',
        'gamba jackpot',
      );
      expect(json(message.spinReply.mock.calls[0])).toContain('You are a pro!');
    });

    it('jackpot announces a failed role assignment', async () => {
      mockRandomInt(20);
      const message = await run('?gamba', {
        member: {
          roles: { add: vi.fn(async () => Promise.reject(new Error('Missing Permissions'))) },
        },
      });
      await vi.waitFor(() => expect(message.spinReply).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });

      expect(json(message.spinReply.mock.calls[0])).toContain("couldn't assign the role");
      expect(findWallet(container.db, '2', '1')?.balance).toBeGreaterThan(1_000);
    });

    it('jackpot with no cached member', async () => {
      mockRandomInt(20);
      const message = await run('?gamba', { member: null });
      await vi.waitFor(() => expect(message.spinReply).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });

      expect(json(message.spinReply.mock.calls[0])).toContain("couldn't assign the role");
    });

    it('keeps the roll when the follow-up fails', async () => {
      mockRandomInt(0);
      const error = vi.spyOn(container.logger, 'error').mockImplementation(() => undefined);
      const spinReply = vi.fn(async () => Promise.reject(new Error('Unknown Message')));
      const message = makeMessage(client, '?gamba 10');
      message.reply = vi.fn(async () => ({ reply: spinReply })) as never;

      client.emit(Events.MessageCreate, message as never);
      await vi.waitFor(() => expect(spinReply).toHaveBeenCalledTimes(1), { timeout: 2000 });
      await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 2000 });

      expect(message.reply).toHaveBeenCalledTimes(1);
      expect(findWallet(container.db, '2', '1')?.balance).toBe(1_090);
    });
  });

  describe('/gamba', () => {
    async function runSlash(options: Record<string, unknown> = {}) {
      // The runIn precondition fetches the channel over REST, which needs a token.
      vi.spyOn(client.channels, 'fetch').mockResolvedValue({
        type: 0,
        isDMBased: () => false,
        isThread: () => false,
      } as never);
      const interaction = makeChatInput(client, { commandName: 'gamba', userId: '1', options });
      client.emit(Events.InteractionCreate, interaction as never);
      await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });
      return interaction;
    }

    it('bets all of the balance and asks for the response', async () => {
      mockRandomInt(0, 3, 6);
      const interaction = await runSlash({ bet: 'all' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ withResponse: boolean }];
      expect(options.withResponse).toBe(true);
      expect(json(options)).toContain('Bet 1,000 → 0 (-1,000)');
      expect(findWallet(container.db, '2', '1')?.balance).toBe(0);
    });

    it('makes the newest card the only live one', async () => {
      clearActiveCards();
      mockRandomInt(0, 3, 6);
      await runSlash({ bet: '10' });

      expect(isActiveCard('1', 'card-1')).toBe(true);
      expect(isActiveCard('1', 'older-card')).toBe(false);
    });

    it('replies ephemerally to a bad bet', async () => {
      const interaction = await runSlash({ bet: 'lol' });

      const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
      expect(json(options)).toContain("isn't a bet");
      expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
    });

    it('announces a default-bet triple with a winner-only ping', async () => {
      mockRandomInt(0);
      const interaction = await runSlash();
      await vi.waitFor(() => expect(interaction.announce).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });

      expect(interaction.announce.mock.calls[0]).toMatchObject([
        { allowedMentions: { users: ['1'] } },
      ]);
    });
  });
});

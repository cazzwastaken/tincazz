import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { container } from '@sapphire/framework';
import { Events } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { flips, ledger } from '../src/db/schema.js';
import { clearBudgets, setFrameDelay } from '../src/features/animation/index.js';
import {
  cannotChallengeBot,
  cannotChallengeSelf,
  clearChallenges,
  flipAnimation,
  flipUsage,
  memberNotFound,
} from '../src/features/coinflip/index.js';
import { findWallet, startingBalance } from '../src/features/economy/index.js';
import { testEnv } from './support/env.js';

// See gamba-command.test.ts: patch the real crypto.randomInt for natively loaded pieces.
function mockRandomInt(...values: number[]) {
  const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(values.at(-1) as never);
  for (const value of values.slice(0, -1).reverse()) {
    spy.mockReturnValueOnce(value as never);
  }
  syncBuiltinESMExports();
}

const json = (value: unknown) => JSON.stringify(value);

// Snowflake-length IDs, so the parser reads mentions of them.
const author = '100000000000000001';
const bob = '100000000000000002';
const botUser = '100000000000000003';
const stranger = '100000000000000004';

const members: Record<string, { id: string; user: { id: string; bot: boolean } }> = {
  [author]: { id: author, user: { id: author, bot: false } },
  [bob]: { id: bob, user: { id: bob, bot: false } },
  [botUser]: { id: botUser, user: { id: botUser, bot: true } },
};

type ReplyOptions =
  | string
  | { allowedMentions?: { users?: string[] }; components?: unknown; failIfNotExists?: boolean };

function makeMessage(client: ReturnType<typeof createClient>, content: string) {
  const sent = { id: 'sent-1', edit: vi.fn(async (_options: unknown) => ({})) };
  const fetch = vi.fn(async (id: string) => {
    const member = members[id];
    if (!member) throw new Error('Unknown Member');
    return member;
  });
  return {
    content,
    createdTimestamp: 1000,
    author: { bot: false, id: author, toString: () => `<@${author}>` },
    webhookId: null,
    system: false,
    guild: {
      id: '2',
      members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }), fetch },
    },
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
    fetch,
  };
}

describe('?coinflip', () => {
  // Sapphire keeps global state, so a second client in the same process loses its built-in
  // preconditions. Share one client across the tests in this file.
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    clearChallenges();
    setFrameDelay(0);
    clearBudgets();
  });

  afterEach(() => {
    clearChallenges();
    setFrameDelay(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  });

  async function run(content: string) {
    const message = makeMessage(client, content);
    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    return message;
  }

  const firstReply = (message: ReturnType<typeof makeMessage>) =>
    message.reply.mock.calls[0]?.[0] as ReplyOptions;
  const flipRows = () => container.db.select().from(flips).all();
  const ledgerReasons = () =>
    container.db
      .select()
      .from(ledger)
      .all()
      .map((row) => row.reason);

  /** A reply that pings nobody: plain text, or a card without mention opt-ins. */
  function expectNoPings(options: ReplyOptions) {
    if (typeof options === 'string') return;
    expect(options.allowedMentions?.users ?? []).toEqual([]);
  }

  describe('against the bot', () => {
    it('?cf 100 tails settles a bot flip and edits the sent card to the result', async () => {
      mockRandomInt(1);
      const message = await run('?cf 100 tails');

      expect(json(firstReply(message))).toContain('tossed');
      await vi.waitFor(() =>
        expect(message.sent.edit).toHaveBeenCalledTimes(flipAnimation.stages.length),
      );
      const result = json(message.sent.edit.mock.calls.at(-1));
      expect(result).toContain('Tails');
      expect(result).toContain('+94');
      expect(result).toContain('Flip again');
      expect(findWallet(container.db, '2', author)?.balance).toBe(startingBalance + 94);
      expect(flipRows()).toMatchObject([{ mode: 'bot', bet: 100, challengerSide: 'tails' }]);
      expectNoPings(firstReply(message));
    });

    it('replies without failing when the command message was deleted', async () => {
      mockRandomInt(1);
      const message = await run('?cf 100 tails');

      const options = firstReply(message);
      expect(typeof options === 'string' ? undefined : options.failIfNotExists).toBe(false);
    });

    it('?flip with no args flips 10 on heads', async () => {
      mockRandomInt(0);
      const message = await run('?flip');

      await vi.waitFor(() =>
        expect(message.sent.edit).toHaveBeenCalledTimes(flipAnimation.stages.length),
      );
      expect(flipRows()).toMatchObject([{ mode: 'bot', bet: 10, challengerSide: 'heads' }]);
    });

    it('replies in plain text to a bad bet', async () => {
      const message = await run('?cf lots');

      expect(firstReply(message)).toEqual(expect.stringContaining("isn't a bet"));
      expect(flipRows()).toHaveLength(0);
    });
  });

  describe('challenges', () => {
    it('?coinflip @bob 50 posts a challenge that pings only bob and expires', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const message = await run(`?coinflip <@${bob}> 50`);

      const options = firstReply(message);
      expect(typeof options).toBe('object');
      expect((options as Exclude<ReplyOptions, string>).allowedMentions).toEqual({
        users: [bob],
      });
      expect(json(options)).toContain('Coinflip challenge');
      expect(json(options).match(/cf:(accept|decline|cancel):/g)).toHaveLength(3);
      expect(message.fetch).toHaveBeenCalledWith(bob);
      expect(ledgerReasons()).toEqual(['start']);
      expect(flipRows()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(message.sent.edit).toHaveBeenCalledTimes(1);
      expect(json(message.sent.edit.mock.calls[0])).toContain('Challenge expired.');
    });

    it('?cf open 50 posts an open challenge that pings nobody', async () => {
      const message = await run('?cf open 50');

      const options = firstReply(message);
      expect(json(options)).toContain('Coinflip challenge');
      expect(json(options).match(/cf:(accept|decline|cancel):/g)).toHaveLength(2);
      expectNoPings(options);
      expect(message.fetch).not.toHaveBeenCalled();
    });

    it('?cf @self is refused', async () => {
      const message = await run(`?cf <@${author}>`);

      expect(firstReply(message)).toBe(cannotChallengeSelf);
    });

    it('?cf @botUser is refused', async () => {
      const message = await run(`?cf <@${botUser}> 50`);

      expect(firstReply(message)).toBe(cannotChallengeBot);
    });

    it('a mention of someone not in the guild is not found and pings nobody', async () => {
      const message = await run(`?cf <@${stranger}> 50`);

      expect(firstReply(message)).toBe(memberNotFound);
      expect(message.fetch).toHaveBeenCalledWith(stranger);
      expect(flipRows()).toHaveLength(0);
    });

    it.each([
      ['@everyone', '?cf @everyone'],
      ['@here', '?cf @here 50'],
      ['a role mention', `?cf <@&${bob}> 50`],
    ])('%s is never a challenge and pings nobody', async (_name, content) => {
      const message = await run(content);

      expect(firstReply(message)).toBe(flipUsage);
      expect(message.fetch).not.toHaveBeenCalled();
      expect(flipRows()).toHaveLength(0);
    });
  });

  it('?cf 10 20 replies with the usage', async () => {
    const message = await run('?cf 10 20');

    expect(firstReply(message)).toBe(flipUsage);
    expect(flipRows()).toHaveLength(0);
  });
});

import { container } from '@sapphire/framework';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { pots, spins } from '../src/db/schema.js';
import {
  adminAdjust,
  debit,
  findWallet,
  getOrCreateWallet,
  InsufficientFundsError,
  startingBalance,
} from '../src/features/economy/index.js';
import { InvalidBetError } from '../src/features/gamba/index.js';
import { settleSpin, spin } from '../src/features/gamba/spin.js';
import { setJackpotRole, setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';

function draws(...values: number[]) {
  const queue = [...values];
  return () => queue.shift() ?? 0;
}

const json = (value: unknown) => JSON.stringify(value);

// Sapphire keeps global state; one client for the file also gives the log sender its logger.
beforeAll(() => {
  createClient(testEnv);
});

describe('spin', () => {
  let db: Db;
  const request = { guildId: '2', userId: '1' };

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('plays a 1-coin wager when no bet is given', async () => {
    const { played } = await settleSpin(db, request, 1000, {
      assignJackpotRole: async () => true,
      randomInt: draws(0, 3, 6),
    });

    expect(played.bet).toBe(1);
    expect(findWallet(db, '2', '1')?.balance).toBe(startingBalance - 1);
  });

  it('rejects a no-bet spin with no coins with a funds error', async () => {
    getOrCreateWallet(db, '2', '1', 1000);
    debit(db, { guildId: '2', userId: '1', amount: startingBalance, reason: 'bet', now: 1000 });

    await expect(
      settleSpin(db, request, 1000, { assignJackpotRole: async () => true }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('settles a wager and does not announce a pair', async () => {
    const result = await spin(db, { ...request, bet: '100' }, 1000, {
      assignJackpotRole: async () => true,
      randomInt: draws(0, 0, 3),
    });

    expect(json(result.card)).toContain('Bet 100 → 200');
    expect(result.announcement).toBeUndefined();
  });

  it('assigns the guild role once on a wagered jackpot', async () => {
    setJackpotRole(db, '2', '77', 1);
    const assignJackpotRole = vi.fn(async (_roleId: string) => true);
    const result = await spin(db, { ...request, bet: '500' }, 1000, {
      assignJackpotRole,
      randomInt: draws(20, 20, 20),
    });

    expect(assignJackpotRole).toHaveBeenCalledExactlyOnceWith('77');
    expect(json(result.announcement)).toContain('You are a pro! You just won <@&77>');
  });

  it('skips the role without calling the assigner when the guild has none', async () => {
    const assignJackpotRole = vi.fn(async (_roleId: string) => true);
    const result = await spin(db, { ...request, bet: '500' }, 1000, {
      assignJackpotRole,
      randomInt: draws(20, 20, 20),
    });

    expect(assignJackpotRole).not.toHaveBeenCalled();
    expect(json(result.card)).toContain('Bet 500');
    expect(json(result.announcement)).toContain('Won 50,000 on a 500 bet');
    expect(json(result.announcement)).not.toContain('You are a pro');
  });

  it('notes a failed role assignment in the announcement', async () => {
    setJackpotRole(db, '2', '77', 1);
    const result = await spin(db, { ...request, bet: '500' }, 1000, {
      assignJackpotRole: async () => false,
      randomInt: draws(20, 20, 20),
    });

    expect(json(result.announcement)).toContain("couldn't assign the role");
  });

  it('rejects an invalid bet and changes nothing', async () => {
    await expect(
      spin(db, { ...request, bet: 'lol' }, 1000, { assignJackpotRole: async () => true }),
    ).rejects.toBeInstanceOf(InvalidBetError);
    expect(db.select().from(spins).all()).toEqual([]);
    expect(db.select().from(pots).all()).toEqual([]);
  });

  it('rejects a bet above the balance and changes nothing', async () => {
    await expect(
      spin(db, { ...request, bet: '5000' }, 1000, { assignJackpotRole: async () => true }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(db.select().from(spins).all()).toEqual([]);
  });
});

describe('settleSpin', () => {
  it('returns the settled spin and the role result on a jackpot', async () => {
    const db = openDatabase(':memory:');
    setJackpotRole(db, 'g', '77', 1);
    const settled = await settleSpin(db, { guildId: 'g', userId: 'u' }, 1000, {
      assignJackpotRole: async () => false,
      randomInt: () => 20,
    });
    expect(settled.played.evaluation.result).toBe('jackpot');
    expect(settled.roleAssigned).toBe(false);
  });
});

describe('spin economy log', () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    send = vi.fn(async () => ({}));
    container.client.channels.cache.set('50', {
      id: '50',
      isSendable: () => true,
      send,
    } as never);
    setLogChannel(container.db, '2', 'economy', '50', 1);
  });

  it('logs a jackpot once', async () => {
    await spin(container.db, { guildId: '2', userId: '1', bet: '500' }, 1000, {
      assignJackpotRole: async () => true,
      randomInt: draws(20, 20, 20),
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it('keeps a max-bet spin with a big payout out of the log', async () => {
    adminAdjust(container.db, {
      guildId: '2',
      userId: '1',
      actorId: '9',
      action: 'give',
      amount: 10_000,
      reason: 'setup',
      now: 1,
    });
    await spin(container.db, { guildId: '2', userId: '1', bet: '10000' }, 1000, {
      assignJackpotRole: async () => true,
      randomInt: draws(18, 18, 18),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not log a default spin', async () => {
    await spin(container.db, { guildId: '2', userId: '1' }, 1000, {
      assignJackpotRole: async () => true,
      randomInt: draws(0, 3, 6),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(send).not.toHaveBeenCalled();
  });
});

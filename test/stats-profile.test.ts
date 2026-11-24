import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { settleBotFlip } from '../src/features/coinflip/index.js';
import { settleRoll } from '../src/features/dice/index.js';
import {
  claimDaily,
  coinsRank,
  findWallet,
  getOrCreateWallet,
} from '../src/features/economy/index.js';
import { playWager } from '../src/features/gamba/play.js';
import { playerProfile } from '../src/features/stats/index.js';

let db: Db;

const dayMs = 86_400_000;

// Draws of 0 are head (see gamba.test.ts); 0, 3, 6 is a loss.
const roll = (...draws: number[]) => {
  const queue = [...draws];
  return () => queue.shift() ?? 0;
};

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('playerProfile', () => {
  it('is undefined without a wallet', () => {
    expect(playerProfile(db, '2', '1', 0)).toBeUndefined();
  });

  it('is all zeros for a wallet that never spun', () => {
    getOrCreateWallet(db, '2', '1', 0);
    expect(playerProfile(db, '2', '1', 0)).toEqual({
      balance: 1000,
      rank: 1,
      dailyStreak: 0,
      spins: 0,
      wins: 0,
      jackpots: 0,
      wagered: 0,
      won: 0,
      biggestWin: 0,
      bestOdds: 0,
      flips: 0,
      flipWins: 0,
      flipWagered: 0,
      flipWon: 0,
      rolls: 0,
      rollWins: 0,
      rollWagered: 0,
      rollWon: 0,
    });
  });

  it('reflects wagered spins', () => {
    playWager(db, '2', '1', 10, 10, roll(0, 0, 0));
    playWager(db, '2', '1', 100, 20, roll(0, 3, 6));
    expect(playerProfile(db, '2', '1', 30)).toMatchObject({
      spins: 2,
      wins: 1,
      biggestWin: 100,
      bestOdds: 343,
      wagered: 110,
      won: 100,
      balance: findWallet(db, '2', '1')?.balance,
      rank: coinsRank(db, '2', '1'),
    });
  });

  it('reflects coinflips', () => {
    settleBotFlip(db, { guildId: '2', userId: '1', bet: '100', side: 'heads' }, 5, () => 0);
    expect(playerProfile(db, '2', '1', 10)).toMatchObject({
      flips: 1,
      flipWins: 1,
      flipWagered: 100,
      flipWon: 194,
    });
  });

  it('reflects dice rolls', () => {
    settleRoll(db, { guildId: '2', userId: '1', bet: '100', call: { kind: 'high' } }, 5, () => 5);
    expect(playerProfile(db, '2', '1', 10)).toMatchObject({
      rolls: 1,
      rollWins: 1,
      rollWagered: 100,
      rollWon: 238,
    });
  });

  it('keeps the daily streak through the next day and drops it after', () => {
    const day = 100 * dayMs;
    claimDaily(db, '2', '1', day);
    expect(playerProfile(db, '2', '1', day)?.dailyStreak).toBe(1);
    expect(playerProfile(db, '2', '1', day + dayMs)?.dailyStreak).toBe(1);
    expect(playerProfile(db, '2', '1', day + 2 * dayMs)?.dailyStreak).toBe(0);
  });
});

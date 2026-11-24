import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { playerStats, wallets } from '../src/db/schema.js';
import { coinsRank } from '../src/features/economy/index.js';
import {
  isLeaderboardCategory,
  leaderboardPage,
  leaderboardRank,
} from '../src/features/stats/index.js';

let db: Db;

const addWallet = (userId: string, balance: number, guildId = '2') =>
  db.insert(wallets).values({ guildId, userId, balance, createdAt: 0 }).run();

const addStats = (
  userId: string,
  stats: Partial<typeof playerStats.$inferInsert>,
  guildId = '2',
) => {
  // Boards only list members that have a wallet.
  db.insert(wallets)
    .values({ guildId, userId, balance: 0, createdAt: 0 })
    .onConflictDoNothing()
    .run();
  db.insert(playerStats)
    .values({ guildId, userId, ...stats })
    .run();
};

beforeEach(() => {
  db = openDatabase(':memory:');
});

describe('leaderboardPage', () => {
  it('lists coins above zero, highest first, in one guild', () => {
    addWallet('1', 500);
    addWallet('2', 900);
    addWallet('3', 0);
    addWallet('4', 5_000, 'other');
    expect(leaderboardPage(db, '2', 'coins', 0)).toEqual({
      rows: [
        { userId: '2', value: 900, rank: 1 },
        { userId: '1', value: 500, rank: 2 },
      ],
      page: 0,
      pageCount: 1,
    });
    expect(leaderboardRank(db, '2', 'coins', '3')).toBeUndefined();
  });

  it('ranks dice as won minus wagered and hides zero or negative', () => {
    addStats('1', { rollWon: 237, rollWagered: 100 });
    addStats('2', { rollWon: 0, rollWagered: 100 });
    addStats('3', { rollWon: 0, rollWagered: 0 });
    expect(leaderboardPage(db, '2', 'dice', 0).rows).toEqual([
      { userId: '1', value: 137, rank: 1 },
    ]);
    expect(leaderboardRank(db, '2', 'dice', '1')).toEqual({ rank: 1, value: 137 });
    expect(leaderboardRank(db, '2', 'dice', '2')).toBeUndefined();
  });

  it('breaks ties by numeric user id, not text order', () => {
    addWallet('10', 700);
    addWallet('9', 700);
    expect(leaderboardPage(db, '2', 'coins', 0).rows).toEqual([
      { userId: '9', value: 700, rank: 1 },
      { userId: '10', value: 700, rank: 2 },
    ]);
    expect(leaderboardRank(db, '2', 'coins', '9')?.rank).toBe(1);
    expect(leaderboardRank(db, '2', 'coins', '10')?.rank).toBe(2);
    expect(leaderboardRank(db, '2', 'coins', '10')?.rank).toBe(coinsRank(db, '2', '10'));
  });

  it('ranks profit as won minus wagered and hides zero or negative', () => {
    addStats('1', { won: 300, wagered: 100 });
    addStats('2', { won: 50, wagered: 400 });
    addStats('3', { won: 0, wagered: 0 });
    expect(leaderboardPage(db, '2', 'profit', 0).rows).toEqual([
      { userId: '1', value: 200, rank: 1 },
    ]);
    expect(leaderboardRank(db, '2', 'profit', '1')).toEqual({ rank: 1, value: 200 });
    expect(leaderboardRank(db, '2', 'profit', '2')).toBeUndefined();
  });

  it('ranks coinflip as won minus wagered and hides zero or negative', () => {
    addStats('1', { botFlipWon: 194, botFlipWagered: 100 });
    addStats('2', { botFlipWon: 0, botFlipWagered: 100 });
    addStats('3', { botFlipWon: 0, botFlipWagered: 0 });
    expect(leaderboardPage(db, '2', 'coinflip', 0).rows).toEqual([
      { userId: '1', value: 94, rank: 1 },
    ]);
    expect(leaderboardRank(db, '2', 'coinflip', '1')).toEqual({ rank: 1, value: 94 });
    expect(leaderboardRank(db, '2', 'coinflip', '2')).toBeUndefined();
  });

  it.each([
    ['biggest-win', { biggestWin: 40 }],
    ['jackpots', { jackpots: 3 }],
    ['spins', { spins: 12 }],
  ] as const)('reads the %s column', (category, stats) => {
    addStats('1', stats);
    expect(leaderboardPage(db, '2', category, 0).rows).toEqual([
      { userId: '1', value: Object.values(stats)[0], rank: 1 },
    ]);
  });

  it('pages by ten and clamps the page', () => {
    for (let i = 1; i <= 25; i++) {
      addStats(String(100 + i), { spins: 26 - i });
    }
    const second = leaderboardPage(db, '2', 'spins', 1);
    expect(second.rows).toHaveLength(10);
    expect(second.rows[0]).toMatchObject({ value: 15, rank: 11 });
    expect(second.pageCount).toBe(3);
    expect(leaderboardPage(db, '2', 'spins', 2).rows).toHaveLength(5);
    expect(leaderboardPage(db, '2', 'spins', 7).page).toBe(2);
    expect(leaderboardPage(db, '2', 'jackpots', 0)).toEqual({ rows: [], page: 0, pageCount: 1 });
  });
});

describe('isLeaderboardCategory', () => {
  it('accepts categories only', () => {
    expect(isLeaderboardCategory('profit')).toBe(true);
    expect(isLeaderboardCategory('coinflip')).toBe(true);
    expect(isLeaderboardCategory('dice')).toBe(true);
    expect(isLeaderboardCategory('gold')).toBe(false);
  });
});

describe('departed members', () => {
  const categories = [
    'coins',
    'biggest-win',
    'jackpots',
    'profit',
    'coinflip',
    'dice',
    'spins',
  ] as const;

  it.each(categories)('hides a departed top user in %s', (category) => {
    for (const [userId, top] of [
      ['1', 100],
      ['3', 50],
      ['4', 20],
    ] as const) {
      addWallet(userId, top);
      addStats(userId, {
        biggestWin: top,
        jackpots: top,
        won: top,
        wagered: 0,
        botFlipWon: top,
        botFlipWagered: 0,
        rollWon: top,
        rollWagered: 0,
        spins: top,
      });
    }
    db.update(wallets).set({ departedAt: 5 }).where(eq(wallets.userId, '1')).run();
    expect(leaderboardPage(db, '2', category, 0).rows.map((r) => [r.userId, r.rank])).toEqual([
      ['3', 1],
      ['4', 2],
    ]);
    expect(leaderboardRank(db, '2', category, '1')).toBeUndefined();
    expect(leaderboardRank(db, '2', category, '4')?.rank).toBe(2);
  });

  it('ranks coins without departed wallets', () => {
    addWallet('1', 100);
    addWallet('3', 50);
    db.update(wallets).set({ departedAt: 5 }).where(eq(wallets.userId, '1')).run();
    expect(coinsRank(db, '2', '1')).toBeUndefined();
    expect(coinsRank(db, '2', '3')).toBe(1);
  });
});

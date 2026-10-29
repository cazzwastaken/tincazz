import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { ledger, playerStats, pots, spins } from '../src/db/schema.js';
import { InsufficientFundsError } from '../src/features/economy/errors.js';
import { getOrCreateWallet } from '../src/features/economy/wallets.js';
import { playWager } from '../src/features/gamba/play.js';
import { expectLedgerConsistent } from './support/ledger.js';

let db: Db;

// Draws of 0 are head, 20 is cpp, 18 is python (see gamba.test.ts).
const roll = (...draws: number[]) => {
  const queue = [...draws];
  return () => queue.shift() ?? 0;
};

beforeEach(() => {
  db = openDatabase(':memory:');
});

const reasons = () =>
  db
    .select()
    .from(ledger)
    .all()
    .map((row) => row.reason);

describe('playWager', () => {
  it('takes the bet, feeds the pot and records a loss', () => {
    const result = playWager(db, 'g', 'u', 200, 10, roll(0, 3, 6));
    expect(result).toMatchObject({
      mode: 'wager',
      bet: 200,
      payout: 0,
      potWon: 0,
      balance: 800,
      pot: 10_006,
    });
    expect(reasons()).toEqual(['start', 'bet']);
    expect(db.select().from(ledger).all().at(-1)?.ref).toBe(result.spinId);
    expect(db.select().from(spins).get()).toMatchObject({
      mode: 'wager',
      bet: 200,
      payout: 0,
      potWon: 0,
      result: 'none',
    });
    expect(db.select().from(playerStats).get()).toMatchObject({
      spins: 1,
      wins: 0,
      wagered: 200,
      won: 0,
    });
    expectLedgerConsistent(db);
  });

  it('pays a yt pair and links both ledger rows to the spin', () => {
    const result = playWager(db, 'g', 'u', 100, 10, roll(0, 0, 3));
    expect(result).toMatchObject({ payout: 200, balance: 1_100 });
    expect(reasons()).toEqual(['start', 'bet', 'payout']);
    const rows = db.select().from(ledger).all();
    expect(rows[1]?.ref).toBe(result.spinId);
    expect(rows[2]?.ref).toBe(result.spinId);
    expectLedgerConsistent(db);
  });

  it('pays the payout and the pot on a jackpot', () => {
    const result = playWager(db, 'g', 'u', 500, 10, roll(20, 20, 20));
    expect(result).toMatchObject({
      payout: 50_000,
      potWon: 10_015,
      pot: 10_000,
      balance: 60_515,
    });
    expect(reasons()).toEqual(['start', 'bet', 'payout', 'pot_win']);
    expect(db.select().from(playerStats).get()).toMatchObject({
      jackpots: 1,
      wins: 1,
      wagered: 500,
      won: 60_015,
      biggestWin: 60_015,
      bestOdds: 9_261,
    });
    expectLedgerConsistent(db);
  });

  it('pays a python pair nothing from the pot', () => {
    db.insert(pots).values({ guildId: 'g', amount: 100_000 }).run();
    const result = playWager(db, 'g', 'u', 500, 10, roll(18, 18, 0));
    expect(result).toMatchObject({ payout: 2_000, potWon: 0, pot: 100_015, balance: 2_500 });
    expect(reasons()).toEqual(['start', 'bet', 'payout']);
    expect(db.select().from(pots).get()).toMatchObject({ lastWinnerId: null });
    expect(db.select().from(playerStats).get()).toMatchObject({ jackpots: 0, won: 2_000 });
    expectLedgerConsistent(db);
  });

  it('rolls everything back when the wallet cannot cover the bet', () => {
    getOrCreateWallet(db, 'g', 'u', 1);
    expect(() => playWager(db, 'g', 'u', 2_000, 10, roll(0, 3, 6))).toThrow(InsufficientFundsError);
    expect(db.select().from(spins).all()).toEqual([]);
    expect(db.select().from(pots).all()).toEqual([]);
    expect(db.select().from(playerStats).all()).toEqual([]);
    expect(reasons()).toEqual(['start']);
  });

  it('stays ledger consistent over 200 seeded spins', () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const draw = () => next() % 21;
    let balance = 1_000;
    for (let i = 0; i < 200; i++) {
      const bet = 10 + (next() % 191);
      if (balance < bet) continue;
      balance = playWager(db, 'g', 'u', bet, i, draw).balance;
    }
    expectLedgerConsistent(db);
  });
});

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { ledger, playerStats, pots, rolls } from '../src/db/schema.js';
import { settleRoll } from '../src/features/dice/index.js';
import {
  debit,
  getOrCreateWallet,
  InsufficientFundsError,
  startingBalance,
} from '../src/features/economy/index.js';
import { InvalidBetError } from '../src/features/gamba/bet.js';
import { pot } from '../src/features/gamba/config.js';
import { expectLedgerConsistent } from './support/ledger.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

/** A `randomInt` that returns the given draws in order (draw d rolls a d + 1). */
const draws = (...values: number[]) => {
  let i = 0;
  return () => values[i++] ?? 0;
};

const ledgerFor = (userId: string) =>
  db
    .select()
    .from(ledger)
    .where(eq(ledger.userId, userId))
    .all()
    .map(({ reason, delta, ref }) => ({ reason, delta, ref }));
const statsFor = (userId: string) =>
  db.select().from(playerStats).where(eq(playerStats.userId, userId)).get();
const diceLedgerRows = () =>
  db
    .select()
    .from(ledger)
    .all()
    .filter((row) => row.reason === 'dice_bet' || row.reason === 'dice_win');

describe('settleRoll', () => {
  it('a winning high roll debits the bet, credits the payout, adds the edge to the pot and writes one roll row', () => {
    const roll = settleRoll(
      db,
      { guildId: 'g', userId: 'u', bet: '100', call: { kind: 'high' } },
      5,
      // Dice 6 and 3, then the payout draw (9,999 rounds 237.6 down), then the edge draw.
      draws(5, 2, 9_999),
    );
    expect(roll).toMatchObject({
      bet: 100,
      call: { kind: 'high' },
      die1: 6,
      die2: 3,
      total: 9,
      won: true,
      payout: 237,
      edge: 1,
      balance: startingBalance - 100 + 237,
      pot: pot.seed + 1,
    });
    expect(ledgerFor('u')).toEqual([
      { reason: 'start', delta: startingBalance, ref: null },
      { reason: 'dice_bet', delta: -100, ref: roll.rollId },
      { reason: 'dice_win', delta: 237, ref: roll.rollId },
    ]);
    expect(db.select().from(rolls).all()).toEqual([
      {
        id: roll.rollId,
        guildId: 'g',
        userId: 'u',
        bet: 100,
        call: 'high',
        target: null,
        die1: 6,
        die2: 3,
        won: 1,
        payout: 237,
        edge: 1,
        createdAt: 5,
      },
    ]);
    expectLedgerConsistent(db);
  });

  it('a losing roll credits nothing but still feeds the pot', () => {
    const roll = settleRoll(
      db,
      { guildId: 'g', userId: 'u', bet: '100', call: { kind: 'high' } },
      5,
      draws(0, 1),
    );
    expect(roll).toMatchObject({
      die1: 1,
      die2: 2,
      total: 3,
      won: false,
      payout: 0,
      edge: 1,
      balance: startingBalance - 100,
      pot: pot.seed + 1,
    });
    expect(ledgerFor('u').map((row) => row.reason)).toEqual(['start', 'dice_bet']);
    expect(db.select().from(rolls).get()).toMatchObject({ won: 0, payout: 0, edge: 1 });
    expectLedgerConsistent(db);
  });

  it('exact 12 on ⚅⚅ pays bet × 35.64', () => {
    const roll = settleRoll(
      db,
      { guildId: 'g', userId: 'u', bet: '250', call: { kind: 'exact', target: 12 } },
      5,
      // Dice 6 and 6, then the edge draw (2.5 coins: a low draw rounds up).
      draws(5, 5, 49),
    );
    expect(roll).toMatchObject({
      die1: 6,
      die2: 6,
      total: 12,
      won: true,
      payout: 8_910,
      edge: 3,
    });
    expect(db.select().from(rolls).get()).toMatchObject({ call: 'exact', target: 12 });
    expectLedgerConsistent(db);
  });

  it('stats count rolls, wins, wagered and won', () => {
    const request = { guildId: 'g', userId: 'u', bet: '100', call: { kind: 'high' } } as const;
    settleRoll(db, request, 5, draws(5, 2, 9_999));
    settleRoll(db, request, 6, draws(0, 0));
    settleRoll(db, { ...request, bet: undefined }, 7, draws(0, 0));
    expect(statsFor('u')).toMatchObject({
      rolls: 3,
      rollWins: 1,
      rollWagered: 210,
      rollWon: 237,
      spins: 0,
      flips: 0,
    });
  });

  it('an invalid bet (InvalidBetError) or short balance (InsufficientFundsError) throws and leaves no roll or dice ledger rows', () => {
    const call = { kind: 'seven' } as const;
    expect(() => settleRoll(db, { guildId: 'g', userId: 'u', bet: 'lots', call }, 5)).toThrow(
      InvalidBetError,
    );
    expect(() => settleRoll(db, { guildId: 'g', userId: 'u', bet: '5', call }, 5)).toThrow(
      InvalidBetError,
    );
    getOrCreateWallet(db, 'g', 'u', 1);
    debit(db, { guildId: 'g', userId: 'u', amount: startingBalance - 50, reason: 'bet', now: 2 });
    expect(() => settleRoll(db, { guildId: 'g', userId: 'u', bet: '100', call }, 5)).toThrow(
      InsufficientFundsError,
    );
    expect(db.select().from(rolls).all()).toEqual([]);
    expect(diceLedgerRows()).toEqual([]);
    expect(db.select().from(pots).all()).toEqual([]);
    expect(statsFor('u')).toBeUndefined();
  });
});

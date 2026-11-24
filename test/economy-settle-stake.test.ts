import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { ledger } from '../src/db/schema.js';
import {
  getOrCreateWallet,
  InsufficientFundsError,
  settleStake,
} from '../src/features/economy/index.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
  getOrCreateWallet(db, 'g', '1', 1);
});

const base = { guildId: 'g', userId: '1', now: 2, ref: 7, bet: 100, betReason: 'bet' } as const;

describe('settleStake', () => {
  it('takes the bet, then credits each payout in order with the same ref', () => {
    const balance = settleStake(db, {
      ...base,
      payouts: [
        { amount: 150, reason: 'payout' },
        { amount: 30, reason: 'pot_win' },
      ],
    });
    expect(balance).toBe(1_000 - 100 + 150 + 30);
    const rows = db.select().from(ledger).all().slice(1);
    expect(rows.map((row) => [row.reason, row.delta, row.ref])).toEqual([
      ['bet', -100, 7],
      ['payout', 150, 7],
      ['pot_win', 30, 7],
    ]);
  });

  it('skips zero payouts and leaves only the bet on a loss', () => {
    const balance = settleStake(db, { ...base, payouts: [{ amount: 0, reason: 'payout' }] });
    expect(balance).toBe(900);
    expect(db.select().from(ledger).all()).toHaveLength(2);
  });

  it('throws without writing when the bet is unaffordable', () => {
    expect(() => settleStake(db, { ...base, bet: 5_000, payouts: [] })).toThrow(
      InsufficientFundsError,
    );
    expect(db.select().from(ledger).all()).toHaveLength(1);
  });
});

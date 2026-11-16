import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { pots } from '../src/db/schema.js';
import { pot } from '../src/features/gamba/config.js';
import {
  addToPot,
  maxPotWin,
  potContribution,
  potShare,
  rareWinShare,
  settlePot,
} from '../src/features/gamba/pot.js';

function rowOf(db: ReturnType<typeof openDatabase>, guildId: string) {
  return db.select().from(pots).where(eq(pots.guildId, guildId)).get();
}

describe('potContribution', () => {
  it('takes nothing from bets of 100 or less', () => {
    for (const bet of [1, 10, 33, 100]) {
      expect(potContribution(bet)).toBe(0);
    }
  });

  it('takes 3 percent of the whole bet above 100', () => {
    expect(potContribution(101)).toBe(3);
    expect(potContribution(150)).toBe(4);
    expect(potContribution(500)).toBe(15);
    expect(potContribution(10_000)).toBe(300);
  });
});

describe('potShare', () => {
  it('pays the full pot from 500 and a proportional share below', () => {
    expect(potShare(10_000, 100)).toBe(2_000);
    expect(potShare(10_000, 500)).toBe(10_000);
    expect(potShare(10_000, 9_000)).toBe(10_000);
    expect(potShare(10_001, 10)).toBe(200);
  });
});

describe('maxPotWin', () => {
  it('limits a jackpot to 96x and a python triple to 2x its bet', () => {
    expect(maxPotWin(500, 'cppTriple')).toBe(48_000);
    expect(maxPotWin(10_000, 'cppTriple')).toBe(960_000);
    expect(maxPotWin(500, 'pythonTriple')).toBe(1_000);
  });

  it('lets no other tier take from the pot', () => {
    for (const tier of ['none', 'ytPair', 'pythonPair', 'cppPair', 'ytTriple'] as const) {
      expect(maxPotWin(10_000, tier)).toBe(0);
    }
  });
});

describe('rareWinShare', () => {
  it('takes 8% of the excess over the seed on a python triple', () => {
    expect(rareWinShare(15_000, 500, 'pythonTriple')).toBe(400);
    expect(rareWinShare(100_000, 10_000, 'pythonTriple')).toBe(7_200);
  });

  it('caps a python triple at twice its bet', () => {
    expect(rareWinShare(300_000, 500, 'pythonTriple')).toBe(1_000);
    expect(rareWinShare(300_000, 10_000, 'pythonTriple')).toBe(20_000);
    expect(rareWinShare(300_000, 10, 'pythonTriple')).toBe(20);
  });

  it('scales the share below the full-share bet', () => {
    // 8% of the 5,000 excess is 400, scaled to 100 / 500 of it.
    expect(rareWinShare(15_000, 100, 'pythonTriple')).toBe(80);
  });

  it('pays nothing for pairs, yt triples or a pot at the seed', () => {
    for (const tier of ['none', 'ytPair', 'pythonPair', 'cppPair', 'ytTriple'] as const) {
      expect(rareWinShare(300_000, 500, tier)).toBe(0);
    }
    expect(rareWinShare(pot.seed, 500, 'pythonTriple')).toBe(0);
    expect(rareWinShare(pot.seed - 1, 500, 'pythonTriple')).toBe(0);
  });

  it('never takes more than a tenth of the excess', () => {
    for (const tier of Object.keys(pot.shareBps) as (keyof typeof pot.shareBps)[]) {
      expect(pot.shareBps[tier]).toBeLessThanOrEqual(1_000);
    }
  });
});

describe('settlePot', () => {
  it('seeds and grows the pot without a jackpot', () => {
    const db = openDatabase(':memory:');
    expect(settlePot(db, 'g', 200, 'none', 'u', 1)).toEqual({ potWon: 0, pot: 10_006 });
    expect(rowOf(db, 'g')).toMatchObject({ amount: 10_006, lastWinnerId: null });
  });

  it('pays the whole pot on a full-share jackpot and resets to the seed', () => {
    const db = openDatabase(':memory:');
    expect(settlePot(db, 'g', 500, 'cppTriple', 'u', 42)).toEqual({ potWon: 10_015, pot: 10_000 });
    expect(rowOf(db, 'g')).toMatchObject({ lastWinnerId: 'u', lastWonAt: 42 });
  });

  it('tops the remainder up to the seed', () => {
    const db = openDatabase(':memory:');
    expect(settlePot(db, 'g', 100, 'cppTriple', 'u', 1)).toEqual({ potWon: 2_000, pot: 10_000 });
  });

  it('caps a jackpot at 96x its bet and keeps the rest in the pot', () => {
    const db = openDatabase(':memory:');
    settlePot(db, 'g', 100, 'none', 'u', 1);
    db.update(pots).set({ amount: 100_000 }).where(eq(pots.guildId, 'g')).run();
    // Its share would be 2,000, but a 10-coin bet takes at most 960.
    expect(settlePot(db, 'g', 10, 'cppTriple', 'u', 2)).toEqual({ potWon: 960, pot: 99_040 });
  });

  it('pays a full-share jackpot at most 96x its bet from a big pot and credits the winner', () => {
    const db = openDatabase(':memory:');
    settlePot(db, 'g', 100, 'none', 'u', 1);
    db.update(pots).set({ amount: 1_000_000 }).where(eq(pots.guildId, 'g')).run();
    expect(settlePot(db, 'g', 500, 'cppTriple', 'u', 2)).toEqual({ potWon: 48_000, pot: 952_015 });
    expect(rowOf(db, 'g')).toMatchObject({ amount: 952_015, lastWinnerId: 'u', lastWonAt: 2 });
  });

  it('pays a rare win from the excess without touching the last winner', () => {
    const db = openDatabase(':memory:');
    settlePot(db, 'g', 500, 'cppTriple', 'w', 1);
    db.update(pots).set({ amount: 300_000 }).where(eq(pots.guildId, 'g')).run();
    // 300,015 after the contribution: 8% of the 290,015 excess is 23,201, capped at twice the bet.
    expect(settlePot(db, 'g', 500, 'pythonTriple', 'u', 2)).toEqual({
      potWon: 1_000,
      pot: 299_015,
    });
    expect(rowOf(db, 'g')).toMatchObject({ amount: 299_015, lastWinnerId: 'w', lastWonAt: 1 });
  });

  it('drains a big pot only slowly toward the seed under repeated rare wins', () => {
    const db = openDatabase(':memory:');
    settlePot(db, 'g', 500, 'none', 'u', 1);
    db.update(pots).set({ amount: 300_000 }).where(eq(pots.guildId, 'g')).run();
    for (let i = 0; i < 100; i++) {
      settlePot(db, 'g', 10_000, 'pythonTriple', 'u', 2);
    }
    expect(rowOf(db, 'g')?.amount).toBeGreaterThan(pot.seed);
  });

  it('keeps guilds separate', () => {
    const db = openDatabase(':memory:');
    settlePot(db, 'a', 200, 'none', 'u', 1);
    expect(settlePot(db, 'b', 200, 'none', 'u', 1).pot).toBe(10_006);
    expect(rowOf(db, 'a')?.amount).toBe(10_006);
  });
});

describe('addToPot', () => {
  it('seeds a missing pot and adds', () => {
    const db = openDatabase(':memory:');
    expect(addToPot(db, 'g', 6)).toBe(pot.seed + 6);
    expect(addToPot(db, 'g', 1)).toBe(pot.seed + 7);
  });
});

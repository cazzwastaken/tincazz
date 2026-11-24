import { describe, expect, it } from 'vitest';
import {
  type DiceCall,
  diceEdge,
  payoutBps,
  payoutFor,
  ways,
  wins,
} from '../src/features/dice/index.js';

const calls: DiceCall[] = [
  { kind: 'high' },
  { kind: 'low' },
  { kind: 'seven' },
  { kind: 'doubles' },
  ...[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((target): DiceCall => ({ kind: 'exact', target })),
];

describe('dice evaluate', () => {
  it('covers 14 calls', () => {
    expect(calls).toHaveLength(14);
  });

  for (const call of calls) {
    const name = call.kind === 'exact' ? `exact ${call.target}` : call.kind;
    it(`returns about 99% over all 36 rolls for ${name}`, () => {
      let totalBps = 0;
      let winning = 0;
      for (let die1 = 1; die1 <= 6; die1++) {
        for (let die2 = 1; die2 <= 6; die2++) {
          if (wins(call, die1, die2)) {
            winning++;
            totalBps += payoutBps(call);
          }
        }
      }
      expect(winning).toBe(ways(call));
      const returned = totalBps / 36 / 10_000;
      expect(returned).toBeGreaterThanOrEqual(0.985);
      expect(returned).toBeLessThanOrEqual(0.995);
      // Exactly 99% before any payout is floored to whole coins.
      expect(returned).toBeCloseTo(0.99, 12);
    });
  }

  // The payout is rounded up or down at random in proportion to its fraction, so the expected
  // payout of a win is exact. Enumerate the 36 rolls and both rounding outcomes of every win.
  describe('real return with whole-coin payouts', () => {
    for (const bet of [10, 25, 99, 1000]) {
      for (const call of calls) {
        const name = call.kind === 'exact' ? `exact ${call.target}` : call.kind;
        it(`returns 98.5-99.5% at bet ${bet} on ${name}`, () => {
          const denominator = 10_000;
          const low = payoutFor(call, bet, () => denominator - 1);
          const high = payoutFor(call, bet, () => 0);
          // The draws that round up are those below the fractional part, in 10,000ths.
          const upChance = (bet * payoutBps(call) - low * denominator) / denominator;
          const expectedPayout = high === low ? low : low + upChance;
          let total = 0;
          for (let die1 = 1; die1 <= 6; die1++) {
            for (let die2 = 1; die2 <= 6; die2++) {
              if (wins(call, die1, die2)) total += expectedPayout;
            }
          }
          const returned = total / 36 / bet;
          expect(returned).toBeGreaterThanOrEqual(0.985);
          expect(returned).toBeLessThanOrEqual(0.995);
          expect(returned).toBeCloseTo(0.99, 9);
        });
      }
    }

    it('rounds every payout to a neighbouring whole coin of the exact payout', () => {
      for (const bet of [10, 25, 99, 1000]) {
        for (const call of calls) {
          const exact = (bet * payoutBps(call)) / 10_000;
          for (const draw of [0, 4_999, 9_999]) {
            const paid = payoutFor(call, bet, () => draw);
            expect(Math.abs(paid - exact)).toBeLessThan(1);
          }
        }
      }
    });
  });

  it('feeds the pot the edge on average: the same coins the player loses on average', () => {
    for (const bet of [10, 25, 99, 1000]) {
      // The edge rounds up with probability (bet % 100) / 100.
      const expectedEdge = Math.floor(bet / 100) + (bet % 100) / 100;
      expect(diceEdge(bet, () => 0)).toBe(Math.ceil(expectedEdge));
      expect(diceEdge(bet, () => 99)).toBe(Math.floor(expectedEdge));
      expect(expectedEdge).toBeCloseTo(bet * 0.01, 9);
    }
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { roundUnbiased } from '../src/features/economy/rounding.js';

describe('roundUnbiased', () => {
  it('is exact when the division is exact, without drawing', () => {
    const draw = () => {
      throw new Error('drew for an exact amount');
    };
    expect(roundUnbiased(300, 100, draw)).toBe(3);
    expect(roundUnbiased(0, 100, draw)).toBe(0);
  });

  it('rounds up exactly when the draw is below the remainder', () => {
    // 250 / 100 = 2 remainder 50: draws 0..49 round up, 50..99 do not.
    expect(roundUnbiased(250, 100, () => 0)).toBe(3);
    expect(roundUnbiased(250, 100, () => 49)).toBe(3);
    expect(roundUnbiased(250, 100, () => 50)).toBe(2);
    expect(roundUnbiased(250, 100, () => 99)).toBe(2);
  });

  it('draws from [0, denominator)', () => {
    let seen: number | undefined;
    roundUnbiased(250, 100, (max) => {
      seen = max;
      return 0;
    });
    expect(seen).toBe(100);
  });

  it('has the unrounded amount as its expected value', () => {
    const [numerator, denominator] = [7, 4];
    let total = 0;
    for (let draw = 0; draw < denominator; draw++) {
      total += roundUnbiased(numerator, denominator, () => draw);
    }
    expect(total / denominator).toBe(numerator / denominator);
  });
});

describe('roundUnbiased (properties)', () => {
  const amounts = fc.record({
    numerator: fc.integer({ min: 0, max: 1_000_000_000 }),
    denominator: fc.integer({ min: 1, max: 20_000 }),
  });

  it('is the floor or the floor plus one, plus one exactly when draw < remainder', () => {
    fc.assert(
      fc.property(amounts, fc.nat(), ({ numerator, denominator }, raw) => {
        const draw = raw % denominator;
        const floor = Math.floor(numerator / denominator);
        const remainder = numerator - floor * denominator;
        const result = roundUnbiased(numerator, denominator, () => draw);
        expect([floor, floor + 1]).toContain(result);
        expect(result === floor + 1).toBe(draw < remainder);
      }),
    );
  });

  it('is exact for every draw when the numerator is divisible', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 20_000 }),
        fc.nat(),
        (quotient, denominator, raw) => {
          expect(roundUnbiased(quotient * denominator, denominator, () => raw % denominator)).toBe(
            quotient,
          );
        },
      ),
    );
  });

  it('averages to the exact amount over every possible draw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 200 }),
        (numerator, denominator) => {
          let total = 0;
          for (let draw = 0; draw < denominator; draw++) {
            total += roundUnbiased(numerator, denominator, () => draw);
          }
          expect(total).toBe(numerator);
        },
      ),
    );
  });
});

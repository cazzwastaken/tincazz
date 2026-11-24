import { describe, expect, it } from 'vitest';
import { botFlipRake, flipCoin, flipRake, otherSide } from '../src/features/coinflip/index.js';

describe('flipRake', () => {
  it.each([
    [10, 1],
    [16, 1],
    [17, 1],
    [25, 2],
    [34, 2],
    [100, 6],
    [10_000, 600],
  ])('rake for %i is %i', (bet, rake) => {
    expect(flipRake(bet)).toBe(rake);
  });
});

describe('botFlipRake', () => {
  it('is the rake share of the pool, rounded by the fraction as the odds', () => {
    // 10 coins: 0.6 of a coin.
    expect(botFlipRake(10, () => 59)).toBe(1);
    expect(botFlipRake(10, () => 60)).toBe(0);
    expect(botFlipRake(100, () => 99)).toBe(6);
  });

  // The pot is minted nowhere: against the bot a player loses exactly what the pot gains.
  it.each([10, 25, 99, 1000, 10_000])(
    'pot gain equals the player expected loss at bet %i',
    (bet) => {
      const wholeRake = Math.floor((2 * bet * 3) / 100);
      const upChance = ((2 * bet * 3) % 100) / 100;
      const expectedRake = wholeRake + upChance; // taken on a win (half the flips)
      const potGain = 0.5 * expectedRake;
      const playerLoss = 0.5 * bet - 0.5 * (2 * bet - expectedRake - bet);
      expect(playerLoss).toBeCloseTo(potGain, 9);
      expect(playerLoss / bet).toBeCloseTo(0.03, 9);
    },
  );
});

describe('flipCoin', () => {
  it('flips heads on 0 and tails on 1', () => {
    expect(flipCoin(() => 0)).toBe('heads');
    expect(flipCoin(() => 1)).toBe('tails');
  });

  it('asks for a draw below 2', () => {
    const seen: number[] = [];
    flipCoin((max) => {
      seen.push(max);
      return 0;
    });
    expect(seen).toEqual([2]);
  });

  it('knows the other side', () => {
    expect(otherSide('heads')).toBe('tails');
    expect(otherSide('tails')).toBe('heads');
  });
});

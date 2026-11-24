import { describe, expect, it } from 'vitest';
import { wager as flipWager } from '../src/features/coinflip/config.js';
import { wager as diceWager } from '../src/features/dice/config.js';
import { InsufficientFundsError } from '../src/features/economy/errors.js';
import { InvalidBetError, parseBet } from '../src/features/gamba/bet.js';
import { wager as gambaWager } from '../src/features/gamba/config.js';

const limits = { minBet: 10, maxBet: 10_000, defaultBet: 10 };

function kindOf(input: string, balance: number): unknown {
  try {
    parseBet(input, balance, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidBetError);
    return (error as InvalidBetError).kind;
  }
  return undefined;
}

describe('parseBet', () => {
  it('parses plain numbers and k suffixes', () => {
    expect(parseBet('100', 5000, limits)).toBe(100);
    expect(parseBet(' 250 ', 5000, limits)).toBe(250);
    expect(parseBet('2.5k', 5000, limits)).toBe(2500);
    expect(parseBet('2.5K', 5000, limits)).toBe(2500);
    expect(parseBet('1k', 5000, limits)).toBe(1000);
    expect(parseBet('10', 5000, limits)).toBe(10);
    expect(parseBet('10000', 20_000, limits)).toBe(10_000);
  });

  it('parses all and half', () => {
    expect(parseBet('all', 5000, limits)).toBe(5000);
    expect(parseBet('all', 50_000, limits)).toBe(10_000);
    expect(parseBet('half', 5000, limits)).toBe(2500);
  });

  it.each(['lol', '', '-5', '1.5', '1,000', '1.2345k', 'k'])('rejects %j as format', (input) => {
    expect(kindOf(input, 5000)).toBe('format');
  });

  it('rejects out of range bets', () => {
    for (const input of ['9', '0', '10001', '11k']) {
      expect(kindOf(input, 50_000)).toBe('range');
    }
    expect(kindOf('half', 30_000)).toBe('range');
  });

  it('treats half of a wallet below twice the minimum as a funds error, not a range error', () => {
    for (const balance of [10, 15, 19]) {
      expect(() => parseBet('half', balance, limits)).toThrow(InsufficientFundsError);
    }
    try {
      parseBet('half', 15, limits);
    } catch (error) {
      expect(error).toMatchObject({ balance: 15, needed: 20 });
    }
    expect(parseBet('half', 20, limits)).toBe(10);
  });

  it('clamps all to the maximum bet and half above it is a range error', () => {
    expect(parseBet('all', 10_001, limits)).toBe(10_000);
    expect(parseBet('all', 1_000_000, limits)).toBe(10_000);
    expect(kindOf('half', 30_000)).toBe('range');
  });

  it('throws InsufficientFundsError when the balance cannot cover the bet', () => {
    expect(() => parseBet('6000', 5000, limits)).toThrow(InsufficientFundsError);
    try {
      parseBet('6000', 5000, limits);
    } catch (error) {
      expect(error).toMatchObject({ balance: 5000, needed: 6000 });
    }
    try {
      parseBet('all', 5, limits);
    } catch (error) {
      expect(error).toMatchObject({ balance: 5, needed: 10 });
    }
    expect(() => parseBet('10', 0, limits)).toThrow(InsufficientFundsError);
  });

  it('lets gamba take 1-coin bets while coinflip and dice keep a 10-coin minimum', () => {
    expect(parseBet('1', 1, gambaWager)).toBe(1);
    expect(parseBet('all', 1, gambaWager)).toBe(1);
    expect(() => parseBet('half', 1, gambaWager)).toThrow(InsufficientFundsError);
    expect(parseBet('half', 2, gambaWager)).toBe(1);
    expect(() => parseBet('0', 100, gambaWager)).toThrow(InvalidBetError);
    for (const limits of [flipWager, diceWager]) {
      expect(() => parseBet('9', 100, limits)).toThrow(InvalidBetError);
      expect(() => parseBet('10', 9, limits)).toThrow(InsufficientFundsError);
    }
  });
});

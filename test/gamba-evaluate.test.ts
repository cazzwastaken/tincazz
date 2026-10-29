import { describe, expect, it } from 'vitest';
import { type PayoutTier, payoutBps, wager } from '../src/features/gamba/config.js';
import { evaluate } from '../src/features/gamba/evaluate.js';
import { spinGamba } from '../src/features/gamba/index.js';
import { maxPotWin, potContribution, potShare, rareWinShare } from '../src/features/gamba/pot.js';

describe('evaluate', () => {
  it('classifies all 21^3 draws', () => {
    const counts = { none: 0, pair: 0, triple: 0, jackpot: 0 };
    let totalBps = 0;
    const tierCounts: Record<string, number> = {};
    for (let a = 0; a < 21; a++) {
      for (let b = 0; b < 21; b++) {
        for (let c = 0; c < 21; c++) {
          const draws = [a, b, c];
          const evaluation = evaluate(spinGamba(() => draws.shift() ?? 0));
          counts[evaluation.result]++;
          totalBps += evaluation.payoutBps;
          tierCounts[evaluation.tier] = (tierCounts[evaluation.tier] ?? 0) + 1;
        }
      }
    }
    expect(counts).toEqual({ none: 5886, pair: 3204, triple: 170, jackpot: 1 });
    expect(tierCounts).toEqual({
      none: 5886,
      ytPair: 2916,
      pythonPair: 228,
      cppPair: 60,
      ytTriple: 162,
      pythonTriple: 8,
      cppTriple: 1,
    });
    expect(totalBps).toBe(91_440_000);
    // About a 1% house edge: the average spin returns 98.5–99.5% of the bet, before the pot.
    const returned = totalBps / (21 ** 3 * 10_000);
    expect(returned).toBeGreaterThanOrEqual(0.985);
    expect(returned).toBeLessThanOrEqual(0.995);
  });

  it('loses on average at every bet, however big the pot gets', () => {
    const tierCounts: Partial<Record<PayoutTier, number>> = {};
    for (let a = 0; a < 21; a++) {
      for (let b = 0; b < 21; b++) {
        for (let c = 0; c < 21; c++) {
          const draws = [a, b, c];
          const { tier } = evaluate(spinGamba(() => draws.shift() ?? 0));
          tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
        }
      }
    }
    for (let bet = wager.minBet; bet <= wager.maxBet; bet++) {
      const amount = 1_000_000_000_000 + potContribution(bet);
      let total = 0;
      for (const [tier, count] of Object.entries(tierCounts) as [PayoutTier, number][]) {
        const potWon =
          tier === 'cppTriple'
            ? Math.min(potShare(amount, bet), maxPotWin(bet, tier))
            : rareWinShare(amount, bet, tier);
        total += count * (Math.floor((bet * payoutBps[tier]) / 10_000) + potWon);
      }
      expect(total / 21 ** 3, `bet ${bet}`).toBeLessThan(bet);
    }
  });

  it('pays the jackpot for three cpp', () => {
    expect(evaluate(['cpp', 'cpp', 'cpp'])).toEqual({
      result: 'jackpot',
      odds: 9261,
      tier: 'cppTriple',
      payoutBps: 1_000_000,
    });
  });

  it('pays python and yt triples', () => {
    expect(evaluate(['python', 'python', 'python'])).toEqual({
      result: 'triple',
      odds: 1158,
      tier: 'pythonTriple',
      payoutBps: 250_000,
    });
    expect(evaluate(['head', 'head', 'head'])).toEqual({
      result: 'triple',
      odds: 343,
      tier: 'ytTriple',
      payoutBps: 100_000,
    });
  });

  it('does not pay a free pair', () => {
    expect(evaluate(['head', 'head', 'cpp'])).toEqual({
      result: 'pair',
      odds: undefined,
      tier: 'ytPair',
      payoutBps: 20_000,
    });
  });

  it('tiers pairs by the repeated key', () => {
    expect(evaluate(['python', 'head', 'python'])).toMatchObject({
      tier: 'pythonPair',
      payoutBps: 40_000,
    });
    expect(evaluate(['cpp', 'cpp', 'head'])).toMatchObject({ tier: 'cppPair', payoutBps: 80_000 });
    expect(evaluate(['head', 'cry', 'grr'])).toMatchObject({ tier: 'none', payoutBps: 0 });
  });
});

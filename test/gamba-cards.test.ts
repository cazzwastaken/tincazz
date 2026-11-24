import { describe, expect, it } from 'vitest';
import { bailout } from '../src/features/economy/config.js';
import { InsufficientFundsError } from '../src/features/economy/errors.js';
import {
  announcementCard,
  evaluate,
  InvalidBetError,
  notYourSpin,
  type Reels,
  spinErrorText,
  type WagerSpin,
  wagerCard,
} from '../src/features/gamba/index.js';
import { accents } from '../src/features/ui/index.js';

const limits = { minBet: 10, maxBet: 10_000, defaultBet: 10 };

const wagerSpin = (reels: Reels, bet: number, extra: Partial<WagerSpin> = {}): WagerSpin => {
  const evaluation = evaluate(reels);
  return {
    mode: 'wager',
    reels,
    evaluation,
    bet,
    payout: Math.floor((bet * evaluation.payoutBps) / 10_000),
    potWon: 0,
    balance: 1_000,
    pot: 10_003,
    spinId: 1,
    ...extra,
  };
};

const json = (c: { toJSON(): unknown }) => JSON.stringify(c.toJSON());
const accent = (c: { toJSON(): { accent_color?: number | null } }) => c.toJSON().accent_color;

describe('wagerCard', () => {
  it('shows a win with both buttons', () => {
    const c = wagerCard('1', wagerSpin(['head', 'head', 'cry'], 100, { balance: 1_020 }));
    const text = json(c);
    expect(accent(c)).toBe(accents.win);
    expect(text).toContain('**Pair** · 2x');
    expect(text).toContain('Bet 100 → 200 (+100)');
    expect(text).toContain('balance 1,020 · pot 10,003');
    expect(text).toContain('gamba:again:1:100');
    expect(text).toContain('gamba:double:1:200');
    expect(text).toContain('Double (200)');
  });

  it('shows a loss', () => {
    const c = wagerCard('1', wagerSpin(['head', 'cry', 'grr'], 100));
    expect(accent(c)).toBe(accents.loss);
    expect(json(c)).toContain('Bet 100 → 0 (-100)');
    expect(json(c)).toContain('**No match**');
  });

  it('hides Double above the max bet or the balance', () => {
    expect(
      json(wagerCard('1', wagerSpin(['head', 'cry', 'grr'], 6_000, { balance: 50_000 }))),
    ).not.toContain('gamba:double');
    expect(
      json(wagerCard('1', wagerSpin(['head', 'cry', 'grr'], 600, { balance: 1_000 }))),
    ).not.toContain('gamba:double');
  });

  it('is gold with the pot line on a jackpot', () => {
    const c = wagerCard('1', wagerSpin(['cpp', 'cpp', 'cpp'], 100, { potWon: 10_015 }));
    expect(accent(c)).toBe(accents.gold);
    expect(json(c)).toContain('100x');
    expect(json(c)).toContain('+10,015 from the pot');
  });
});

describe('announcementCard', () => {
  it('announces a python triple', () => {
    const c = announcementCard('1', wagerSpin(['python', 'python', 'python'], 100));
    const text = json(c);
    expect(accent(c)).toBe(accents.gold);
    expect(text).toContain('Won 2,500 on a 100 bet');
    expect(text).toContain('Odds: 1 in 1,158');
    expect(text).not.toContain('You are a pro');
  });

  it('announces a wagered jackpot', () => {
    const spin = wagerSpin(['cpp', 'cpp', 'cpp'], 500, { potWon: 10_015 });
    const text = json(announcementCard('1', spin, true, '77'));
    expect(text).toContain('Won 50,000 on a 500 bet');
    expect(text).toContain('+10,015 from the pot');
    expect(text).toContain(`You are a pro! You just won <@&77>`);
    expect(text).not.toContain("couldn't assign");
    expect(json(announcementCard('1', spin, false, '77'))).toContain(
      "(couldn't assign the role, tell a mod)",
    );
  });

  it('skips the role line without a jackpot role', () => {
    const spin = wagerSpin(['cpp', 'cpp', 'cpp'], 500, { potWon: 10_015 });
    const text = json(announcementCard('1', spin));
    expect(text).toContain('Won 50,000 on a 500 bet');
    expect(text).not.toContain('You are a pro');
  });
});

describe('spinErrorText', () => {
  it('explains bad bets', () => {
    expect(spinErrorText(new InvalidBetError('format', ' lol ', limits))).toBe(
      "`lol` isn't a bet. Use a number from 10 to 10,000, `all`, `half` or `2.5k`.",
    );
    expect(spinErrorText(new InvalidBetError('range', '5', limits))).toBe(
      'Bets go from 10 to 10,000.',
    );
  });

  it.each([
    ['a newline', 'abc\n# huge', 'abc # huge'],
    ['a zero-width space', 'a​ll', 'all'],
    ['a right-to-left override', '‮001', '001'],
    ['backticks', '`<@1>`', '<@1>'],
    ['a lone surrogate', 'x\ud800y', 'xy'],
    ['an emoji on the 20 character boundary', `${'a'.repeat(19)}😀😀`, `${'a'.repeat(19)}😀`],
  ])('echoes a bad bet with %s safely', (_case, input, shown) => {
    expect(spinErrorText(new InvalidBetError('format', input, limits))).toBe(
      `\`${shown}\` isn't a bet. Use a number from 10 to 10,000, \`all\`, \`half\` or \`2.5k\`.`,
    );
  });

  it('does not echo an empty code span', () => {
    expect(spinErrorText(new InvalidBetError('format', '​​', limits))).toBe(
      "That isn't a bet. Use a number from 10 to 10,000, `all`, `half` or `2.5k`.",
    );
  });

  it('explains insufficient funds', () => {
    expect(spinErrorText(new InsufficientFundsError(40, 100))).toBe(
      'You have 40 coins. Try a smaller bet.',
    );
    expect(spinErrorText(new InsufficientFundsError(5, 10))).toBe(
      'You have 5 coins. `/bailout` is available.',
    );
  });

  it('offers the bailout exactly when the balance qualifies for one', () => {
    expect(spinErrorText(new InsufficientFundsError(bailout.belowBalance - 1, 50))).toContain(
      '`/bailout` is available.',
    );
    expect(spinErrorText(new InsufficientFundsError(bailout.belowBalance, 50))).toContain(
      'Try a smaller bet.',
    );
  });

  it('shows the range of the limits the bet was checked against', () => {
    const dice = { minBet: 25, maxBet: 500, defaultBet: 25 };
    expect(spinErrorText(new InvalidBetError('range', '5', dice))).toBe('Bets go from 25 to 500.');
  });

  it('ignores other errors', () => {
    expect(spinErrorText(new Error('x'))).toBeUndefined();
  });

  it('has the not-your-spin text', () => {
    expect(notYourSpin).toContain('/gamba');
  });
});

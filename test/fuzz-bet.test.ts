import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InsufficientFundsError } from '../src/features/economy/errors.js';
import { InvalidBetError, parseBet } from '../src/features/gamba/bet.js';
import { echoBetInput, spinErrorText } from '../src/features/gamba/cards.js';
import { wager } from '../src/features/gamba/config.js';

// Pieces of the bet grammar plus the usual suspects (signs, exponents, separators, non-ASCII
// digits, invisible and look-alike characters), so generated strings land near the edge cases.
const betPieces = [
  '0',
  '1',
  '5',
  '9',
  '00',
  '10',
  '.',
  'k',
  'K',
  'K', // Kelvin sign, lower-cases to "k"
  'all',
  'ALL',
  'half',
  'hAlF',
  ' ',
  '\t',
  '\n',
  ' ',
  '​',
  '-',
  '+',
  'e',
  '1e3',
  '0x',
  '_',
  ',',
  '٣', // Arabic-Indic digit three
  '１', // fullwidth digit one
  '`',
  '<@1>',
  '@everyone',
];

const betLike = fc
  .array(fc.constantFrom(...betPieces), { maxLength: 12 })
  .map((pieces) => pieces.join(''));

const anyBet = fc.oneof(
  betLike,
  fc.string({ unit: 'binary', maxLength: 64 }),
  fc.stringMatching(/^\s*\d{1,30}\s*$/),
  fc.stringMatching(/^\d{1,8}(\.\d{1,5})?[kK]$/),
);

const anyBalance = fc.oneof(
  fc.integer({ min: 0, max: 100 }),
  fc.integer({ min: 0, max: 30_000 }),
  fc.integer({ min: 0, max: 1e12 }),
);

type Outcome = number | 'format' | 'range' | 'funds';

function outcome(input: string, balance: number): Outcome {
  try {
    return parseBet(input, balance, wager);
  } catch (error) {
    if (error instanceof InvalidBetError) return error.kind;
    if (error instanceof InsufficientFundsError) return 'funds';
    throw error;
  }
}

/** An independent model of the bet rules, using BigInt so huge inputs cannot lose precision. */
function expected(input: string, balance: number): Outcome {
  const text = input.trim().toLowerCase();
  const plain = /^([0-9]+)$/.exec(text);
  const kilo = /^([0-9]+)(?:\.([0-9]+))?k$/.exec(text);
  let fixed: bigint | undefined;
  if (plain) {
    fixed = BigInt(plain[1] as string);
  } else if (kilo) {
    const fraction = kilo[2] ?? '';
    if (fraction.length > 3) return 'format';
    fixed = BigInt(kilo[1] as string) * 1000n + BigInt(fraction.padEnd(3, '0'));
  } else if (text !== 'all' && text !== 'half') {
    return 'format';
  }
  if (balance < wager.minBet) return 'funds';
  // Half of a wallet under twice the minimum is a funds problem, not a bad range.
  if (fixed === undefined && text === 'half' && Math.floor(balance / 2) < wager.minBet) {
    return 'funds';
  }
  const value =
    fixed ?? BigInt(text === 'all' ? Math.min(balance, wager.maxBet) : Math.floor(balance / 2));
  if (value < BigInt(wager.minBet) || value > BigInt(wager.maxBet)) return 'range';
  if (value > BigInt(balance)) return 'funds';
  return Number(value);
}

describe('parseBet fuzz', () => {
  it('returns an affordable whole bet within the limits, or throws a bet error', () => {
    fc.assert(
      fc.property(anyBet, anyBalance, (input, balance) => {
        const result = outcome(input, balance);
        if (typeof result === 'number') {
          expect(Number.isSafeInteger(result)).toBe(true);
          expect(result).toBeGreaterThanOrEqual(wager.minBet);
          expect(result).toBeLessThanOrEqual(Math.min(wager.maxBet, balance));
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('agrees with an independent BigInt model of the rules', () => {
    fc.assert(
      fc.property(anyBet, anyBalance, (input, balance) => {
        expect(outcome(input, balance)).toEqual(expected(input, balance));
      }),
      { numRuns: 2000 },
    );
  });

  it('never accepts non-ASCII digits, signs, exponents or separators', () => {
    const foreign = fc
      .tuple(
        fc.stringMatching(/^\d{0,4}$/),
        fc.constantFrom('٣', '１', '-', '+', 'e3', '_', ',', '0x', 'Infinity', 'NaN'),
        fc.stringMatching(/^\d{0,4}$/),
      )
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(foreign, (input) => {
        expect(outcome(input, 1e9)).toBe('format');
      }),
    );
  });
});

describe('bad bet echo fuzz', () => {
  it('echoes at most 20 visible characters on one line, with no backticks', () => {
    fc.assert(
      fc.property(fc.oneof(betLike, fc.string({ unit: 'binary', maxLength: 200 })), (input) => {
        const shown = echoBetInput(input);
        expect([...shown].length).toBeLessThanOrEqual(20);
        expect(shown).not.toMatch(/[\p{C}`\n\r]/u);
        expect(shown).toBe(shown.trim());
      }),
      { numRuns: 2000 },
    );
  });

  it('keeps the reply to its own code spans', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (input) => {
        const text = spinErrorText(new InvalidBetError('format', input, wager)) as string;
        const shown = echoBetInput(input);
        // `all`, `half` and `2.5k` in the hint, plus the echoed span when there is anything to show.
        expect(text.split('`').length - 1).toBe(shown === '' ? 6 : 8);
        expect(text).not.toMatch(/[\p{C}\n\r]/u);
      }),
      { numRuns: 1000 },
    );
  });
});

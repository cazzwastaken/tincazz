import { escapeMarkdown } from 'discord.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { giveaway } from '../src/features/giveaways/config.js';
import { parseGiveawayDuration, parseGiveawayPrize } from '../src/features/giveaways/inputs.js';

describe('giveaway inputs', () => {
  it.each([
    ['1 minute', 60_000],
    [' 12 HOURS ', 43_200_000],
    ['1 day', 86_400_000],
    ['30d', 2_592_000_000],
    ['0m', null],
    ['31days', null],
    ['1.5 hours', null],
    ['-2m', null],
    ['2h 30m', null],
    ['9999999999999999999d', null],
  ] as const)('parses %s', (input, expected) => {
    expect(parseGiveawayDuration(input)).toBe(expected);
  });

  it('parses supported units and rejects durations outside the configured interval', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50_000 }),
        fc.constantFrom(['m', 1], ['hour', 60], ['days', 1440]),
        fc.constantFrom('', ' ', '\t'),
        (value, [unit, minutes], gap) => {
          const duration = value * minutes * 60_000;
          const valid = duration >= giveaway.minDurationMs && duration <= giveaway.maxDurationMs;
          expect(parseGiveawayDuration(`${value}${gap}${unit}`)).toBe(valid ? duration : null);
        },
      ),
    );
  });

  it('keeps accepted prize names safe for embed titles and list fields', () => {
    expect(parseGiveawayPrize(' \n One   month \t of Nitro ')).toBe('One month of Nitro');
    expect(parseGiveawayPrize(' \t\n ')).toBeNull();
    expect(parseGiveawayPrize('x'.repeat(101))).toBeNull();
    fc.assert(
      fc.property(fc.string({ maxLength: 150 }), (input) => {
        const parsed = parseGiveawayPrize(input);
        if (parsed !== null) {
          expect(parsed.length).toBeLessThanOrEqual(giveaway.maxPrizeLength);
          expect(parsed).toBe(parsed.trim());
          expect(`#9007199254740991 · ${escapeMarkdown(parsed)}`.length).toBeLessThanOrEqual(256);
        }
      }),
    );
  });
});

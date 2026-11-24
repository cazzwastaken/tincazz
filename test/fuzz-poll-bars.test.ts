import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { optionBar, optionResults, outcome, percent, splitBar } from '../src/features/poll/bars.js';
import { decodePollCloseId, encodePollCloseId } from '../src/features/poll/custom-ids.js';

const count = fc.integer({ min: 0, max: 1_000_000 });
const cells = (text: string) => [...text.matchAll(/🟩|🟥|🟦|⬜/gu)].length;

describe('fuzz: poll bars', () => {
  it('split bars have exactly the width and ordered colors', () => {
    fc.assert(
      fc.property(count, count, fc.integer({ min: 2, max: 30 }), (yes, no, width) => {
        const bar = splitBar(yes, no, width);
        expect(cells(bar)).toBe(width);
        expect(bar).toMatch(/^(🟩*🟥*|⬜+)$/u);
        if (yes > 0) expect(bar).toContain('🟩');
        if (no > 0) expect(bar).toContain('🟥');
      }),
    );
  });

  it('option bars have exactly the width and fill with the share', () => {
    fc.assert(
      fc.property(count, count, fc.integer({ min: 1, max: 30 }), (a, b, width) => {
        const total = a + b;
        expect(cells(optionBar(a, total, width))).toBe(width);
        const filled = (bar: string) => [...bar.matchAll(/🟦/gu)].length;
        if (a <= b)
          expect(filled(optionBar(a, total, width))).toBeLessThanOrEqual(
            filled(optionBar(b, total, width)),
          );
      }),
    );
  });

  it('percentages stay in 0..100 and are monotonic', () => {
    fc.assert(
      fc.property(count, count, (a, b) => {
        const total = a + b;
        expect(percent(a, total)).toBeGreaterThanOrEqual(0);
        expect(percent(a, total)).toBeLessThanOrEqual(100);
        if (a <= b) expect(percent(a, total)).toBeLessThanOrEqual(percent(b, total));
      }),
    );
  });

  it('crowns exactly the leaders and never at zero', () => {
    fc.assert(
      fc.property(fc.array(count, { minLength: 2, maxLength: 9 }), (counts) => {
        const options = counts.map((_, i) => `o${i}`);
        const text = optionResults(options, options, counts);
        const crowns = (text.match(/👑/g) ?? []).length;
        const top = Math.max(...counts);
        expect(crowns).toBe(top === 0 ? 0 : counts.filter((c) => c === top).length);
        expect(outcome(counts).kind === 'none').toBe(top === 0);
      }),
    );
  });
});

describe('fuzz: poll custom ids', () => {
  it('never throws and only decodes well-formed ids', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const decoded = decodePollCloseId(id);
        if (decoded) expect(encodePollCloseId(decoded)).toBe(id);
      }),
    );
  });

  it('round-trips', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[1-9][0-9]{16,19}$/),
        fc.integer({ min: 1, max: 999_999_999 }),
        (guildId, pollId) => {
          expect(decodePollCloseId(encodePollCloseId({ guildId, pollId }))).toEqual({
            guildId,
            pollId,
          });
        },
      ),
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  escapeMarkup,
  ImagingError,
  noMentionNames,
  sanitizeCaption,
} from '../src/features/imaging/index.js';

const texts = [
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.stringMatching(/^[<>@#&!:a0-9 \n\r\t​‍]*$/),
];

function attempt(x: string): string | undefined {
  try {
    return sanitizeCaption(x, noMentionNames);
  } catch (e) {
    if (e instanceof ImagingError) return undefined;
    throw e;
  }
}

describe.each(texts.map((arb, i) => [i, arb] as const))(
  'caption fuzz (arbitrary %i)',
  (_i, arb) => {
    it('sanitizeCaption throws ImagingError or returns clean text', () => {
      fc.assert(
        fc.property(arb, (x) => {
          const out = attempt(x);
          if (out === undefined) return;
          expect(out.split('\n').length).toBeLessThanOrEqual(5);
          expect(/[^\P{Cc}\n]/u.test(out)).toBe(false);
          expect(out).toBe(out.trim());
          expect(out.length).toBeGreaterThan(0);
        }),
      );
    });

    it('is idempotent', () => {
      fc.assert(
        fc.property(arb, (x) => {
          const once = attempt(x);
          if (once === undefined) return;
          expect(sanitizeCaption(once, noMentionNames)).toBe(once);
        }),
      );
    });

    it('escapeMarkup leaves no angle brackets and only valid entities', () => {
      fc.assert(
        fc.property(arb, (x) => {
          const out = escapeMarkup(x);
          expect(out).not.toMatch(/[<>]/);
          expect(out.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
        }),
      );
    });
  },
);

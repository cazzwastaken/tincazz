import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  quoteExcerpt,
  quoteText,
  replySnippet,
  safeFileName,
  truncateText,
} from '../src/features/halloffame/index.js';

const tokenPattern =
  /<(?:@[!&]?\d+|#\d+|a?:\w+:\d+|t:-?\d+(?::[a-zA-Z])?|\/[\w-]+(?: [\w-]+){0,2}:\d+|id:\w+)>/gu;

const piece = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.constantFrom(
    '😀',
    '👨‍👩‍👧',
    '<@123456789012345678>',
    '<@!42>',
    '<#99>',
    '<:wave:123456789>',
    '<a:d:5>',
    '```',
    '```js\n',
    '\n',
    '\r\n',
    '  ',
    '<t:1700000000:R>',
    '`',
  ),
);
const text = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(''));

/** The kept part of a truncated text: without the ellipsis and any fence closer. */
function keptPrefix(result: string): string {
  if (result.endsWith('…\n```')) return result.slice(0, -'…\n```'.length);
  return result.slice(0, -1);
}

/** No lone surrogate halves (the lib target predates String.isWellFormed). */
function isWellFormed(value: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value);
}

describe('fuzz: hall of fame content', () => {
  it('truncation never exceeds the limit, splits a pair or a token, and balances fences', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 0, max: 80 }), (input, max) => {
        const out = truncateText(input, max);
        expect(out.length).toBeLessThanOrEqual(Math.max(0, max));
        if (isWellFormed(input)) expect(isWellFormed(out)).toBe(true);
        if (input.length <= max) {
          expect(out).toBe(input);
          return;
        }
        if (max <= 0) {
          expect(out).toBe('');
          return;
        }
        expect(out.endsWith('…') || out.endsWith('…\n```')).toBe(true);
        const kept = keptPrefix(out);
        expect(input.startsWith(kept)).toBe(true);
        for (const match of input.matchAll(tokenPattern)) {
          const start = match.index;
          const end = start + match[0].length;
          expect(kept.length > start && kept.length < end).toBe(false);
        }
        expect((out.match(/```/gu) ?? []).length % 2).toBe(0);
      }),
      { numRuns: 1000 },
    );
  });

  it('is idempotent on its own output', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 60 }), (input, max) => {
        const once = truncateText(input, max);
        expect(truncateText(once, max)).toBe(once);
      }),
    );
  });

  it('quotes every line and respects the quoted limit', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 200 }), (input, max) => {
        const quoted = quoteText(input);
        if (input === '') expect(quoted).toBe('');
        for (const line of quoted.split('\n')) {
          if (input !== '') expect(line.startsWith('> ')).toBe(true);
        }
        const limit = max * 2;
        expect(quoteExcerpt(input, max, limit).length).toBeLessThanOrEqual(Math.max(limit, 3));
      }),
    );
  });

  it('snippets are one line and short', () => {
    fc.assert(
      fc.property(text, (input) => {
        const snippet = replySnippet(input, false, 40);
        expect(snippet).not.toMatch(/[\r\n]/u);
        expect(snippet).not.toContain('```');
        expect(snippet.length).toBeLessThanOrEqual(40);
      }),
    );
  });

  it('safe file names carry no control characters or backticks', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 100 }), (name) => {
        const safe = safeFileName(name);
        expect(safe).not.toMatch(/[\p{Cc}`]/u);
        expect(safe.length).toBeGreaterThan(0);
        expect(safe.length).toBeLessThanOrEqual(60);
      }),
    );
  });
});

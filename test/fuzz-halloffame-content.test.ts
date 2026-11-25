import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  hideSpoilers,
  pickEmbedMedia,
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

/** The kept part of a truncated text: without the ellipsis and any fence or spoiler closer. */
function keptPrefix(result: string): string {
  return result.replace(/…(?:\n```)?(?:\n?\|\|)?$/u, '');
}

/** `||` markers outside code fences, for text without backslashes or single backticks. */
function spoilerMarkers(value: string): number {
  const outside = value.replace(/```[\s\S]*?(?:```|$)/gu, ' ');
  return (outside.match(/\|\|/gu) ?? []).length;
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
        expect(/…(?:\n```)?(?:\n?\|\|)?$/u.test(out)).toBe(true);
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

  it('never leaves a spoiler open after a cut, and never hides from a preview', () => {
    const spoilerPiece = fc.oneof(
      fc.string({ maxLength: 8 }).map((value) => value.replace(/[\\`]/gu, '')),
      fc.constantFrom('||', '|', ' ', '\n', '```', '```js\n', '😀', '<@123456789012345678>', '…'),
    );
    const spoilerText = fc.array(spoilerPiece, { maxLength: 40 }).map((parts) => parts.join(''));
    fc.assert(
      fc.property(spoilerText, fc.integer({ min: 1, max: 60 }), (input, max) => {
        const out = truncateText(input, max);
        expect(out.length).toBeLessThanOrEqual(max);
        if (input.length > max) expect(spoilerMarkers(out) % 2).toBe(0);
        const hidden = replySnippet(input, false, 400);
        expect(hidden).not.toContain('||');
      }),
      { numRuns: 2000 },
    );
  });

  it('keeps spoiler text hidden around cut single- and double-backtick spans', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('`', '``'),
        fc.integer({ min: 1, max: 80 }),
        fc.integer({ min: 1, max: 100 }),
        (delimiter, length, max) => {
          const input = `start ||secret ${delimiter}|| ${'x'.repeat(length)}${delimiter} tail||`;
          const visible = hideSpoilers(truncateText(input, max));
          expect(visible).not.toMatch(/secret|x|tail/u);
        },
      ),
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
        expect(quoteExcerpt(input, max, limit).length).toBeLessThanOrEqual(limit);
      }),
    );
  });

  it('respects a tight quoted limit for any text', () => {
    // The counterexample ["\n", 1] (quoted limit 2) once gave seven characters.
    const cases: [string, number][] = [['\n', 1]];
    for (const [input, max] of cases) {
      expect(quoteExcerpt(input, max, max * 2).length).toBeLessThanOrEqual(max * 2);
    }
    fc.assert(
      fc.property(
        text,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 8 }),
        (input, max, cap) => {
          expect(quoteExcerpt(input, max, cap).length).toBeLessThanOrEqual(cap);
        },
      ),
      { numRuns: 1000 },
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

  describe('spoilers', () => {
    // Words without any character that matters to the spoiler tokenizer.
    const words = fc
      .string({ maxLength: 12 })
      .map((value) => value.replace(/[\\`|]/gu, '').replace(/ZQX/gu, ''));
    // Text that holds a literal || which Discord does not read as a marker.
    const neutral = fc.oneof(
      words,
      fc.constantFrom('`||` ', '\\|| ', '```||``` ', '``||`` ', '```\n||\n``` ', '\\||\\|| '),
    );
    const before = fc.array(neutral, { maxLength: 6 }).map((parts) => parts.join(' '));

    it('never shows the text between a balanced || pair', () => {
      fc.assert(
        fc.property(
          before,
          words,
          words,
          fc.integer({ min: 5, max: 400 }),
          (head, tail, mid, max) => {
            const input = `${head} ||ZQX${mid}ZQX|| ${tail}`;
            expect(hideSpoilers(input)).not.toContain('ZQX');
            expect(replySnippet(input, false, max)).not.toContain('ZQX');
            expect(replySnippet(input, true, 400)).not.toContain('||');
          },
        ),
        { numRuns: 1500 },
      );
    });

    it('hides an unclosed || to the end', () => {
      fc.assert(
        fc.property(before, words, (head, tail) => {
          expect(replySnippet(`${head} ||ZQX ${tail}`, false, 400)).not.toContain('ZQX');
        }),
      );
    });

    it('flags media that follows any || marker as a spoiler', () => {
      const url = 'https://example.com/cat.png';
      const embed = {
        type: 'image',
        url,
        image: { url, proxyUrl: 'https://images-ext-1.discordapp.net/external/h/cat.png' },
      };
      fc.assert(
        fc.property(before, words, words, fc.boolean(), (head, mid, tail, closed) => {
          const content = `${head} ||${mid}${closed ? '||' : ''} ${url} ${tail}`;
          expect(pickEmbedMedia([embed], content, 1)[0]?.spoiler).toBe(true);
          // Without a marker of its own, text of this kind never makes media a spoiler.
          expect(pickEmbedMedia([embed], `${head} ${url} ${tail}`, 1)[0]?.spoiler).toBe(false);
        }),
        { numRuns: 1000 },
      );
    });
  });
});

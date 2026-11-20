import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkUrl, extractUrls, isAllowedHost } from '../src/features/imaging/index.js';

describe('checkUrl properties', () => {
  it('never throws and only approves https on allowed hosts', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.string({ unit: 'binary' })), (s) => {
        const r = checkUrl(s);
        if (r.ok) {
          expect(r.url.protocol).toBe('https:');
          expect(isAllowedHost(r.url.hostname)).toBe(true);
          expect(r.url.username).toBe('');
          expect(r.url.port).toBe('');
        }
      }),
    );
  });

  it('rejects web urls whose host is not allowed', () => {
    fc.assert(
      fc.property(
        fc.webUrl().filter((u) => !isAllowedHost(new URL(u).hostname)),
        (u) => {
          expect(checkUrl(u).ok).toBe(false);
        },
      ),
    );
  });
});

const count = (text: string, char: string) => text.split(char).length - 1;

describe('extractUrls properties', () => {
  const chars = (set: string) =>
    fc.array(fc.constantFrom(...set), { maxLength: 6 }).map((c) => c.join(''));
  /** what may follow a url in a sentence: punctuation and closing brackets */
  const tail = chars('.,;:!?)]>');
  const text = fc.oneof(
    fc.string(),
    fc.tuple(fc.string(), fc.webUrl(), chars('.,;:!?)]>([ '), fc.string()).map((p) => p.join('')),
  );

  it('never ends a url with punctuation or an unbalanced closing bracket', () => {
    fc.assert(
      fc.property(text, (input) => {
        for (const url of extractUrls(input)) {
          expect(url).toMatch(/^https?:\/\//i);
          expect(input).toContain(url);
          expect(url).not.toMatch(/[.,;:!?>]$/);
          if (url.endsWith(')')) expect(count(url, '(')).toBeGreaterThanOrEqual(count(url, ')'));
          if (url.endsWith(']')) expect(count(url, '[')).toBeGreaterThanOrEqual(count(url, ']'));
        }
      }),
    );
  });

  it('keeps a web url followed by a space intact up to its trailing punctuation', () => {
    // an opening bracket in the url would make a closing one in the tail balanced, and kept
    const plainUrl = fc.webUrl().filter((u) => !/[([]/.test(u));
    fc.assert(
      fc.property(plainUrl, tail, (url, end) => {
        const [found] = extractUrls(`${url}${end} after`);
        expect(found !== undefined && url.startsWith(found)).toBe(true);
      }),
    );
  });
});

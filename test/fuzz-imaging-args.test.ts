import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commandRemainder, parseBubbleArgs, parseMemeArgs } from '../src/features/imaging/index.js';

describe('args fuzz', () => {
  it('never throws on any string', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), fc.string(), (x, p) => {
        parseBubbleArgs(x);
        parseMemeArgs(x);
        commandRemainder(x, p, 'meme');
      }),
    );
  });

  it('bubble results always carry valid style and tail', () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        const r = parseBubbleArgs(x);
        if ('error' in r) return;
        expect(['transparent', 'white']).toContain(r.style);
        expect(['left', 'right']).toContain(r.tail);
      }),
    );
  });

  it('valid token permutations parse to their values', () => {
    const pick = (opts: string[]) => fc.constantFrom(...opts);
    fc.assert(
      fc.property(
        fc.record({
          style: pick(['white', 'transparent', 'WHITE', 'Transparent']),
          tail: pick(['left', 'right', 'LEFT', 'Right']),
          source: pick([
            'https://media.tenor.com/a.gif',
            '<https://media.giphy.com/b.gif>',
            '<@123456789012345678>',
            '123456789012345678',
          ]),
        }),
        fc.shuffledSubarray(['style', 'tail', 'source'] as const),
        fc.constantFrom(' ', '  ', '\t', '\n'),
        (v, keys, sep) => {
          const r = parseBubbleArgs(keys.map((k) => v[k]).join(sep));
          expect(r).not.toHaveProperty('error');
          if ('error' in r) return;
          expect(r.style).toBe(keys.includes('style') ? v.style.toLowerCase() : 'transparent');
          expect(r.tail).toBe(keys.includes('tail') ? v.tail.toLowerCase() : 'left');
          if (keys.includes('source')) {
            expect(r.url ?? r.userId).toBeDefined();
          } else {
            expect(r.url).toBeUndefined();
            expect(r.userId).toBeUndefined();
          }
        },
      ),
    );
  });

  it('commandRemainder returns the text after the name', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => /^\S+$/.test(s)),
        fc.string(),
        (rest, extra) => {
          const text = ` ${rest}${extra}`;
          expect(commandRemainder(`?meme${text}`, '?', 'meme')).toBe(text.trim());
        },
      ),
    );
  });
});

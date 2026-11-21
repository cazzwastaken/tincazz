import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type HelpPage, helpPages, isHelpPage, parseTopic } from '../src/features/help/index.js';

const known: [string, HelpPage][] = [
  ['home', 'home'],
  ['games', 'games'],
  ['game', 'games'],
  ['images', 'images'],
  ['image', 'images'],
  ['bubble', 'images'],
  ['caption', 'images'],
  ['coins', 'coins'],
  ['coin', 'coins'],
  ['economy', 'coins'],
  ['daily', 'coins'],
  ['collect', 'coins'],
  ['bailout', 'coins'],
  ['gamba', 'gamba'],
  ['pot', 'gamba'],
  ['jackpot', 'gamba'],
  ['coinflip', 'flipdice'],
  ['cf', 'flipdice'],
  ['flip', 'flipdice'],
  ['dice', 'flipdice'],
  ['roll', 'flipdice'],
  ['flipdice', 'flipdice'],
];

const whitespace = fc.stringMatching(/^[ \t\n]{0,4}$/);
const prefix = fc.constantFrom('', '/', '?', '!', '.', '?/');
const mixedCase = (word: string) =>
  fc
    .array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((flags) => [...word].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(''));

describe('parseTopic properties', () => {
  it('never throws and always returns a valid help page', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.constant(undefined)),
        (input) => {
          const page = parseTopic(input);
          expect(isHelpPage(page)).toBe(true);
          expect(helpPages).toContain(page);
        },
      ),
    );
  });

  it('maps every known alias, in any case, with a prefix and surrounding whitespace', () => {
    fc.assert(
      fc.property(
        fc
          .constantFrom(...known)
          .chain(([alias, page]) =>
            fc.tuple(whitespace, prefix, mixedCase(alias), whitespace, fc.constant(page)),
          ),
        ([before, lead, word, after, page]) => {
          expect(parseTopic(`${before}${lead}${word}${after}`)).toBe(page);
        },
      ),
    );
  });

  it('sends unknown words home', () => {
    const aliases = new Set(known.map(([alias]) => alias));
    fc.assert(
      fc.property(
        fc.string().filter(
          (s) =>
            !aliases.has(
              s
                .trim()
                .toLowerCase()
                .replace(/^[/?!.]+/, ''),
            ),
        ),
        (input) => {
          expect(parseTopic(input)).toBe('home');
        },
      ),
    );
  });
});

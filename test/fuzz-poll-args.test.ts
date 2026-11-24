import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseOptionList, parsePollDuration, parsePrefixPoll } from '../src/features/poll/args.js';
import { poll } from '../src/features/poll/config.js';

const word = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/);

describe('fuzz: poll args', () => {
  it('never throws on arbitrary prefix input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(() => parsePrefixPoll(text)).not.toThrow();
      }),
    );
  });

  it('never throws on arbitrary options or durations', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(() => parseOptionList(a)).not.toThrow();
        expect(() => parsePollDuration(b)).not.toThrow();
      }),
    );
  });

  it('round-trips a quoted question with distinct options', () => {
    fc.assert(
      fc.property(
        word,
        fc.uniqueArray(word, { minLength: 2, maxLength: 9, selector: (w) => w.toLowerCase() }),
        fc.boolean(),
        (question, options, anonymous) => {
          const text = `"${question}" | ${options.join(' | ')}${anonymous ? ' --anon' : ''}`;
          const result = parsePrefixPoll(text);
          expect(result).toEqual({
            ok: true,
            value: { question, options, anonymous, durationMs: poll.defaultDurationMs },
          });
        },
      ),
    );
  });

  it('rejects any duplicate option regardless of case', () => {
    fc.assert(
      fc.property(word, word, (a, b) => {
        expect(parseOptionList(`${a} | ${b} | ${a.toUpperCase()}`).ok).toBe(false);
      }),
    );
  });

  it('accepts exactly the in-range durations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20_000 }),
        fc.constantFrom('m', 'h', 'd'),
        (n, unit) => {
          const ms = n * { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as 'm' | 'h' | 'd'];
          const result = parsePollDuration(`${n}${unit}`);
          const inRange = ms >= poll.minDurationMs && ms <= poll.maxDurationMs;
          expect(result.ok).toBe(inRange);
          if (result.ok) expect(result.value).toBe(ms);
        },
      ),
    );
  });

  it('never leaves a raw @ in parsed text', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = parsePrefixPoll(`${text} @everyone`);
        if (!result.ok) return;
        const joined = [result.value.question, ...(result.value.options ?? [])].join('\n');
        expect(joined).not.toMatch(/@(?!​)/);
      }),
    );
  });
});

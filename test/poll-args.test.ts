import { describe, expect, it } from 'vitest';
import {
  escapeMentions,
  parseOptionList,
  parsePollDuration,
  parsePollInput,
  parsePrefixPoll,
} from '../src/features/poll/args.js';
import { poll } from '../src/features/poll/config.js';

const ok = <T>(result: { ok: boolean; value?: T; error?: string }): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value as T;
};

describe('parsePollDuration', () => {
  it('defaults to 24 hours', () => {
    expect(ok(parsePollDuration(undefined))).toBe(24 * 3_600_000);
    expect(ok(parsePollDuration(''))).toBe(24 * 3_600_000);
  });

  it('parses minutes, hours and days', () => {
    expect(ok(parsePollDuration('30m'))).toBe(30 * 60_000);
    expect(ok(parsePollDuration('2h'))).toBe(2 * 3_600_000);
    expect(ok(parsePollDuration('3d'))).toBe(3 * 86_400_000);
    expect(ok(parsePollDuration('1 minute'))).toBe(60_000);
    expect(ok(parsePollDuration('7d'))).toBe(poll.maxDurationMs);
  });

  it('enforces the bounds and rejects junk', () => {
    for (const bad of ['0m', '8d', '169h', '10081m', 'abc', '5', 'h', '-2h', '1.5h', '2x']) {
      expect(parsePollDuration(bad).ok, bad).toBe(false);
    }
  });
});

describe('parseOptionList', () => {
  it('splits and trims', () => {
    expect(ok(parseOptionList(' Tacos | Pizza |  Sushi '))).toEqual(['Tacos', 'Pizza', 'Sushi']);
  });

  it('needs 2 to 9 options', () => {
    expect(parseOptionList('one').ok).toBe(false);
    expect(parseOptionList('a|b|c|d|e|f|g|h|i').ok).toBe(true);
    expect(parseOptionList('a|b|c|d|e|f|g|h|i|j').ok).toBe(false);
  });

  it('rejects empty, long and duplicate options (case-insensitively)', () => {
    expect(parseOptionList('a||b').ok).toBe(false);
    expect(parseOptionList(`a|${'x'.repeat(81)}`).ok).toBe(false);
    expect(parseOptionList(`a|${'x'.repeat(80)}`).ok).toBe(true);
    expect(parseOptionList('Tacos | tacos').ok).toBe(false);
  });

  it('escapes mentions', () => {
    const [first] = ok(parseOptionList('@everyone | <@123>'));
    expect(first).not.toContain('@everyone');
    expect(escapeMentions('@everyone')).toBe('@​everyone');
  });
});

describe('parsePollInput', () => {
  it('builds a yes/no poll by default', () => {
    expect(ok(parsePollInput({ question: ' Pizza? ' }))).toEqual({
      question: 'Pizza?',
      options: undefined,
      anonymous: false,
      durationMs: poll.defaultDurationMs,
    });
  });

  it('rejects empty and over-long questions', () => {
    expect(parsePollInput({ question: '   ' }).ok).toBe(false);
    expect(parsePollInput({ question: 'x'.repeat(201) }).ok).toBe(false);
    expect(parsePollInput({ question: 'x'.repeat(200) }).ok).toBe(true);
  });

  it('reports bad options and durations', () => {
    expect(parsePollInput({ question: 'q', options: 'only' }).ok).toBe(false);
    expect(parsePollInput({ question: 'q', duration: '9d' }).ok).toBe(false);
  });
});

describe('parsePrefixPoll', () => {
  it('parses a plain question as yes/no', () => {
    const value = ok(parsePrefixPoll('Is it Friday yet?'));
    expect(value).toMatchObject({ question: 'Is it Friday yet?', options: undefined });
  });

  it('parses a quoted question with options', () => {
    const value = ok(parsePrefixPoll('"Dinner?" | Tacos | Pizza'));
    expect(value).toMatchObject({ question: 'Dinner?', options: ['Tacos', 'Pizza'] });
  });

  it('parses a quoted question alone as yes/no and accepts curly quotes', () => {
    expect(ok(parsePrefixPoll('"Dinner?"')).options).toBeUndefined();
    expect(ok(parsePrefixPoll('“Dinner?” | a | b')).options).toEqual(['a', 'b']);
  });

  it('reads trailing flags in any order', () => {
    const value = ok(parsePrefixPoll('"Dinner?" | a | b --for 2h --anon'));
    expect(value).toMatchObject({ anonymous: true, durationMs: 2 * 3_600_000 });
    expect(ok(parsePrefixPoll('Open? --anon --for 30m'))).toMatchObject({
      question: 'Open?',
      anonymous: true,
      durationMs: 30 * 60_000,
    });
  });

  it('rejects malformed input', () => {
    for (const bad of [
      '',
      '   ',
      '"unclosed | a | b',
      '"q" a | b',
      'q | a | b',
      'q --for',
      'q --for 99d',
      'q --for 1h --for 2h',
      '"q" | a | a',
      '"q" | only',
    ]) {
      expect(parsePrefixPoll(bad).ok, bad).toBe(false);
    }
  });

  it('does not let a question ping anyone', () => {
    const { question } = ok(parsePrefixPoll('@everyone <@123> ok?'));
    expect(question).not.toContain('@everyone');
    expect(question).not.toContain('<@1');
  });
});

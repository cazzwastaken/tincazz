import { describe, expect, it } from 'vitest';
import {
  cleanMessageText,
  limits,
  type MentionNames,
  noMentionNames,
  runsText,
  stripMarkdown,
} from '../src/features/imaging/index.js';

const names: MentionNames = {
  users: new Map([['10', 'cazz']]),
  roles: new Map([['20', 'Mods']]),
  channels: new Map([['30', 'general']]),
};

const text = (raw: string, n: MentionNames = noMentionNames) => runsText(cleanMessageText(raw, n));

describe('stripMarkdown', () => {
  it.each([
    ['**bold** and __under__', 'bold and under'],
    ['*it* and _it_', 'it and it'],
    ['***both***', 'both'],
    ['~~gone~~ ||secret||', 'gone secret'],
    ['`code` here', 'code here'],
    ['```js\nconst a = 1;\n```', 'const a = 1;\n'],
    ['> quoted\n# Big\n-# small', 'quoted\nBig\nsmall'],
    ['[label](https://example.com/x)', 'label'],
    ['snake_case_name stays', 'snake_case_name stays'],
    ['2 * 3 * 4', '2 * 3 * 4'],
  ])('%j -> %j', (input, expected) => {
    expect(stripMarkdown(input)).toBe(expected);
  });
});

describe('cleanMessageText', () => {
  it('resolves mentions into mention runs', () => {
    expect(cleanMessageText('hi <@10> and <@&20> in <#30>!', names)).toEqual([
      { text: 'hi ' },
      { text: '@cazz', mention: true },
      { text: ' and ' },
      { text: '@Mods', mention: true },
      { text: ' in ' },
      { text: '#general', mention: true },
      { text: '!' },
    ]);
  });

  it('names unknown mentions and styles @everyone', () => {
    expect(cleanMessageText('<@99> @everyone', noMentionNames)).toEqual([
      { text: '@unknown-user', mention: true },
      { text: ' ' },
      { text: '@everyone', mention: true },
    ]);
  });

  it('turns custom emoji into :name:', () => {
    expect(text('nice <:pog:123> <a:dance_cat:456>')).toBe('nice :pog: :dance_cat:');
  });

  it('keeps line breaks and blank lines, trims the ends', () => {
    expect(text('\n\n  one\r\n\ntwo\t\n\n')).toBe('one\n\ntwo');
  });

  it('drops invisible characters', () => {
    expect(text('a​b\u0007c')).toBe('abc');
  });

  it('caps the lines with an ellipsis', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = text(raw);
    expect(out.split('\n')).toHaveLength(limits.messageLines);
    expect(out.endsWith('…')).toBe(true);
  });

  it('caps the characters with an ellipsis', () => {
    const out = text('a'.repeat(5000));
    expect([...out]).toHaveLength(limits.messageChars + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns no runs when nothing is left', () => {
    expect(cleanMessageText('  ** ~~ \n ', noMentionNames)).toEqual([]);
  });

  it('keeps a mention name free of line breaks', () => {
    const odd: MentionNames = { ...noMentionNames, users: new Map([['1', 'a\nb​']]) };
    expect(cleanMessageText('<@1>', odd)).toEqual([{ text: '@a b', mention: true }]);
  });
});

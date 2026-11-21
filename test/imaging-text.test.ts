import { describe, expect, it } from 'vitest';
import {
  escapeMarkup,
  ImagingError,
  messages,
  noMentionNames,
  sanitizeCaption,
} from '../src/features/imaging/index.js';

const names = {
  users: new Map([['1', 'bob']]),
  roles: new Map([['2', 'mods']]),
  channels: new Map([['3', 'general']]),
};

describe('sanitizeCaption', () => {
  it('blocks out spoilers, mentions inside them included', () => {
    expect(sanitizeCaption('a ||top secret|| b', names)).toBe('a ███ ██████ b');
    expect(sanitizeCaption('||<@1>||', names)).toBe('████');
  });

  it('replaces mentions with names', () => {
    expect(sanitizeCaption('hi <@1>', names)).toBe('hi @bob');
    expect(sanitizeCaption('hi <@!1>', names)).toBe('hi @bob');
    expect(sanitizeCaption('<@&2>', names)).toBe('@mods');
    expect(sanitizeCaption('<#3>', names)).toBe('#general');
  });

  it('falls back for unknown mentions', () => {
    expect(sanitizeCaption('<@1>', noMentionNames)).toBe('@unknown-user');
    expect(sanitizeCaption('<@&2>', noMentionNames)).toBe('@unknown-role');
    expect(sanitizeCaption('<#3>', noMentionNames)).toBe('#unknown-channel');
  });

  it('reduces custom emoji to their name', () => {
    expect(sanitizeCaption('<a:party:123>', noMentionNames)).toBe(':party:');
    expect(sanitizeCaption('<:kek:9>', noMentionNames)).toBe(':kek:');
  });

  it('strips invisible format characters but keeps ZWJ sequences', () => {
    expect(sanitizeCaption('a\u{200B}b', noMentionNames)).toBe('ab');
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    expect(sanitizeCaption(family, noMentionNames)).toBe(family);
    expect(sanitizeCaption('\u{1F602}', noMentionNames)).toBe('\u{1F602}');
  });

  it('keeps ZWNJ and the tag characters of subdivision flags', () => {
    const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
    expect(sanitizeCaption(england, noMentionNames)).toBe(england);
    const persian = '\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}';
    expect(sanitizeCaption(persian, noMentionNames)).toBe(persian);
  });

  it('strips bidi controls, soft hyphens, word joiners and byte order marks', () => {
    expect(sanitizeCaption('a\u{202E}b', noMentionNames)).toBe('ab');
    for (const c of [
      '\u{00AD}',
      '\u{200E}',
      '\u{200F}',
      '\u{202A}',
      '\u{2060}',
      '\u{2066}',
      '\u{2069}',
      '\u{FEFF}',
    ]) {
      expect(sanitizeCaption(`a${c}b`, noMentionNames)).toBe('ab');
    }
  });

  it('strips invisibles before reading mentions, so the result is stable', () => {
    const once = sanitizeCaption('<\u{200B}@1>', names);
    expect(once).toBe('@bob');
    expect(sanitizeCaption(once, names)).toBe(once);
    expect(sanitizeCaption('<:\u{200B}kek:9>', noMentionNames)).toBe(':kek:');
  });

  it('strips invisibles from looked up names', () => {
    const sneaky = { ...names, users: new Map([['1', 'b\u{202E}ob']]) };
    expect(sanitizeCaption('<@1>', sneaky)).toBe('@bob');
  });

  it('normalises whitespace and lines', () => {
    expect(sanitizeCaption('a   b', noMentionNames)).toBe('a b');
    expect(sanitizeCaption('a\r\n\r\n  b  ', noMentionNames)).toBe('a\nb');
    const seven = Array.from({ length: 7 }, (_, i) => `l${i}`).join('\n');
    expect(sanitizeCaption(seven, noMentionNames).split('\n')).toHaveLength(5);
  });

  it('treats every unicode line break as a new line, so all count towards the cap', () => {
    for (const sep of ['\r\n', '\r', '\u{0085}', '\u{2028}', '\u{2029}']) {
      expect(sanitizeCaption(`a${sep}b`, noMentionNames)).toBe('a\nb');
      const seven = Array.from({ length: 7 }, (_, i) => `l${i}`).join(sep);
      expect(sanitizeCaption(seven, noMentionNames)).toBe('l0\nl1\nl2\nl3\nl4');
    }
  });

  it('throws when nothing is left', () => {
    expect(() => sanitizeCaption('\u{200B}\u{200B}', noMentionNames)).toThrow(ImagingError);
    expect(() => sanitizeCaption('  \n ', noMentionNames)).toThrow(messages.emptyCaption);
  });
});

describe('escapeMarkup', () => {
  it('escapes ampersand first, then angle brackets', () => {
    expect(escapeMarkup('<span size="999999">&')).toBe('&lt;span size="999999"&gt;&amp;');
  });
});

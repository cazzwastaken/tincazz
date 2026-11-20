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
    expect(sanitizeCaption('a​b', noMentionNames)).toBe('ab');
    expect(sanitizeCaption('👨‍👩‍👧', noMentionNames)).toBe('👨‍👩‍👧');
    expect(sanitizeCaption('😂', noMentionNames)).toBe('😂');
  });

  it('normalises whitespace and lines', () => {
    expect(sanitizeCaption('a   b', noMentionNames)).toBe('a b');
    expect(sanitizeCaption('a\r\n\r\n  b  ', noMentionNames)).toBe('a\nb');
    const seven = Array.from({ length: 7 }, (_, i) => `l${i}`).join('\n');
    expect(sanitizeCaption(seven, noMentionNames).split('\n')).toHaveLength(5);
  });

  it('throws when nothing is left', () => {
    expect(() => sanitizeCaption('​​', noMentionNames)).toThrow(ImagingError);
    expect(() => sanitizeCaption('  \n ', noMentionNames)).toThrow(messages.emptyCaption);
  });
});

describe('escapeMarkup', () => {
  it('escapes ampersand first, then angle brackets', () => {
    expect(escapeMarkup('<span size="999999">&')).toBe('&lt;span size="999999"&gt;&amp;');
  });
});

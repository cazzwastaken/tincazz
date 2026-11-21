import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cleanMessageText,
  cleanName,
  escapeMarkup,
  formatTimestamp,
  limits,
  type MentionNames,
  messageLinkUrl,
  messageMarkup,
  messageSource,
  nameColor,
  parseMessageLink,
  pickSource,
  removeUrl,
  runsText,
} from '../src/features/imaging/index.js';

const names: MentionNames = {
  users: new Map([
    ['1', 'cazz'],
    ['2', '<b>&amp;\n\u{E000}'],
  ]),
  roles: new Map([['3', 'Mods']]),
  channels: new Map([['4', 'general']]),
};

const fragment = fc.oneof(
  fc.string(),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '<@1>',
    '<@!2>',
    '<@&3>',
    '<#4>',
    '<@9>',
    '<:pog:5>',
    '<a:x_y:6>',
    '**',
    '__',
    '*',
    '_',
    '~~',
    '||',
    '`',
    '```js\n',
    '> ',
    '# ',
    '-# ',
    '@everyone',
    '\n',
    '\r\n',
    '\t',
    '\u{200B}',
    '\u{E000}',
    '\u{E001}',
    '&',
    '<',
    '>',
    'https://cdn.discordapp.com/a.png',
    'https://tenor.com/view/x-1',
    '[a](https://example.com)',
  ),
);
const texts = fc.array(fragment, { maxLength: 40 }).map((parts) => parts.join(''));
const bigTexts = fc.array(fragment, { maxLength: 400 }).map((parts) => parts.join(''));

describe('cleanMessageText properties', () => {
  it('never throws and stays within the caps', () => {
    fc.assert(
      fc.property(fc.oneof(texts, bigTexts), (raw) => {
        const runs = cleanMessageText(raw, names);
        const out = runsText(runs);
        expect(out.split('\n').length).toBeLessThanOrEqual(limits.messageLines);
        expect([...out].length).toBeLessThanOrEqual(limits.messageChars + 1);
        expect(/[^\P{Cc}\n]/u.test(out)).toBe(false);
        expect(/[\r\u{0085}\u{2028}\u{2029}\u{E000}\u{E001}]/u.test(out)).toBe(false);
        expect(out).toBe(out.trim() === '' ? '' : out);
        for (const run of runs) expect(run.text.length).toBeGreaterThan(0);
        if (runs.length === 0) expect(out).toBe('');
      }),
    );
  });

  it('leaves no raw markup once escaped, the way the renderer escapes it', () => {
    fc.assert(
      fc.property(texts, (raw) => {
        for (const run of cleanMessageText(raw, names)) {
          const escaped = escapeMarkup(run.text);
          expect(escaped).not.toMatch(/[<>]/);
          expect(escaped.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
        }
      }),
    );
  });

  it('escapes every user value in the markup', () => {
    fc.assert(
      fc.property(fc.string(), texts, (name, raw) => {
        const markup = messageMarkup({
          name: cleanName(name),
          color: nameColor(name),
          timestamp: formatTimestamp(0),
          runs: cleanMessageText(raw, names),
        });
        // Only our own span tags remain once the escaped text is taken out.
        const tags = markup.match(/<[^>]*>/g) ?? [];
        for (const tag of tags) expect(tag).toMatch(/^<\/?span\b/);
      }),
    );
  });
});

describe('cleanName and nameColor properties', () => {
  it('cleanName is one non-empty line of at most 33 characters', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        const out = cleanName(name);
        expect(out.length).toBeGreaterThan(0);
        expect(out).not.toMatch(/[\n\r]/);
        expect([...out].length).toBeLessThanOrEqual(33);
      }),
    );
  });

  it('nameColor is always a lower case #rrggbb', () => {
    fc.assert(
      fc.property(fc.option(fc.string()), (hex) => {
        expect(nameColor(hex)).toMatch(/^#[0-9a-f]{6}$/);
      }),
    );
  });
});

describe('formatTimestamp properties', () => {
  it('always has the MM/DD/YYYY h:mm AM shape', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        expect(formatTimestamp(ms)).toMatch(/^\d{2}\/\d{2}\/\d{4} (1[0-2]|[1-9]):[0-5]\d (AM|PM)$/);
      }),
    );
  });
});

const snowflake = fc.bigInt({ min: 10n ** 16n, max: 10n ** 19n - 1n }).map(String);

describe('parseMessageLink properties', () => {
  it('never throws', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (raw) => {
        parseMessageLink(raw);
      }),
    );
  });

  it('round trips links on every host', () => {
    const hosts = fc.constantFrom(
      'discord.com',
      'ptb.discord.com',
      'canary.discord.com',
      'discordapp.com',
      'ptb.discordapp.com',
      'canary.discordapp.com',
    );
    fc.assert(
      fc.property(hosts, snowflake, snowflake, snowflake, (host, g, c, m) => {
        const link = messageLinkUrl(g, c, m).replace('discord.com', host);
        expect(parseMessageLink(link)).toEqual({ guildId: g, channelId: c, messageId: m });
        expect(parseMessageLink(`<${link}>`)).toEqual({ guildId: g, channelId: c, messageId: m });
      }),
    );
  });

  it('round trips bare IDs and channel-message pairs', () => {
    fc.assert(
      fc.property(snowflake, snowflake, (c, m) => {
        expect(parseMessageLink(m)).toEqual({ guildId: null, channelId: null, messageId: m });
        expect(parseMessageLink(`${c}-${m}`)).toEqual({
          guildId: null,
          channelId: c,
          messageId: m,
        });
      }),
    );
  });

  it('only gives IDs made of digits', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const link = parseMessageLink(raw);
        if (!link) return;
        for (const id of [link.guildId, link.channelId, link.messageId]) {
          if (id !== null) expect(id).toMatch(/^\d{17,20}$/);
        }
      }),
    );
  });
});

describe('messageSource and removeUrl properties', () => {
  const attachment = fc.record({
    url: fc.constantFrom('https://cdn.discordapp.com/a.png', 'https://evil.com/a.png', 'x'),
    contentType: fc.constantFrom(null, 'image/png', 'video/mp4', 'text/plain'),
    spoiler: fc.boolean(),
  });
  it('never throws, and a screenshot always has text', () => {
    fc.assert(
      fc.property(texts, fc.array(attachment, { maxLength: 3 }), (content, attachments) => {
        const source = messageSource({ content, attachments, embeds: [], stickers: [] });
        if (source.kind === 'screenshot') {
          expect(cleanMessageText(source.text, names).length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('never uses a spoiler attachment as a bare image', () => {
    fc.assert(
      fc.property(texts, fc.array(attachment, { maxLength: 3 }), (content, attachments) => {
        const reply = { content, attachments, embeds: [], stickers: [] };
        // the attachment the picker takes: the first allowed image (or untyped) one
        const first = attachments.find(
          (a) =>
            a.url === 'https://cdn.discordapp.com/a.png' &&
            (a.contentType === null || a.contentType.startsWith('image/')),
        );
        if (!first?.spoiler) return;
        expect(messageSource(reply).kind).not.toBe('image');
        expect(pickSource({ reply }).ok).toBe(false);
      }),
    );
  });

  it('removeUrl never throws and never adds text', () => {
    fc.assert(
      fc.property(texts, fc.string(), (text, target) => {
        expect(removeUrl(text, target).length).toBeLessThanOrEqual(text.length);
      }),
    );
  });
});

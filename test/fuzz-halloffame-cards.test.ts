import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type HallCardInput,
  hallAttachmentNames,
  hallCard,
  hallComponentBudget,
  hallRenderHash,
  hallTextBudget,
  hallUploadName,
  inlineText,
  type MessageBody,
} from '../src/features/halloffame/index.js';
import {
  allText,
  buttons,
  componentCount,
  galleryUrls,
  referencedAttachments,
  textLength,
  texts,
} from './support/hall-card.js';

const piece = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.constantFrom(
    '😀',
    '<@123456789012345678>',
    '<#99>',
    '<:wave:123456789>',
    '```',
    '```js\n',
    '\n',
    '\r\n',
    '> ',
    '>>> ',
    '# ',
    '-# ',
    '||',
    '**',
    '__',
    '[a](https://evil.example)',
    '@everyone',
    String.fromCodePoint(0x200b),
    String.fromCodePoint(0x202e),
    '<t:1700000000:R>',
  ),
);
const text = fc.array(piece, { maxLength: 60 }).map((parts) => parts.join(''));
const bigText = fc.oneof(
  text,
  fc
    .integer({ min: 0, max: 8000 })
    .chain((n) => fc.constantFrom('x', '\n', '😀', '> ').map((c) => c.repeat(n))),
);

const imageArb = fc.record({
  id: fc.string({ maxLength: 8 }),
  name: fc.oneof(text, fc.constantFrom('a.png', 'b.JPG', 'SPOILER_c.gif', 'd d.webp')),
  url: fc.constant('https://cdn.discordapp.com/attachments/1/2/a.png'),
  size: fc.nat({ max: 1_000_000 }),
  spoiler: fc.boolean(),
});

const url = fc.constantFrom(
  'https://cdn.discordapp.com/stickers/1.png',
  'https://media.tenor.com/a.gif',
  'https://evil.example/x.png',
  'http://media.tenor.com/a.gif',
  'not a url',
  '',
);

const body: fc.Arbitrary<MessageBody> = fc.record({
  forwarded: fc.boolean(),
  text: bigText,
  note: fc.option(text, { nil: undefined }),
  images: fc.array(imageArb, { maxLength: 8 }),
  stickers: fc.array(fc.record({ name: text, url: fc.option(url, { nil: undefined }) }), {
    maxLength: 12,
  }),
  files: fc.array(text, { maxLength: 12 }),
  moreFiles: fc.nat({ max: 100_000 }),
  embedMedia: fc.array(fc.record({ url, gif: fc.boolean(), spoiler: fc.boolean() }), {
    maxLength: 8,
  }),
});

const input: fc.Arbitrary<HallCardInput> = body.chain((b) =>
  fc.record({
    author: fc.record({
      id: fc.constant('1'),
      displayName: text,
      username: text,
      avatarUrl: fc.oneof(url, fc.constant('https://cdn.discordapp.com/avatars/1/a.png')),
    }),
    source: fc.record({
      guildId: text,
      channelId: text,
      messageId: text,
      channelName: fc.option(text, { nil: undefined }),
      createdAt: fc.oneof(fc.nat(), fc.constant(Number.NaN), fc.constant(Number.POSITIVE_INFINITY)),
    }),
    body: fc.constant(b),
    reply: fc.option(fc.record({ authorName: text, snippet: text }), { nil: undefined }),
    peak: fc.oneof(fc.integer({ min: -5, max: 10_000 }), fc.constant(Number.NaN)),
    threshold: fc.integer({ min: -2, max: 60 }),
    breakdown: fc.array(
      fc.record({
        emoji: fc.oneof(text, fc.constantFrom('🔥', '<:x:1>')),
        count: fc.integer({ min: -3, max: 100_000 }),
      }),
      { maxLength: 30 },
    ),
    uploaded: fc
      .subarray(b.images.map((image, i) => hallUploadName(image, i)))
      .chain((names) => fc.shuffledSubarray([...names, 'stray.png'])),
  }),
);

describe('hallCard fuzz', () => {
  it('never throws and stays within the text and component budgets', () => {
    fc.assert(
      fc.property(input, (value) => {
        const card = hallCard(value);
        expect(componentCount(card)).toBeLessThan(hallComponentBudget);
        expect(textLength(card)).toBeLessThanOrEqual(hallTextBudget);
        for (const content of texts(card)) {
          expect(content.length).toBeGreaterThan(0);
          expect(content.length).toBeLessThanOrEqual(4000);
        }
        for (const button of buttons(card)) {
          expect(button.label.length).toBeGreaterThan(0);
          expect(button.label.length).toBeLessThanOrEqual(80);
          expect(button.url.startsWith('https://discord.com/channels/')).toBe(true);
        }
        expect(galleryUrls(card).length).toBeLessThanOrEqual(4);
        expect(() => card.toJSON()).not.toThrow();
        expect(allText(card).toLowerCase()).not.toContain('reaction');
      }),
      { numRuns: 300 },
    );
  });

  it('references exactly the attachments the helper lists', () => {
    fc.assert(
      fc.property(input, (value) => {
        const card = hallCard(value);
        expect(referencedAttachments(card)).toEqual(hallAttachmentNames(value));
        const names = new Set(hallAttachmentNames(value));
        for (const name of names) expect(value.uploaded).toContain(name);
        expect(names.size).toBe(hallAttachmentNames(value).length);
      }),
      { numRuns: 300 },
    );
  });

  it('puts author text on one line that cannot start a heading or mention', () => {
    fc.assert(
      fc.property(text, text, (displayName, username) => {
        const value: HallCardInput = {
          author: { id: '1', displayName, username, avatarUrl: 'https://cdn.discordapp.com/a.png' },
          source: { guildId: '1', channelId: '2', messageId: '3', createdAt: 0 },
          body: {
            forwarded: false,
            text: 'x',
            note: undefined,
            images: [],
            stickers: [],
            files: [],
            moreFiles: 0,
            embedMedia: [],
          },
          peak: 5,
          threshold: 5,
          breakdown: [],
          uploaded: [],
        };
        const [header, name, details] = texts(hallCard(value));
        expect(header).toBe('-# 🏛️ HALL OF FAME');
        expect(name).toMatch(/^\*\*[^\n]+\*\*$/u);
        expect(details).toMatch(/^-# @[^\n]* · in <#2> · <t:0:R>$/u);
        expect(name).not.toMatch(/<[@#:a]/u);
        expect(name?.includes('@everyone')).toBe(false);
        expect(name?.includes('@here')).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('inlineText is one bounded line without mention brackets', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 60 }), (value, max) => {
        const result = inlineText(value, max);
        expect(result).not.toMatch(/[\r\n<>]/u);
        expect(result.length).toBeLessThanOrEqual(max * 2 + 2);
      }),
      { numRuns: 300 },
    );
  });

  it('hashes equal input equally and never throws', () => {
    fc.assert(
      fc.property(input, (value) => {
        expect(hallRenderHash(value)).toBe(hallRenderHash(structuredClone(value)));
      }),
      { numRuns: 100 },
    );
  });
});

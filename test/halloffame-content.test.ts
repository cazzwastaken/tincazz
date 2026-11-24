import { StickerFormatType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  bodyHashParts,
  bodyIsEmpty,
  canonicalJson,
  classifySticker,
  describeMessage,
  hallOfFame,
  type MessageFacts,
  pickEmbedMedia,
  planAttachments,
  pollNote,
  quoteExcerpt,
  quoteText,
  renderHash,
  replySnippet,
  safeFileName,
  stableUrl,
  truncateText,
} from '../src/features/halloffame/index.js';

const attachment = (name: string, size = 1000, contentType: string | null = 'image/png') => ({
  id: name,
  name,
  url: `https://cdn.discordapp.com/attachments/1/2/${name}?ex=1&is=2&hm=3`,
  size,
  contentType,
});

const message = (over: Partial<MessageFacts> = {}): MessageFacts => ({
  content: '',
  attachments: [],
  stickers: [],
  embeds: [],
  snapshots: [],
  ...over,
});

describe('truncateText', () => {
  it('returns short text untouched', () => {
    expect(truncateText('hello', 10)).toBe('hello');
    expect(truncateText('hello', 5)).toBe('hello');
  });

  it('cuts with an ellipsis within the limit', () => {
    expect(truncateText('abcdefghij', 6)).toBe('abcde…');
    expect(truncateText('abcdefghij', 1)).toBe('…');
    expect(truncateText('abc', 0)).toBe('');
  });

  it('drops trailing whitespace before the ellipsis', () => {
    expect(truncateText('hello     world', 8)).toBe('hello…');
  });

  it('never splits a surrogate pair', () => {
    expect(truncateText('ab😀cdef', 4)).toBe('ab…');
    expect(truncateText('ab😀cdef', 5)).toBe('ab😀…');
  });

  it('never splits a mention or custom emoji', () => {
    const mention = '<@123456789012345678>';
    expect(truncateText(`hi ${mention} there`, 10)).toBe('hi…');
    expect(truncateText(`hi ${mention} there`, 26)).toBe(`hi ${mention}…`);
    const emoji = '<:wave:123456789012345678>';
    expect(truncateText(`yo ${emoji} x`, 12)).toBe('yo…');
    expect(truncateText(`<a:dance:123456789012345678> ${'x'.repeat(40)}`, 10)).toBe('…');
  });

  it('closes a code fence the cut left open', () => {
    const text = `intro\n\`\`\`js\n${'const a = 1;\n'.repeat(20)}\`\`\``;
    const out = truncateText(text, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…\n```')).toBe(true);
    expect((out.match(/```/gu) ?? []).length % 2).toBe(0);
  });

  it('leaves a closed fence alone', () => {
    const text = `\`\`\`\ncode\n\`\`\`\n${'x'.repeat(100)}`;
    const out = truncateText(text, 50);
    expect(out.endsWith('…')).toBe(true);
    expect((out.match(/```/gu) ?? []).length).toBe(2);
  });

  it('drops an opening fence that no longer fits instead of leaving it open', () => {
    const out = truncateText(`\`\`\`${'x'.repeat(50)}`, 5);
    expect(out).toBe('…');
  });
});

describe('quoting', () => {
  it('prefixes every line, blank lines included', () => {
    expect(quoteText('a\n\nb')).toBe('> a\n> ​\n> b');
    expect(quoteText('a\r\nb')).toBe('> a\n> b');
    expect(quoteText('')).toBe('');
  });

  it('keeps a code fence inside the quote line by line', () => {
    expect(quoteText('```js\nlet a\n```')).toBe('> ```js\n> let a\n> ```');
  });

  it('keeps the quoted excerpt within its own limit', () => {
    const out = quoteExcerpt('\n'.repeat(5000), 1500, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out.startsWith('> ')).toBe(true);
  });

  it('quotes a normal message whole', () => {
    expect(quoteExcerpt('hello\nworld')).toBe('> hello\n> world');
    expect(quoteExcerpt('')).toBe('');
  });
});

describe('replySnippet', () => {
  it('flattens whitespace and truncates', () => {
    expect(replySnippet('hello\n\n  world')).toBe('hello world');
    expect(replySnippet('x'.repeat(200)).length).toBe(hallOfFame.maxReplySnippetLength);
  });

  it('removes code fences and falls back for media only', () => {
    expect(replySnippet('```js\nlet a\n```')).toBe('js let a');
    expect(replySnippet('', true)).toBe('📎 attachment');
    expect(replySnippet('  ', false)).toBe('');
  });
});

describe('attachments', () => {
  it('re-uploads images and lists other files by name', () => {
    const plan = planAttachments([
      attachment('a.png'),
      attachment('SPOILER_b.jpg', 10, 'image/jpeg'),
      attachment('c.zip', 10, 'application/zip'),
      attachment('d.mp4', 10, 'video/mp4'),
    ]);
    expect(plan.images.map((i) => [i.name, i.spoiler])).toEqual([
      ['a.png', false],
      ['SPOILER_b.jpg', true],
    ]);
    expect(plan.files).toEqual(['c.zip', 'd.mp4']);
    expect(plan.moreFiles).toBe(0);
  });

  it('falls back to the extension without a content type', () => {
    expect(planAttachments([attachment('x.WEBP', 1, null)]).images).toHaveLength(1);
    expect(planAttachments([attachment('x.svg', 1, 'image/svg+xml')]).images).toHaveLength(0);
    expect(planAttachments([attachment('x.txt', 1, null)]).files).toEqual(['x.txt']);
  });

  it('caps the count, per image and total size, listing the overflow by name', () => {
    const caps = { ...hallOfFame, maxImages: 2, maxImageBytes: 100, maxImageBytesTotal: 150 };
    const plan = planAttachments(
      [
        attachment('a.png', 90),
        attachment('b.png', 90),
        attachment('c.png', 50),
        attachment('d.png', 200),
      ],
      caps,
    );
    expect(plan.images.map((i) => i.name)).toEqual(['a.png', 'c.png']);
    expect(plan.files).toEqual(['b.png', 'd.png']);
  });

  it('caps the listed names and counts the rest', () => {
    const files = Array.from({ length: 8 }, (_, i) =>
      attachment(`f${i}.zip`, 1, 'application/zip'),
    );
    const plan = planAttachments(files);
    expect(plan.files).toHaveLength(hallOfFame.maxAttachmentNames);
    expect(plan.moreFiles).toBe(3);
  });

  it('prints file names safely', () => {
    expect(safeFileName('a`b\nc.zip')).toBe('ab c.zip');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('x'.repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe('stickers', () => {
  it('links PNG, APNG and GIF stickers and names Lottie ones', () => {
    expect(classifySticker({ id: '1', name: 'a', format: StickerFormatType.PNG }).url).toBe(
      'https://cdn.discordapp.com/stickers/1.png',
    );
    expect(classifySticker({ id: '1', name: 'a', format: StickerFormatType.APNG }).url).toBe(
      'https://cdn.discordapp.com/stickers/1.png',
    );
    expect(classifySticker({ id: '1', name: 'a', format: StickerFormatType.GIF }).url).toBe(
      'https://cdn.discordapp.com/stickers/1.gif',
    );
    expect(classifySticker({ id: '1', name: 'a', format: StickerFormatType.Lottie })).toEqual({
      name: 'a',
      url: undefined,
    });
  });
});

describe('embed media', () => {
  it('takes allowlisted images and GIF thumbnails only', () => {
    const picked = pickEmbedMedia(
      [
        {
          type: 'image',
          image: {
            url: 'https://i.imgur.com/x.png',
            proxyUrl: 'https://images-ext-1.discordapp.net/external/h/x.png',
          },
        },
        { type: 'gifv', thumbnail: { url: 'https://media.tenor.com/abc/cat.gif' } },
        { type: 'image', image: { url: 'https://evil.example/x.png' } },
        { type: 'link', thumbnail: { url: 'https://media.tenor.com/ignored.png' } },
        { type: 'image', image: { url: 'http://media.tenor.com/insecure.png' } },
      ],
      '',
      4,
    );
    expect(picked.map((p) => p.url)).toEqual([
      'https://images-ext-1.discordapp.net/external/h/x.png',
      'https://media.tenor.com/abc/cat.gif',
    ]);
    expect(picked.map((p) => p.gif)).toEqual([false, true]);
  });

  it('respects the limit and deduplicates', () => {
    const embed = { type: 'image', image: { url: 'https://media.giphy.com/a.gif?x=1' } };
    expect(
      pickEmbedMedia(
        [embed, { ...embed, image: { url: 'https://media.giphy.com/a.gif?x=2' } }],
        '',
        4,
      ),
    ).toHaveLength(1);
    expect(pickEmbedMedia([embed], '', 0)).toHaveLength(0);
  });

  it('keeps a spoilered link a spoiler', () => {
    const url = 'https://media.giphy.com/a.gif';
    const [media] = pickEmbedMedia([{ type: 'image', url, image: { url } }], `look ||${url}||`, 1);
    expect(media?.spoiler).toBe(true);
    const [plain] = pickEmbedMedia([{ type: 'image', url, image: { url } }], `look ${url}`, 1);
    expect(plain?.spoiler).toBe(false);
  });
});

describe('describeMessage', () => {
  it('handles an empty message', () => {
    const body = describeMessage(message());
    expect(bodyIsEmpty(body)).toBe(true);
  });

  it('handles an attachment only message', () => {
    const body = describeMessage(message({ attachments: [attachment('a.png')] }));
    expect(body.images).toHaveLength(1);
    expect(body.text).toBe('');
    expect(bodyIsEmpty(body)).toBe(false);
  });

  it('handles a sticker only message, including Lottie', () => {
    const body = describeMessage(
      message({
        stickers: [
          { id: '1', name: 'wave', format: StickerFormatType.PNG },
          { id: '2', name: 'lottie', format: StickerFormatType.Lottie },
        ],
      }),
    );
    expect(body.stickers).toEqual([
      { name: 'wave', url: 'https://cdn.discordapp.com/stickers/1.png' },
      { name: 'lottie', url: undefined },
    ]);
    expect(bodyIsEmpty(body)).toBe(false);
  });

  it('shares the image slots between attachments, stickers and embeds', () => {
    const body = describeMessage(
      message({
        attachments: [attachment('a.png'), attachment('b.png'), attachment('c.png')],
        stickers: [
          { id: '1', name: 's1', format: StickerFormatType.PNG },
          { id: '2', name: 's2', format: StickerFormatType.PNG },
        ],
        embeds: [{ type: 'image', image: { url: 'https://media.giphy.com/a.gif' } }],
      }),
    );
    expect(body.images).toHaveLength(3);
    expect(body.stickers[0]?.url).toBeDefined();
    expect(body.stickers[1]?.url).toBeUndefined();
    expect(body.embedMedia).toHaveLength(0);
  });

  it('turns a native poll into a note', () => {
    const body = describeMessage(message({ pollQuestion: 'Pizza or  pasta?' }));
    expect(body.note).toBe('📊 Poll: Pizza or pasta?');
    expect(bodyIsEmpty(body)).toBe(false);
    expect(pollNote('  ')).toBe('📊 Poll');
  });

  it('shows the first snapshot of a forward', () => {
    const body = describeMessage(
      message({
        content: 'ignored',
        snapshots: [
          {
            content: 'forwarded text',
            attachments: [attachment('f.png')],
            stickers: [],
            embeds: [],
          },
        ],
      }),
    );
    expect(body.forwarded).toBe(true);
    expect(body.text).toBe('forwarded text');
    expect(body.images.map((i) => i.name)).toEqual(['f.png']);
  });

  it('keeps long content whole for the caller to truncate', () => {
    const body = describeMessage(message({ content: 'x'.repeat(5000) }));
    expect(body.text).toHaveLength(5000);
    expect(quoteExcerpt(body.text).length).toBeLessThanOrEqual(hallOfFame.maxTextLength + 2);
  });
});

describe('render hash', () => {
  const base = () =>
    describeMessage(
      message({
        content: 'hi',
        attachments: [attachment('a.png')],
        embeds: [{ type: 'image', image: { url: 'https://media.giphy.com/a.gif?sig=1' } }],
      }),
    );

  it('is stable across signed link changes', () => {
    const a = base();
    const b = base();
    for (const image of b.images) image.url = `${image.url}&hm=other`;
    for (const media of b.embedMedia) media.url = media.url.replace('sig=1', 'sig=2');
    expect(renderHash(bodyHashParts(a))).toBe(renderHash(bodyHashParts(b)));
  });

  it('changes with the visible content', () => {
    const a = base();
    const b = { ...base(), text: 'hi!' };
    expect(renderHash(bodyHashParts(a))).not.toBe(renderHash(bodyHashParts(b)));
    const c = base();
    c.images[0] = { ...(c.images[0] as (typeof c.images)[0]), spoiler: true };
    expect(renderHash(bodyHashParts(a))).not.toBe(renderHash(bodyHashParts(c)));
  });

  it('serialises independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
    expect(renderHash({ a: 1, b: 2 })).toBe(renderHash({ b: 2, a: 1 }));
    expect(stableUrl('https://x.test/a.png?ex=1#h')).toBe('https://x.test/a.png');
  });
});

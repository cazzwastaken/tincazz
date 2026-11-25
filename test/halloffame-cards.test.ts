import { ButtonStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  type HallCardInput,
  hallAttachmentNames,
  hallCard,
  hallComponentBudget,
  hallIntroCard,
  hallOfFame,
  hallRenderHash,
  hallTextBudget,
  hallUploadName,
  inlineText,
  isRenderableEmoji,
} from '../src/features/halloffame/index.js';
import {
  allText,
  buttons,
  cardInput,
  componentCount,
  emptyBody,
  galleryUrls,
  referencedAttachments,
  textLength,
  texts,
  walk,
} from './support/hall-card.js';

const zeroWidth = String.fromCodePoint(0x200b);
const image = (name: string, spoiler = false) => ({
  id: name,
  name,
  url: `https://cdn.discordapp.com/attachments/1/2/${name}`,
  size: 1000,
  spoiler,
});

function render(over: Partial<HallCardInput> = {}) {
  const input = cardInput(over);
  return { input, card: hallCard(input) };
}

describe('hallCard structure', () => {
  it('lays out header, author, quote, footer and link buttons', () => {
    const { card } = render({ breakdown: [{ emoji: '🔥', count: 4 }] });
    const all = allText(card);
    expect(texts(card)[0]).toBe('-# 🏛️ HALL OF FAME');
    expect(all).toContain('**Cazz**');
    expect(all).toContain('-# @cazzwastaken · in <#333333333333333333> · <t:1700000000:R>');
    expect(all).toContain('> hello world');
    expect(all).toContain('-# ⭐ **6** people · 🔥 4');
    const types = walk(card).map((node) => node.type);
    expect(types).toContain(9); // section
    expect(types).toContain(11); // thumbnail
    expect(types).toContain(14); // separator
    expect(types).toContain(1); // action row
  });

  it('uses the avatar as the section thumbnail', () => {
    const { card } = render();
    const thumbnail = walk(card).find((node) => node.type === 11);
    expect((thumbnail?.media as { url: string } | undefined)?.url).toContain(
      '/avatars/111111111111111111/abc.png',
    );
  });

  it('falls back to plain text when the avatar is not usable', () => {
    const { card } = render({
      author: { ...cardInput().author, avatarUrl: 'http://evil.example/a.png' },
    });
    expect(walk(card).some((node) => node.type === 9)).toBe(false);
    expect(allText(card)).toContain('**Cazz**');
  });

  it('links to the message and the channel with link buttons', () => {
    const { card } = render();
    expect(buttons(card)).toEqual([
      {
        label: 'Jump to message',
        url: 'https://discord.com/channels/222222222222222222/333333333333333333/444444444444444444',
      },
      {
        label: '#memes',
        url: 'https://discord.com/channels/222222222222222222/333333333333333333',
      },
    ]);
    for (const node of walk(card).filter((n) => n.type === 2)) {
      expect(node.style).toBe(ButtonStyle.Link);
    }
  });

  it('labels the channel button generically without a name', () => {
    const { card } = render({ source: { ...cardInput().source, channelName: undefined } });
    expect(buttons(card)[1]?.label).toBe('Channel');
  });
});

describe('hallCard tiers and wording', () => {
  const accent = (input: Partial<HallCardInput>) => render(input).card.toJSON().accent_color;

  it('picks accent and emoji by peak against the threshold', () => {
    expect(accent({ peak: 5, threshold: 5 })).toBe(0xf1c40f);
    expect(accent({ peak: 10, threshold: 5 })).toBe(0xe67e22);
    expect(accent({ peak: 20, threshold: 5 })).toBe(0xe91e63);
    expect(accent({ peak: 40, threshold: 5 })).toBe(0x9b59b6);
    expect(allText(render({ peak: 10, threshold: 5 }).card)).toContain('🌟 **10** people');
    expect(allText(render({ peak: 20, threshold: 5 }).card)).toContain('💫 **20** people');
    expect(allText(render({ peak: 40, threshold: 5 }).card)).toContain('👑 **40** people');
  });

  it('counts people, singular and plural, and never says reactions', () => {
    expect(allText(render({ peak: 1 }).card)).toContain('**1** person');
    expect(allText(render({ peak: 12 }).card)).toContain('**12** people');
    expect(allText(render({ peak: 1200 }).card)).toContain('**1,200** people');
    expect(allText(render({ peak: 12 }).card).toLowerCase()).not.toContain('reaction');
  });

  it('shows at most the top three emoji and drops ones it cannot print safely', () => {
    const { card } = render({
      breakdown: [
        { emoji: '🔥', count: 9 },
        { emoji: '**bold**', count: 8 },
        { emoji: '<:pog:123456789>', count: 7 },
        { emoji: '👍', count: 0 },
        { emoji: '😂', count: 3 },
        { emoji: '💀', count: 2 },
      ],
    });
    expect(allText(card)).toContain('🔥 9 · <:pog:123456789> 7 · 😂 3');
    expect(allText(card)).not.toContain('bold');
    expect(allText(card)).not.toContain('💀');
  });

  it('recognises renderable emoji', () => {
    for (const ok of ['🔥', '👍🏽', '1️⃣', '🇩🇪', '👨‍👩‍👧', '<a:dance:12345>']) {
      expect(isRenderableEmoji(ok)).toBe(true);
    }
    for (const bad of ['', 'a', '*', '**🔥**', '<@123>', '<:x:y>', '🔥'.repeat(20), '🔥\n']) {
      expect(isRenderableEmoji(bad)).toBe(false);
    }
  });
});

describe('hallCard text', () => {
  it('quotes multi line text and keeps code fences inside the quote', () => {
    const { card } = render({ body: emptyBody({ text: 'one\n\n```js\nlet a = 1;\n```' }) });
    expect(texts(card)).toContain(`> one\n> ${zeroWidth}\n> \`\`\`js\n> let a = 1;\n> \`\`\``);
  });

  it('keeps the quote in a display of its own, so an open fence cannot swallow the footer', () => {
    const { card } = render({ body: emptyBody({ text: '```never closed' }) });
    const all = texts(card);
    const quote = all.find((t) => t.startsWith('> '));
    expect(quote).toBe('> ```never closed');
    expect(all[all.length - 1]).toContain('people');
  });

  it('renders an empty message as a note, not an empty quote', () => {
    const { card } = render({ body: emptyBody() });
    expect(allText(card)).toContain('Nothing to preview here');
    expect(texts(card).some((t) => t.startsWith('>'))).toBe(false);
  });

  it('treats whitespace only text like no text', () => {
    const { card } = render({ body: emptyBody({ text: '  \n \n' }) });
    expect(texts(card).some((t) => t.startsWith('>'))).toBe(false);
  });

  it('cuts very long text and stays within the budget', () => {
    const { card } = render({ body: emptyBody({ text: 'word '.repeat(5000) }) });
    const quote = texts(card).find((t) => t.startsWith('> ')) ?? '';
    expect(quote.length).toBeLessThanOrEqual(hallOfFame.maxTextLength + 5);
    expect(quote.endsWith('…')).toBe(true);
    expect(textLength(card)).toBeLessThan(hallTextBudget);
  });

  it('shows a reply context line', () => {
    const { card } = render({ reply: { authorName: 'Bob', snippet: 'what **was** that?' } });
    expect(allText(card)).toContain('-# ↩️ replying to **Bob**: what \\*\\*was\\*\\* that?');
  });

  it('shows a reply without a snippet', () => {
    const { card } = render({ reply: { authorName: 'Bob', snippet: '' } });
    expect(allText(card)).toContain('-# ↩️ replying to **Bob**\n');
  });

  it('marks forwarded messages', () => {
    const { card } = render({ body: emptyBody({ forwarded: true, text: 'snapshot text' }) });
    expect(allText(card)).toContain('-# ↪️ Forwarded message');
    expect(allText(card)).toContain('> snapshot text');
  });

  it('notes native polls', () => {
    const { card } = render({ body: emptyBody({ note: '📊 Poll: pizza *or* sushi?' }) });
    expect(allText(card)).toContain('📊 Poll: pizza \\*or\\* sushi?');
    expect(allText(card)).not.toContain('Nothing to preview');
  });
});

describe('hallCard hostile content', () => {
  it('neutralises markdown, mentions and invisible characters in names', () => {
    const { card } = render({
      author: {
        ...cardInput().author,
        displayName: `## **x** <@123456789012345678> @everyone ${zeroWidth}[a](https://evil.example) \`\`\`\nline2`,
        username: '||spoiler|| <#1>',
      },
    });
    const [header, name, details] = texts(card);
    expect(header).toBe('-# 🏛️ HALL OF FAME');
    expect(name?.startsWith('**')).toBe(true);
    expect(name?.endsWith('**')).toBe(true);
    expect(name).not.toContain('\n');
    expect(name).not.toContain('<@');
    expect(name).not.toContain('@everyone');
    expect(name).not.toMatch(/\]\(/u);
    expect(details?.startsWith('-# @')).toBe(true);
    expect(details).not.toContain('\n');
    expect(details).not.toContain('<#1>');
    expect(details).not.toContain('||spoiler||');
  });

  it('caps a very long display name and username', () => {
    const { card } = render({
      author: { ...cardInput().author, displayName: 'N'.repeat(5000), username: 'u'.repeat(5000) },
    });
    const [, name, details] = texts(card);
    expect(name?.length).toBeLessThan(50);
    expect(details?.length).toBeLessThan(120);
  });

  it('falls back to the username then to Unknown for an invisible display name', () => {
    const invisible = zeroWidth.repeat(3);
    expect(
      allText(render({ author: { ...cardInput().author, displayName: invisible } }).card),
    ).toContain('**cazzwastaken**');
    expect(
      allText(
        render({ author: { ...cardInput().author, displayName: invisible, username: '' } }).card,
      ),
    ).toContain('**Unknown**');
  });

  it('keeps a newline flood in a reply and file names on one line', () => {
    const { card } = render({
      reply: { authorName: `a\n\n\n# b`, snippet: `x${'\n'.repeat(500)}y` },
      body: emptyBody({ files: ['evil\n# file`name.zip'] }),
    });
    for (const line of allText(card).split('\n')) {
      expect(line.startsWith('# ')).toBe(false);
    }
    expect(allText(card)).toContain('-# ↩️ replying to **a # b**: x y');
  });

  it('spells mentions and emoji in a snippet instead of rendering them', () => {
    const { card } = render({
      reply: { authorName: 'B', snippet: '<@123456789012345678> <:pog:99> <t:5:R>' },
    });
    const reply =
      allText(card)
        .split('\n')
        .find((line) => line.includes('replying')) ?? '';
    expect(reply).toContain('@​user :pog: a date'.replace('\\u200b', zeroWidth));
    expect(reply).not.toContain('<');
  });

  it('never prints the text of a spoiler in a reply preview', () => {
    const { card } = render({
      reply: { authorName: 'B', snippet: 'so ||the butler|| did it and ||another' },
    });
    const reply =
      allText(card)
        .split('\n')
        .find((line) => line.includes('replying')) ?? '';
    expect(reply).toContain('so spoiler did it and spoiler');
    expect(reply).not.toContain('butler');
    expect(reply).not.toContain('another');
  });

  it('inlineText flattens and escapes', () => {
    expect(inlineText('a\nb\tc', 10)).toBe('a b c');
    expect(inlineText('*_~|`[]()\\', 20)).toBe('\\*\\_\\~\\|\\`\\[\\]\\(\\)\\\\');
    expect(inlineText('<a>', 10)).toBe('‹a›');
    expect(inlineText('x'.repeat(50), 10).length).toBe(10);
  });
});

describe('hallCard media', () => {
  const twoImages = emptyBody({ images: [image('a b.png'), image('SPOILER_c.JPG', true)] });

  it('names uploads independent of the user file name and keeps the spoiler prefix', () => {
    expect(hallUploadName(image('my cat.PNG'), 0)).toBe('hall-0.png');
    expect(hallUploadName(image('x.jpeg'), 2)).toBe('hall-2.jpeg');
    expect(hallUploadName(image('noext'), 1)).toBe('hall-1.png');
    expect(hallUploadName(image('SPOILER_x.gif', true), 3)).toBe('SPOILER_hall-3.gif');
  });

  it('references only images the runner uploaded, with spoiler flags', () => {
    const uploaded = twoImages.images.map((img, i) => hallUploadName(img, i));
    const { card, input } = render({ body: twoImages, uploaded });
    expect(galleryUrls(card)).toEqual([
      'attachment://hall-0.png',
      'attachment://SPOILER_hall-1.jpg',
    ]);
    expect(hallAttachmentNames(input)).toEqual(['hall-0.png', 'SPOILER_hall-1.jpg']);
    const gallery = walk(card).find((node) => node.type === 12);
    const items = gallery?.items as { spoiler?: boolean }[];
    expect(items.map((item) => Boolean(item.spoiler))).toEqual([false, true]);
  });

  it('omits an image that failed to upload and says so', () => {
    const { card, input } = render({ body: twoImages, uploaded: ['hall-0.png'] });
    expect(galleryUrls(card)).toEqual(['attachment://hall-0.png']);
    expect(hallAttachmentNames(input)).toEqual(['hall-0.png']);
    expect(allText(card)).toContain("An image couldn't be copied");
  });

  it('has no gallery when every upload failed', () => {
    const { card, input } = render({ body: twoImages, uploaded: [] });
    expect(walk(card).some((node) => node.type === 12)).toBe(false);
    expect(hallAttachmentNames(input)).toEqual([]);
    expect(allText(card)).toContain("2 images couldn't be copied");
  });

  it('ignores uploads it does not know', () => {
    const { input } = render({ body: twoImages, uploaded: ['other.png', 'hall-9.png'] });
    expect(hallAttachmentNames(input)).toEqual([]);
  });

  it('renders an attachment-only message without a quote', () => {
    const { card } = render({
      body: emptyBody({ images: [image('p.png')] }),
      uploaded: ['hall-0.png'],
    });
    expect(texts(card).some((t) => t.startsWith('>'))).toBe(false);
    expect(allText(card)).not.toContain('Nothing to preview');
    expect(referencedAttachments(card)).toEqual(['hall-0.png']);
  });

  it('shows a sticker with an image in the gallery', () => {
    const url = 'https://cdn.discordapp.com/stickers/1.png';
    const { card } = render({ body: emptyBody({ stickers: [{ name: 'wave', url }] }) });
    expect(galleryUrls(card)).toEqual([url]);
    expect(allText(card)).not.toContain('Nothing to preview');
    expect(allText(card)).not.toContain('Sticker: wave');
  });

  it('shows a sticker without an image (Lottie) by name', () => {
    const { card } = render({
      body: emptyBody({ stickers: [{ name: 'Wumpus *dance*', url: undefined }] }),
    });
    expect(galleryUrls(card)).toEqual([]);
    expect(allText(card)).toContain('🏷️ Sticker: Wumpus \\*dance\\*');
    expect(allText(card)).not.toContain('Nothing to preview');
  });

  it('shows embed images and GIFs by URL with their spoiler flag, hosts allowlisted only', () => {
    const { card } = render({
      body: emptyBody({
        embedMedia: [
          { url: 'https://media.tenor.com/abc/x.gif', gif: true, spoiler: true },
          { url: 'https://evil.example/x.png', gif: false, spoiler: false },
          { url: 'http://media.tenor.com/abc/y.gif', gif: true, spoiler: false },
        ],
      }),
    });
    expect(galleryUrls(card)).toEqual(['https://media.tenor.com/abc/x.gif']);
  });

  it('never has more than four gallery items', () => {
    const images = Array.from({ length: 4 }, (_, i) => image(`i${i}.png`));
    const { card } = render({
      body: emptyBody({
        images,
        stickers: [{ name: 's', url: 'https://cdn.discordapp.com/stickers/1.png' }],
        embedMedia: [{ url: 'https://media.tenor.com/a.gif', gif: true, spoiler: false }],
      }),
      uploaded: images.map((img, i) => hallUploadName(img, i)),
    });
    expect(galleryUrls(card)).toHaveLength(hallOfFame.maxImages);
  });

  it('lists non-image files by name and counts the rest', () => {
    const { card } = render({
      body: emptyBody({ files: ['a.zip', 'b `c`.pdf'], moreFiles: 3 }),
    });
    const all = allText(card);
    expect(all).toContain('📎 a.zip\n📎 b \\`c\\`.pdf');
    expect(all).toContain('-# +3 more files');
    expect(all).not.toContain('Nothing to preview');
  });

  it('says "more file" for one', () => {
    expect(allText(render({ body: emptyBody({ files: ['a'], moreFiles: 1 }) }).card)).toContain(
      '+1 more file\n',
    );
  });
});

describe('hallCard limits', () => {
  const worstCase = (): HallCardInput => {
    const images = Array.from({ length: 4 }, (_, i) =>
      image(`SPOILER_${'x'.repeat(200)}${i}.png`, true),
    );
    return cardInput({
      author: {
        ...cardInput().author,
        displayName: '*'.repeat(500),
        username: '_'.repeat(500),
      },
      source: { ...cardInput().source, channelName: 'c'.repeat(500) },
      body: emptyBody({
        forwarded: true,
        text: '\n'.repeat(4000),
        note: `📊 Poll: ${'*'.repeat(500)}`,
        images,
        stickers: Array.from({ length: 10 }, (_, i) => ({
          name: `*${i}*`.repeat(60),
          url: undefined,
        })),
        files: Array.from({ length: 10 }, () => '`'.repeat(10) + 'f'.repeat(300)),
        moreFiles: 9999,
        embedMedia: [],
      }),
      reply: { authorName: '*'.repeat(500), snippet: '*'.repeat(500) },
      peak: 1_000_000,
      breakdown: Array.from({ length: 30 }, () => ({
        emoji: '<a:abcdefghijklmnopqrstuvwxyz012345:123456789012345678>',
        count: 1_000_000,
      })),
      uploaded: images.map((img, i) => hallUploadName(img, i)),
    });
  };

  it('stays under 40 components and the text budget in the worst case', () => {
    for (const text of [
      '\n'.repeat(4000),
      'x'.repeat(10_000),
      '> '.repeat(3000),
      '😀'.repeat(3000),
    ]) {
      const input = worstCase();
      input.body = { ...input.body, text };
      const card = hallCard(input);
      expect(componentCount(card)).toBeLessThan(hallComponentBudget);
      expect(textLength(card)).toBeLessThan(hallTextBudget + 100);
      expect(textLength(card)).toBeLessThan(4000);
      for (const content of texts(card)) expect(content.length).toBeGreaterThan(0);
    }
  });

  it('keeps button labels within Discord limits', () => {
    const card = hallCard(worstCase());
    for (const button of buttons(card)) expect(button.label.length).toBeLessThanOrEqual(80);
  });

  it('uses about twenty components for a typical card', () => {
    const { card } = render({
      body: emptyBody({ text: 'hi', images: [image('a.png')], files: ['x.zip'] }),
      uploaded: ['hall-0.png'],
      reply: { authorName: 'B', snippet: 'q' },
    });
    expect(componentCount(card)).toBeLessThan(25);
  });
});

describe('hallRenderHash', () => {
  const base = () => cardInput({ breakdown: [{ emoji: '🔥', count: 6 }] });

  it('is stable for equal input', () => {
    expect(hallRenderHash(base())).toBe(hallRenderHash(base()));
  });

  it('ignores signed URL parameters', () => {
    const a = base();
    const b = base();
    b.author = { ...b.author, avatarUrl: `${a.author.avatarUrl.split('?')[0]}?size=64&ex=1` };
    expect(hallRenderHash(a)).toBe(hallRenderHash(b));
  });

  it('changes with anything the card shows', () => {
    const hash = hallRenderHash(base());
    const variants: Partial<HallCardInput>[] = [
      { peak: 7 },
      { peak: 25 },
      { body: emptyBody({ text: 'edited' }) },
      { breakdown: [{ emoji: '🔥', count: 7 }] },
      { reply: { authorName: 'B', snippet: 's' } },
      { author: { ...cardInput().author, displayName: 'Other' } },
      { source: { ...cardInput().source, channelName: 'other' } },
      {
        body: emptyBody({ text: 'hello world', images: [image('a.png')] }),
        uploaded: ['hall-0.png'],
      },
    ];
    for (const variant of variants) {
      expect(hallRenderHash({ ...base(), ...variant })).not.toBe(hash);
    }
  });

  it('changes when an image upload fails', () => {
    const body = emptyBody({ images: [image('a.png')] });
    expect(hallRenderHash(cardInput({ body, uploaded: ['hall-0.png'] }))).not.toBe(
      hallRenderHash(cardInput({ body, uploaded: [] })),
    );
  });
});

describe('hallIntroCard', () => {
  it('explains the threshold, distinct people and the silent guards', () => {
    const card = hallIntroCard('333333333333333333', 5, '111111111111111111');
    const all = allText(card);
    expect(all).toContain('<#333333333333333333>');
    expect(all).toContain('<@111111111111111111>');
    expect(all).toContain('**5**');
    expect(all).toContain('**people**');
    expect(all).toContain('Private threads');
    expect(all).toContain('Age-restricted channels');
    expect(all).toContain('Private channels');
    expect(all).not.toContain('No hall channel');
    expect(componentCount(card)).toBeLessThan(hallComponentBudget);
    expect(textLength(card)).toBeLessThan(4000);
  });
});

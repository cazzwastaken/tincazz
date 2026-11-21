import { describe, expect, it } from 'vitest';
import {
  extractUrls,
  hasDirectSource,
  type MessageSource,
  messageSource,
  messages,
  pickSource,
  type ReplyData,
  removeUrl,
} from '../src/features/imaging/index.js';

const png = 'https://cdn.discordapp.com/attachments/1/2/a.png';
const tenorPage = 'https://tenor.com/view/cat-dance-123';
const emptyMessage: ReplyData = { attachments: [], embeds: [], stickers: [], content: '' };
const message = (r: Partial<ReplyData>): ReplyData => ({ ...emptyMessage, ...r });
const embed = (e: Partial<ReplyData['embeds'][number]>): ReplyData['embeds'][number] => ({
  url: null,
  provider: null,
  imageUrl: null,
  imageProxyUrl: null,
  thumbnailUrl: null,
  thumbnailProxyUrl: null,
  hasVideo: false,
  ...e,
});

/** A short form of the decision: `image <url>`, `screenshot <text> [+ <url>]` or `error <message>`. */
function summary(source: MessageSource): string {
  if (source.kind === 'image') return `image ${source.check.url.href}`;
  if (source.kind === 'error') return `error ${source.message}`;
  return `screenshot ${source.text}${source.image ? ` + ${source.image.url.href}` : ''}`;
}

describe('messageSource', () => {
  it.each<[string, Partial<ReplyData>, string]>([
    ['text only', { content: 'hello there' }, 'screenshot hello there'],
    [
      'text and an attachment',
      { content: 'look', attachments: [{ url: png, contentType: 'image/png' }] },
      `screenshot look + ${png}`,
    ],
    [
      'an attachment only',
      { attachments: [{ url: png, contentType: 'image/png' }] },
      `image ${png}`,
    ],
    [
      'a sticker only',
      { stickers: [{ url: 'https://media.discordapp.net/stickers/1.png', format: 'png' }] },
      'image https://media.discordapp.net/stickers/1.png',
    ],
    ['a bare image link', { content: png }, `image ${png}`],
    ['an image link in <>', { content: `<${png}>` }, `image ${png}`],
    [
      'a Tenor link with its embed',
      {
        content: tenorPage,
        embeds: [embed({ url: tenorPage, provider: 'Tenor', hasVideo: true })],
      },
      `image ${tenorPage}`,
    ],
    [
      'text around a Tenor link',
      {
        content: `when the ${tenorPage} hits`,
        embeds: [embed({ url: tenorPage, provider: 'Tenor', hasVideo: true })],
      },
      `screenshot when the  hits + ${tenorPage}`,
    ],
    ['text and an image link', { content: `see ${png}.` }, `screenshot see . + ${png}`],
    [
      'a link that is not allowed stays text',
      { content: 'https://example.com/a.png' },
      'screenshot https://example.com/a.png',
    ],
    [
      'text with a video attachment',
      { content: 'clip', attachments: [{ url: png, contentType: 'video/mp4' }] },
      'screenshot clip',
    ],
    [
      'a video only',
      { attachments: [{ url: png, contentType: 'video/mp4' }] },
      `error ${messages.video}`,
    ],
    [
      'a lottie sticker only',
      { stickers: [{ url: 'https://media.discordapp.net/stickers/1.json', format: 'lottie' }] },
      `error ${messages.lottie}`,
    ],
    ['nothing at all', {}, `error ${messages.emptyMessage}`],
    ['only markdown markers', { content: '** __ ~~' }, `error ${messages.emptyMessage}`],
    ['only whitespace', { content: ' \n\t ' }, `error ${messages.emptyMessage}`],
  ])('%s', (_name, input, expected) => {
    expect(summary(messageSource(message(input)))).toBe(expected);
  });
});

describe('spoiler images', () => {
  const spoilerAttachment = { url: png, contentType: 'image/png', spoiler: true };

  it('refuses a spoiler image on its own', () => {
    expect(summary(messageSource(message({ attachments: [spoilerAttachment] })))).toBe(
      `error ${messages.spoiler}`,
    );
  });

  it('refuses a link or embed inside a spoiler', () => {
    expect(summary(messageSource(message({ content: `||${png}||` })))).toBe(
      `error ${messages.spoiler}`,
    );
    expect(
      summary(
        messageSource(
          message({
            content: `||${tenorPage}||`,
            embeds: [embed({ url: tenorPage, provider: 'Tenor', hasVideo: true })],
          }),
        ),
      ),
    ).toBe(`error ${messages.spoiler}`);
  });

  it('screenshots text with a spoiler image and flags the image', () => {
    const source = messageSource(message({ content: 'look', attachments: [spoilerAttachment] }));
    expect(source).toMatchObject({ kind: 'screenshot', imageSpoiler: true });
  });

  it('does not flag an ordinary image', () => {
    const source = messageSource(
      message({ content: 'look', attachments: [{ url: png, contentType: 'image/png' }] }),
    );
    expect(source).toMatchObject({ kind: 'screenshot', imageSpoiler: false });
  });

  it('refuses a replied-to spoiler image as a plain source', () => {
    expect(pickSource({ reply: message({ attachments: [spoilerAttachment] }) })).toEqual({
      ok: false,
      message: messages.spoiler,
    });
  });

  it('still uses the invoker own spoiler attachment', () => {
    expect(pickSource({ attachment: spoilerAttachment })).toMatchObject({ ok: true });
  });
});

describe('removeUrl', () => {
  it('removes the link and keeps the punctuation after it', () => {
    expect(removeUrl(`a ${png}, b`, png)).toBe('a , b');
  });

  it('removes a link in angle brackets', () => {
    expect(removeUrl(`a <${png}> b`, png)).toBe('a  b');
  });

  it('keeps other links', () => {
    expect(removeUrl(`${tenorPage} ${png}`, png)).toBe(`${tenorPage} `);
  });

  it('matches links that only differ in normalisation', () => {
    expect(removeUrl('https://CDN.discordapp.com/x.png', 'https://cdn.discordapp.com/x.png')).toBe(
      '',
    );
  });
});

describe('hasDirectSource', () => {
  it('is true for an attachment, a link or a user, false for nothing or only a reply', () => {
    expect(hasDirectSource({ attachment: { url: png, contentType: null } })).toBe(true);
    expect(hasDirectSource({ url: png })).toBe(true);
    expect(hasDirectSource({ avatarUrl: png })).toBe(true);
    expect(hasDirectSource({})).toBe(false);
    expect(hasDirectSource({ reply: emptyMessage })).toBe(false);
  });
});

describe('links inside spoilers', () => {
  it('finds a link wrapped in || without the markers', () => {
    expect(extractUrls(`||${png}||`)).toEqual([png]);
  });
});

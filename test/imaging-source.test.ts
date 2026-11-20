import { describe, expect, it } from 'vitest';
import { messages, pickSource, type ReplyData } from '../src/features/imaging/index.js';

const att = (url: string, contentType: string | null = 'image/png') => ({ url, contentType });
const png = 'https://cdn.discordapp.com/attachments/1/2/a.png';
const other = 'https://cdn.discordapp.com/attachments/1/2/b.png';
const emptyReply: ReplyData = { attachments: [], embeds: [], stickers: [], content: '' };
const reply = (r: Partial<ReplyData>): ReplyData => ({ ...emptyReply, ...r });
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

function href(p: ReturnType<typeof pickSource>): string | undefined {
  return p.ok ? p.check.url.href : undefined;
}

describe('pickSource precedence', () => {
  it('attachment beats url', () => {
    expect(href(pickSource({ attachment: att(png), url: other }))).toBe(png);
  });
  it('url beats avatar', () => {
    expect(href(pickSource({ url: png, avatarUrl: other }))).toBe(png);
  });
  it('avatar beats reply', () => {
    expect(href(pickSource({ avatarUrl: png, reply: reply({ attachments: [att(other)] }) }))).toBe(
      png,
    );
  });
  it('a bad url does not fall back', () => {
    expect(pickSource({ url: 'https://evil.example/a.png', avatarUrl: png })).toEqual({
      ok: false,
      message: messages.notAllowed,
    });
  });
  it('a bad avatar is not allowed', () => {
    expect(pickSource({ avatarUrl: 'https://evil.example/a.png' })).toEqual({
      ok: false,
      message: messages.notAllowed,
    });
  });
  it('video and non-image attachments are rejected', () => {
    expect(pickSource({ attachment: att(png, 'video/mp4') })).toEqual({
      ok: false,
      message: messages.video,
    });
    expect(pickSource({ attachment: att(png, 'application/pdf') })).toEqual({
      ok: false,
      message: messages.notImage,
    });
  });
  it('a bad attachment url does not fall back to url', () => {
    expect(pickSource({ attachment: att('https://evil.example/a.png'), url: png })).toEqual({
      ok: false,
      message: messages.notAllowed,
    });
  });
  it('accepts an attachment without a content type', () => {
    expect(href(pickSource({ attachment: att(png, null) }))).toBe(png);
  });
  it('empty inputs ask for usage', () => {
    expect(pickSource({})).toEqual({ ok: false, message: null });
    expect(pickSource({ reply: emptyReply })).toEqual({ ok: false, message: messages.notImage });
  });
});

describe('pickSource reply', () => {
  const pick = (r: Partial<ReplyData>) => pickSource({ reply: reply(r) });

  it('uses an image attachment, skipping videos', () => {
    expect(href(pick({ attachments: [att(other, 'video/mp4'), att(png)] }))).toBe(png);
  });
  it('uses the tenor page for a gifv embed', () => {
    const r = pick({
      embeds: [
        embed({
          url: 'https://tenor.com/view/x-gif-1',
          provider: 'Tenor',
          thumbnailUrl: 'https://media.tenor.com/t.png',
          hasVideo: true,
        }),
      ],
    });
    expect(r.ok && r.check.kind).toBe('tenorPage');
  });
  it('uses giphy media for a giphy gifv embed', () => {
    const r = pick({
      embeds: [
        embed({ url: 'https://giphy.com/gifs/funny-AbC123', provider: 'GIPHY', hasVideo: true }),
      ],
    });
    expect(href(r)).toBe('https://i.giphy.com/AbC123.gif');
  });
  it('uses embed images then thumbnails', () => {
    const img = 'https://images-ext-1.discordapp.net/external/x/https/example.com/a.png';
    expect(href(pick({ embeds: [embed({ url: 'https://example.com/p', imageUrl: img })] }))).toBe(
      img,
    );
    expect(
      href(
        pick({ embeds: [embed({ imageUrl: 'https://evil.example/a.png', thumbnailUrl: png })] }),
      ),
    ).toBe(png);
  });
  it('falls back to the discord proxy of an embed image, then the thumbnail and its proxy', () => {
    const proxy = 'https://images-ext-1.discordapp.net/external/abc/https/i.imgur.com/a.gif';
    const imgur = 'https://i.imgur.com/a.gif';
    expect(href(pick({ embeds: [embed({ imageUrl: imgur, imageProxyUrl: proxy })] }))).toBe(proxy);
    expect(
      href(
        pick({
          embeds: [embed({ imageUrl: imgur, thumbnailUrl: imgur, thumbnailProxyUrl: proxy })],
        }),
      ),
    ).toBe(proxy);
    expect(
      href(pick({ embeds: [embed({ imageUrl: imgur, imageProxyUrl: imgur, thumbnailUrl: png })] })),
    ).toBe(png);
    // the original image wins over its proxy when both are allowed
    expect(href(pick({ embeds: [embed({ imageUrl: png, imageProxyUrl: proxy })] }))).toBe(png);
  });
  it('uses a png sticker and skips lottie', () => {
    expect(
      href(
        pick({
          stickers: [
            { url: other, format: 'lottie' },
            { url: png, format: 'png' },
          ],
        }),
      ),
    ).toBe(png);
  });
  it('a lottie-only reply says lottie', () => {
    expect(pick({ stickers: [{ url: png, format: 'lottie' }] })).toEqual({
      ok: false,
      message: messages.lottie,
    });
  });
  it('finds an allowed url in content', () => {
    expect(href(pick({ content: `look https://evil.example/x and ${png} ok` }))).toBe(png);
  });
  it('a lottie sticker does not stop a content url from being used', () => {
    expect(href(pick({ stickers: [{ url: other, format: 'lottie' }], content: png }))).toBe(png);
  });
  it('lottie outranks video in the final error', () => {
    expect(
      pick({
        attachments: [att(other, 'video/mp4')],
        stickers: [{ url: png, format: 'lottie' }],
      }),
    ).toEqual({ ok: false, message: messages.lottie });
  });
  it('chain order: attachment, embed, sticker, content', () => {
    const a = 'https://cdn.discordapp.com/attachments/1/2/a.png';
    const e = 'https://cdn.discordapp.com/attachments/1/2/e.png';
    const s = 'https://cdn.discordapp.com/attachments/1/2/s.png';
    const c = 'https://cdn.discordapp.com/attachments/1/2/c.png';
    const full = {
      attachments: [att(a)],
      embeds: [embed({ imageUrl: e })],
      stickers: [{ url: s, format: 'png' as const }],
      content: c,
    };
    expect(href(pick(full))).toBe(a);
    expect(href(pick({ ...full, attachments: [] }))).toBe(e);
    expect(href(pick({ ...full, attachments: [], embeds: [] }))).toBe(s);
    expect(href(pick({ ...full, attachments: [], embeds: [], stickers: [] }))).toBe(c);
  });
  it('a video-only reply attachment still lets a content url win', () => {
    expect(href(pick({ attachments: [att(other, 'video/mp4')], content: png }))).toBe(png);
  });
  it('only a video attachment says video', () => {
    expect(pick({ attachments: [att(png, 'video/mp4')] })).toEqual({
      ok: false,
      message: messages.video,
    });
  });
});

import fc from 'fast-check';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  avatarCircle,
  bubbleGeometry,
  bubbleHeadroom,
  checkUrl,
  cleanName,
  composeScreenshot,
  contentWidth,
  discordColors,
  type Fetcher,
  fitImage,
  formatTimestamp,
  ImagingError,
  layoutScreenshot,
  type MessageSnapshot,
  messageMarkup,
  messages,
  nameColor,
  noMentionNames,
  renderImage,
  renderScreenshot,
  type ScreenshotParts,
  screenshot,
  sniffImage,
} from '../src/features/imaging/index.js';
import { makeGif, makePng } from './support/images.js';

const hex = (rgb: number[]) =>
  `#${rgb
    .slice(0, 3)
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;

async function pixel(png: Buffer, x: number, y: number): Promise<string> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return hex([data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0]);
}

describe('formatTimestamp', () => {
  it.each([
    [Date.UTC(2026, 10, 21, 14, 32), '11/21/2026 2:32 PM'],
    [Date.UTC(2026, 0, 5, 0, 7), '01/05/2026 12:07 AM'],
    [Date.UTC(2026, 0, 5, 12, 0), '01/05/2026 12:00 PM'],
    [Date.UTC(2026, 0, 5, 11, 59), '01/05/2026 11:59 AM'],
  ])('%i -> %s', (ms, expected) => {
    expect(formatTimestamp(ms)).toBe(expected);
  });
});

describe('nameColor', () => {
  it('keeps a role colour, lower cased', () => {
    expect(nameColor('#E91E63')).toBe('#e91e63');
  });
  it('uses the default for no colour, black (no coloured role) and anything malformed', () => {
    for (const value of [null, '#000000', 'red', '#fff', '"/><span', '#12345g']) {
      expect(nameColor(value)).toBe(discordColors.name);
    }
  });
});

describe('cleanName', () => {
  it('flattens line breaks and invisible characters', () => {
    expect(cleanName(' a\nb​c ')).toBe('a b c');
  });
  it('caps long names with an ellipsis', () => {
    expect(cleanName('x'.repeat(50))).toBe(`${'x'.repeat(32)}…`);
  });
  it('names an empty name', () => {
    expect(cleanName('​ ')).toBe('unknown-user');
  });
});

describe('fitImage', () => {
  it('never scales up', () => {
    expect(fitImage(100, 50, 512, 350)).toEqual({ width: 100, height: 50 });
  });
  it('fits the width', () => {
    expect(fitImage(1024, 200, 512, 350)).toEqual({ width: 512, height: 100 });
  });
  it('fits the height', () => {
    expect(fitImage(200, 700, 512, 350)).toEqual({ width: 100, height: 350 });
  });
  it('always fits and keeps at least one pixel', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (w, h) => {
          const fit = fitImage(w, h, contentWidth, screenshot.imageMaxHeight);
          expect(fit.width).toBeGreaterThanOrEqual(1);
          expect(fit.height).toBeGreaterThanOrEqual(1);
          expect(fit.width).toBeLessThanOrEqual(Math.min(w, contentWidth));
          expect(fit.height).toBeLessThanOrEqual(Math.min(h, screenshot.imageMaxHeight));
        },
      ),
    );
  });
});

describe('layoutScreenshot', () => {
  it('puts the avatar at the padding and the text beside it', () => {
    const layout = layoutScreenshot({ width: 200, height: 44 }, null);
    expect(layout.width).toBe(screenshot.width);
    expect(layout.avatar).toEqual({ left: 16, top: 16, width: 40, height: 40 });
    expect(layout.text).toEqual({ left: 72, top: 16, width: 200, height: 44 });
    expect(layout.image).toBeNull();
    expect(layout.height).toBe(16 + 44 + 16);
  });

  it('is at least as tall as the avatar', () => {
    expect(layoutScreenshot({ width: 50, height: 10 }, null).height).toBe(16 + 40 + 16);
  });

  it('puts the image under the text', () => {
    const layout = layoutScreenshot({ width: 200, height: 44 }, { width: 300, height: 200 });
    expect(layout.image).toEqual({
      left: 72,
      top: 16 + 44 + screenshot.imageGap,
      width: 300,
      height: 200,
    });
    expect(layout.height).toBe(16 + 44 + screenshot.imageGap + 200 + 16);
  });

  it('shifts everything down by the headroom', () => {
    const plain = layoutScreenshot({ width: 200, height: 44 }, null);
    const room = layoutScreenshot({ width: 200, height: 44 }, null, { headroom: true });
    const top = bubbleHeadroom(plain.width, plain.height);
    expect(room.height).toBe(plain.height + top);
    expect(room.text.top).toBe(plain.text.top + top);
    expect(room.avatar.top).toBe(plain.avatar.top + top);
  });

  it('keeps every box inside the canvas', () => {
    const size = fc.record({
      width: fc.integer({ min: 1, max: 2000 }),
      height: fc.integer({ min: 1, max: 2000 }),
    });
    fc.assert(
      fc.property(size, fc.option(size), fc.boolean(), (text, image, headroom) => {
        const layout = layoutScreenshot(text, image, { headroom });
        for (const box of [layout.avatar, layout.text, layout.image]) {
          if (!box) continue;
          expect(box.left + box.width).toBeLessThanOrEqual(layout.width);
          expect(box.top + box.height).toBeLessThanOrEqual(layout.height);
        }
      }),
    );
  });
});

describe('bubbleHeadroom', () => {
  it('keeps the whole bubble, tail tip included, above the message', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 16, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (width, height) => {
          const room = bubbleHeadroom(width, height);
          const g = bubbleGeometry(width, height + room);
          expect(g.tipY).toBeLessThanOrEqual(room);
          expect(g.curveY).toBeLessThanOrEqual(room);
        },
      ),
    );
  });
});

describe('messageMarkup', () => {
  it('escapes the name, colours it and styles mentions', () => {
    const markup = messageMarkup({
      name: '<b>&',
      color: '#e91e63',
      timestamp: '11/21/2026 2:32 PM',
      runs: [{ text: 'hi ' }, { text: '@x<y>', mention: true }],
    });
    expect(markup).toContain('<span foreground="#e91e63" weight="semibold">&lt;b&gt;&amp;</span>');
    expect(markup).toContain('11/21/2026 2:32 PM');
    expect(markup).toContain(`background="${discordColors.mentionBackground}"`);
    expect(markup).toContain('@x&lt;y&gt;');
  });

  it('draws a spoiler as a solid box and escapes its text', () => {
    const markup = messageMarkup({
      name: 'a',
      color: '#ffffff',
      timestamp: 't',
      runs: [{ text: '<secret>', spoiler: true }],
    });
    expect(markup).toContain(
      `<span foreground="${discordColors.spoiler}" background="${discordColors.spoiler}">&lt;secret&gt;</span>`,
    );
  });

  it('has only the header when there is no text', () => {
    const markup = messageMarkup({ name: 'a', color: '#ffffff', timestamp: 't', runs: [] });
    expect(markup).not.toContain('\n');
  });
});

const parts = (over: Partial<ScreenshotParts> = {}): ScreenshotParts => ({
  name: 'cazz',
  color: '#e91e63',
  createdTimestamp: Date.UTC(2026, 10, 21, 14, 32),
  text: 'hello **there**, this is a message',
  names: noMentionNames,
  avatar: null,
  image: null,
  ...over,
});

describe('avatarCircle', () => {
  it('draws a grey circle for no avatar or one that cannot be decoded', async () => {
    for (const input of [null, Buffer.from('not an image')]) {
      const circle = await avatarCircle(input);
      expect(await pixel(circle, 20, 20)).toBe(discordColors.avatarFallback);
      const { data } = await sharp(circle).raw().toBuffer({ resolveWithObject: true });
      expect(data[3]).toBe(0); // the corner is cut away
    }
  });

  it('cuts the avatar to a circle', async () => {
    const circle = await avatarCircle(await makePng({ width: 128, height: 128 }));
    expect(await pixel(circle, 20, 20)).toBe('#c82828');
  });
});

describe('composeScreenshot', () => {
  it('draws a text-only message on the dark background', async () => {
    const png = await composeScreenshot(parts());
    const meta = await sharp(png).metadata();
    expect(sniffImage(png)).toBe('png');
    expect(meta.width).toBe(screenshot.width);
    expect(meta.height).toBeGreaterThanOrEqual(72);
    expect(meta.height).toBeLessThan(120);
    expect(await pixel(png, screenshot.width - 2, 2)).toBe(discordColors.background);
    expect(await pixel(png, 36, 36)).toBe(discordColors.avatarFallback);
  });

  it('adds the attached image under the text', async () => {
    const image = await makePng({ width: 1000, height: 500 });
    const png = await composeScreenshot(parts({ image }));
    const meta = await sharp(png).metadata();
    // 1000 x 500 fits the content width: 512 x 256 under the text
    expect(meta.height).toBeGreaterThan(256 + 40);
    expect(await pixel(png, screenshot.contentLeft + 256, (meta.height ?? 0) - 16 - 128)).toBe(
      '#c82828',
    );
  });

  it('uses the first frame of an animated image', async () => {
    const image = await makeGif({
      width: 60,
      height: 40,
      frames: 3,
      delay: 50,
      loop: 0,
      colors: [
        [0, 255, 0],
        [255, 0, 0],
        [0, 0, 255],
      ],
    });
    const png = await composeScreenshot(parts({ image }));
    const meta = await sharp(png).metadata();
    expect(meta.pages ?? 1).toBe(1);
    expect(await pixel(png, screenshot.contentLeft + 30, (meta.height ?? 0) - 16 - 20)).toBe(
      '#00ff00',
    );
  });

  it('leaves room for the bubble with headroom', async () => {
    const plain = await sharp(await composeScreenshot(parts())).metadata();
    const room = await sharp(await composeScreenshot(parts(), { headroom: true })).metadata();
    expect(room.height).toBe(
      (plain.height ?? 0) + bubbleHeadroom(screenshot.width, plain.height ?? 0),
    );
  });

  it('refuses an attachment that is not an image', async () => {
    await expect(composeScreenshot(parts({ image: Buffer.from('nope') }))).rejects.toThrow(
      new ImagingError(messages.notImage),
    );
  });

  it('bubbles into a real GIF, text only and with an image', async () => {
    for (const image of [null, await makePng({ width: 300, height: 200 })]) {
      const png = await composeScreenshot(parts({ image }), { headroom: true });
      const result = await renderImage(png, { kind: 'bubble', style: 'transparent', tail: 'left' });
      expect(sniffImage(result.gif)).toBe('gif');
      expect(result.pages).toBe(1);
      expect(result.width).toBe(512);
    }
  }, 30_000);
});

const avatarUrl = 'https://cdn.discordapp.com/avatars/1/abc.png?size=128';
const imageUrl = 'https://cdn.discordapp.com/attachments/1/2/a.png';

const snapshot = (over: Partial<MessageSnapshot['author']> = {}): MessageSnapshot => ({
  author: { name: 'cazz', color: null, avatarUrl, ...over },
  createdTimestamp: 0,
  message: { attachments: [], embeds: [], stickers: [], content: 'hi' },
  names: noMentionNames,
});

function fetcher(routes: Record<string, () => Response>): Fetcher {
  return vi.fn(async (input: string | URL | Request) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`unexpected fetch ${String(input)}`);
    return route();
  }) as unknown as Fetcher;
}

describe('renderScreenshot', () => {
  it('downloads the avatar and the image through the allowlisted downloader', async () => {
    const avatar = await makePng({ width: 128, height: 128 });
    const image = await makePng({ width: 100, height: 100 });
    const fetch = fetcher({
      [avatarUrl]: () => new Response(new Uint8Array(avatar)),
      [imageUrl]: () => new Response(new Uint8Array(image)),
    });
    const check = checkUrl(imageUrl);
    if (!check.ok) throw new Error('allowlist');
    const png = await renderScreenshot(snapshot(), { text: 'hi', image: check }, { fetch });
    expect(sniffImage(png)).toBe('png');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to the grey circle when the avatar download fails', async () => {
    const fetch = fetcher({ [avatarUrl]: () => new Response('nope', { status: 404 }) });
    const png = await renderScreenshot(snapshot(), { text: 'hi', image: null }, { fetch });
    // the avatar column shows the placeholder somewhere below the headroom
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const column = Array.from({ length: info.height }, (_, y) => {
      const o = (y * info.width + 36) * info.channels;
      return hex([data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0]);
    });
    expect(column).toContain(discordColors.avatarFallback);
  });

  it('never fetches an avatar off the allowlist', async () => {
    const fetch = fetcher({});
    const png = await renderScreenshot(
      snapshot({ avatarUrl: 'https://evil.com/a.png' }),
      { text: 'hi', image: null },
      { fetch },
    );
    expect(sniffImage(png)).toBe('png');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails with the download error when the image cannot be downloaded', async () => {
    const fetch = fetcher({
      [avatarUrl]: () => new Response('nope', { status: 404 }),
      [imageUrl]: () => new Response('nope', { status: 500 }),
    });
    const check = checkUrl(imageUrl);
    if (!check.ok) throw new Error('allowlist');
    await expect(
      renderScreenshot(snapshot(), { text: 'hi', image: check }, { fetch }),
    ).rejects.toThrow(new ImagingError(messages.download));
  });
});

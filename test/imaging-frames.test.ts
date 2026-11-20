import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  decodeFrames,
  encodeGif,
  type Frames,
  fromSharp,
  halveFrames,
  sampleGroups,
  sniffImage,
  toSharp,
} from '../src/features/imaging/index.js';
import { frameColor, pixelAt, toCentis } from './support/images.js';

/** A raw strip whose frame `i` is filled with `frameColor(i)`. */
function strip(width: number, pageHeight: number, delay: number[], loop = 0): Frames {
  const pages = delay.length;
  const frameBytes = width * pageHeight * 4;
  const data = Buffer.alloc(frameBytes * pages);
  for (let page = 0; page < pages; page++) {
    const [r, g, b] = frameColor(page);
    for (let offset = page * frameBytes; offset < (page + 1) * frameBytes; offset += 4) {
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { data, width, pageHeight, pages, delay, loop };
}

describe('sampleGroups', () => {
  it('keeps every page as its own group under the cap', () => {
    expect(sampleGroups(10, 100)).toEqual(Array.from({ length: 10 }, (_, i) => [i]));
  });

  it('merges consecutive pages evenly over the cap', () => {
    const groups = sampleGroups(250, 100);
    expect(groups).toHaveLength(100);
    expect(groups.flat()).toEqual(Array.from({ length: 250 }, (_, i) => i));
    const sizes = groups.map((group) => group.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });
});

describe('halveFrames', () => {
  it('keeps the first frame of each pair and sums the pair delays', () => {
    const halved = halveFrames(strip(4, 3, [10, 20, 30, 40, 50], 2));
    expect(halved.pages).toBe(3);
    expect(halved.delay).toEqual([30, 70, 50]);
    expect(halved.loop).toBe(2);
    expect(halved.width).toBe(4);
    expect(halved.pageHeight).toBe(3);
    expect(halved.data.length).toBe(4 * 3 * 4 * 3);
    expect(pixelAt(halved, 0)).toEqual(frameColor(0));
    expect(pixelAt(halved, 1, 3, 2)).toEqual(frameColor(2));
    expect(pixelAt(halved, 2)).toEqual(frameColor(4));
  });

  it('leaves a single frame alone', () => {
    const one = strip(2, 2, [0]);
    expect(halveFrames(one)).toEqual(one);
  });
});

describe('toSharp and fromSharp', () => {
  it('round trips a strip through sharp, keeping delay and loop', async () => {
    const frames = strip(5, 4, [40, 60, 80], 3);
    const back = await fromSharp(toSharp(frames), frames);
    expect(back).toEqual(frames);
  });

  it('adds an alpha channel to a 3-channel image', async () => {
    const img = sharp({ create: { width: 3, height: 6, channels: 3, background: '#ff0000' } });
    const frames = await fromSharp(img, { delay: [10, 20], loop: 0 });
    expect(frames).toMatchObject({ width: 3, pageHeight: 3, pages: 2, delay: [10, 20] });
    expect(frames.data.length).toBe(3 * 6 * 4);
  });
});

describe('encodeGif', () => {
  it('round trips pages, delays and loop through decodeFrames', async () => {
    const frames = strip(256, 32, [40, 67, 120, 24], 3);
    const gif = await encodeGif(frames);
    expect(sniffImage(gif)).toBe('gif');
    const back = await decodeFrames(gif, { maxWidth: 512 });
    expect(back.pages).toBe(4);
    expect(back.delay).toEqual(frames.delay.map(toCentis));
    expect(back.loop).toBe(3);
    for (let page = 0; page < 4; page++) expect(pixelAt(back, page)).toEqual(frameColor(page));
  });

  it('encodes a single static frame as a valid GIF', async () => {
    const gif = await encodeGif(strip(256, 20, [0]));
    expect(sniffImage(gif)).toBe('gif');
    const back = await decodeFrames(gif, { maxWidth: 512 });
    expect(back.pages).toBe(1);
  });

  it('accepts encoder tuning', async () => {
    const frames = strip(256, 32, [40, 40]);
    const gif = await encodeGif(frames, { interFrameMaxError: 32, dither: 0 });
    expect(sniffImage(gif)).toBe('gif');
  });
});

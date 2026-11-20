import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  decodeFrames,
  ImagingError,
  limits,
  messages,
  sourceTooLarge,
} from '../src/features/imaging/index.js';
import { frameColor, makeGif, makeJpeg, makePng, pixelAt } from './support/images.js';

describe('decodeFrames', () => {
  it('keeps size, pages, delays and loop of an animated GIF', async () => {
    const delay = [50, 100, 150, 50, 100, 150];
    const gif = await makeGif({ width: 300, height: 200, frames: 6, delay, loop: 3 });
    const frames = await decodeFrames(gif, { maxWidth: 512 });
    expect(frames).toMatchObject({ width: 300, pageHeight: 200, pages: 6, delay, loop: 3 });
    expect(frames.data.length).toBe(300 * 200 * 6 * 4);
    for (let page = 0; page < 6; page++) {
      expect(pixelAt(frames, page, 150, 100)).toEqual(frameColor(page));
    }
  });

  it('shrinks wide input to maxWidth, keeping the aspect ratio', async () => {
    const gif = await makeGif({ width: 1000, height: 500, frames: 2, delay: 100, loop: 0 });
    const wide = await decodeFrames(gif, { maxWidth: 512 });
    expect(wide).toMatchObject({ width: 512, pageHeight: 256, pages: 2 });
    expect(wide.data.length).toBe(512 * 256 * 2 * 4);
    expect(pixelAt(wide, 1, 511, 255)).toEqual(frameColor(1));
    expect(await decodeFrames(gif, { maxWidth: 256 })).toMatchObject({
      width: 256,
      pageHeight: 128,
    });
  });

  it('enlarges small input to the minimum width', async () => {
    const frames = await decodeFrames(await makePng({ width: 32, height: 32 }), { maxWidth: 512 });
    expect(frames).toMatchObject({ width: 256, pageHeight: 256, pages: 1, delay: [0], loop: 0 });
    expect(frames.data.length).toBe(256 * 256 * 4);
  });

  it('decodes JPEG and PNG with alpha to one 4-channel frame', async () => {
    const jpeg = await decodeFrames(await makeJpeg({ width: 300, height: 100 }), { maxWidth: 512 });
    expect(jpeg).toMatchObject({ width: 300, pageHeight: 100, pages: 1, delay: [0] });
    expect(jpeg.data.length).toBe(300 * 100 * 4);

    const png = await decodeFrames(await makePng({ width: 300, height: 100, alpha: true }), {
      maxWidth: 512,
    });
    expect(png).toMatchObject({ width: 300, pageHeight: 100, pages: 1 });
    expect(png.data.length).toBe(300 * 100 * 4);
    expect(png.data[3]).toBeGreaterThan(100);
    expect(png.data[3]).toBeLessThan(155);
  });

  it('samples long animations evenly down to the frame cap, keeping total time', async () => {
    const gif = await makeGif({ width: 256, height: 16, frames: 150, delay: 20, loop: 2 });
    const frames = await decodeFrames(gif, { maxWidth: 512 });
    expect(frames.pages).toBe(100);
    expect(frames.delay).toHaveLength(100);
    expect(frames.delay.reduce((sum, d) => sum + d, 0)).toBe(3000);
    expect(frames.loop).toBe(2);
    // groups alternate 1 and 2 pages; each output frame is the first page of its group
    [0, 1, 3, 4, 6].forEach((source, page) => {
      expect(pixelAt(frames, page)).toEqual(frameColor(source));
    });
    expect(pixelAt(frames, 99)).toEqual(frameColor(148));
  });

  it('rejects a source frame over the side limit', async () => {
    const png = await makePng({ width: 5000, height: 10 });
    await expect(decodeFrames(png, { maxWidth: 512 })).rejects.toThrow(
      new ImagingError(messages.tooManyPixels),
    );
  });

  it('rejects bytes that are not an image', async () => {
    await expect(decodeFrames(randomBytes(2048), { maxWidth: 512 })).rejects.toThrow(
      new ImagingError(messages.notImage),
    );
  });

  it('rejects a truncated GIF as not an image', async () => {
    const gif = await makeGif({ width: 64, height: 64, frames: 3, delay: 100, loop: 0 });
    await expect(decodeFrames(gif.subarray(0, 40), { maxWidth: 512 })).rejects.toThrow(
      new ImagingError(messages.notImage),
    );
  });

  it('plays delays of 10 ms or less at 100 ms, as browsers do', async () => {
    const zero = await makeGif({ width: 256, height: 8, frames: 3, delay: 0, loop: 0 });
    expect((await decodeFrames(zero, { maxWidth: 512 })).delay).toEqual([100, 100, 100]);
    const fast = await makeGif({ width: 256, height: 8, frames: 3, delay: [10, 20, 0], loop: 0 });
    expect((await decodeFrames(fast, { maxWidth: 512 })).delay).toEqual([100, 20, 100]);
  });

  it('applies EXIF orientation to a still JPEG', async () => {
    // stored 40x20, left half red and right half blue; orientation 6 turns it 90 degrees clockwise
    const stored = Buffer.alloc(40 * 20 * 3);
    for (let i = 0; i < 40 * 20; i++) {
      const left = i % 40 < 20;
      stored[i * 3] = left ? 255 : 0;
      stored[i * 3 + 2] = left ? 0 : 255;
    }
    const jpeg = await sharp(stored, { raw: { width: 40, height: 20, channels: 3 } })
      .jpeg({ quality: 100 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);

    const frames = await decodeFrames(jpeg, { maxWidth: 512 });
    expect(frames).toMatchObject({ width: 256, pageHeight: 512, pages: 1 });
    const [topR, , topB] = pixelAt(frames, 0, 128, 10);
    const [bottomR, , bottomB] = pixelAt(frames, 0, 128, 500);
    expect(topR).toBeGreaterThan(200);
    expect(topB).toBeLessThan(55);
    expect(bottomR).toBeLessThan(55);
    expect(bottomB).toBeGreaterThan(200);
  });
});

describe('sourceTooLarge', () => {
  const side = limits.maxSourceSide;

  it('accepts sources inside every budget', () => {
    expect(sourceTooLarge({ width: 480, pageHeight: 270, pages: 150 })).toBe(false);
    expect(sourceTooLarge({ width: side, pageHeight: side, pages: 1 })).toBe(false);
    expect(sourceTooLarge({ width: 256, pageHeight: 256, pages: limits.maxSourcePages })).toBe(
      false,
    );
  });

  it('rejects an oversized frame or too many pages', () => {
    expect(sourceTooLarge({ width: side + 1, pageHeight: 10, pages: 1 })).toBe(true);
    expect(sourceTooLarge({ width: 10, pageHeight: side + 1, pages: 1 })).toBe(true);
    expect(sourceTooLarge({ width: 10, pageHeight: 10, pages: limits.maxSourcePages + 1 })).toBe(
      true,
    );
  });

  it('rejects many large pages that pass each per-frame check', () => {
    expect(sourceTooLarge({ width: side, pageHeight: side, pages: 15 })).toBe(true);
    expect(sourceTooLarge({ width: side, pageHeight: side, pages: limits.maxSourcePages })).toBe(
      true,
    );
    expect(sourceTooLarge({ width: 1000, pageHeight: 1000, pages: 250 })).toBe(false);
    expect(sourceTooLarge({ width: 1000, pageHeight: 1000, pages: 251 })).toBe(true);
  });

  it('throws the abort reason when the signal is aborted, not notImage', async () => {
    const gif = await makeGif({ width: 100, height: 80, frames: 3, delay: 40, loop: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(decodeFrames(gif, { maxWidth: 512, signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
  });
});

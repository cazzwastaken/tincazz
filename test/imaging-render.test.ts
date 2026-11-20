import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeFrames,
  encodeGif,
  halveFrames,
  type ImageOperation,
  ImagingError,
  messages,
  predictRungBytes,
  renderImage,
  rungPredictedOver,
  sniffImage,
} from '../src/features/imaging/index.js';
import { makeGif, makePng } from './support/images.js';

const bubble: ImageOperation = { kind: 'bubble', style: 'white', tail: 'left' };
const meme: ImageOperation = { kind: 'meme', text: 'hello there' };

/** Deterministic noisy GIF: a seeded generator fills every frame with fresh random blocks of a few colours. */
async function noisyGif(width: number, height: number, frames: number): Promise<Buffer> {
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const data = Buffer.alloc(width * height * frames * 4);
  // Random 4x4 blocks over 64 colours, fresh every frame: big output, yet quantisable quickly.
  const block = 4;
  for (let page = 0; page < frames; page++) {
    for (let by = 0; by < height; by += block) {
      for (let bx = 0; bx < width; bx += block) {
        const r = next();
        for (let y = by; y < Math.min(by + block, height); y++) {
          for (let x = bx; x < Math.min(bx + block, width); x++) {
            const o = ((page * height + y) * width + x) * 4;
            data[o] = (r & 3) * 85;
            data[o + 1] = ((r >>> 8) & 3) * 85;
            data[o + 2] = ((r >>> 16) & 3) * 85;
            data[o + 3] = 255;
          }
        }
      }
    }
  }
  return sharp(data, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
    .gif({ delay: Array.from({ length: frames }, () => 40), loop: 0, effort: 1 })
    .toBuffer();
}

describe('renderImage', () => {
  it('renders a small gif at step 0 as a gif', async () => {
    const input = await makeGif({ width: 100, height: 80, frames: 3, delay: 40, loop: 0 });
    const result = await renderImage(input, bubble);
    expect(result.step).toBe(0);
    expect(sniffImage(result.gif)).toBe('gif');
    expect(result.pages).toBe(3);
    expect(result.width).toBeGreaterThanOrEqual(256);
  });

  it('steps down the ladder when the output is over maxBytes', async () => {
    const input = await noisyGif(600, 400, 5);
    const first = await renderImage(input, bubble);
    expect(first.step).toBe(0);
    const maxBytes = first.gif.length - 1;
    const result = await renderImage(input, bubble, { maxBytes });
    expect(result.step).toBeGreaterThan(0);
    expect(result.gif.length).toBeLessThanOrEqual(maxBytes);
  }, 60_000);

  it('skips a rung predicted to stay over the limit and retries with effort 4', async () => {
    const input = await noisyGif(600, 400, 5);
    const first = await renderImage(input, bubble);
    expect(first).toMatchObject({ step: 0, width: 512 });
    // step 1 (same width) predicts 0.9 x size, still over; step 2 at 384 predicts about half
    const maxBytes = Math.floor(first.gif.length * 0.8);
    const gif = vi.spyOn(Object.getPrototypeOf(sharp()), 'gif');
    try {
      const result = await renderImage(input, bubble, { maxBytes });
      expect(result).toMatchObject({ step: 2, width: 384 });
      expect(result.gif.length).toBeLessThanOrEqual(maxBytes);
      const efforts = gif.mock.calls.map(([options]) => (options as { effort?: number }).effort);
      expect(efforts).toEqual([7, 4]);
    } finally {
      gif.mockRestore();
    }
  }, 60_000);

  it('rejects with outputTooBig when no step fits', async () => {
    const input = await makeGif({ width: 100, height: 80, frames: 3, delay: 40, loop: 0 });
    const error = await renderImage(input, bubble, { maxBytes: 100 }).catch((e) => e);
    expect(error).toBeInstanceOf(ImagingError);
    expect(error.message).toBe(messages.outputTooBig);
  });

  it('makes a meme taller than a bubble for the same input', async () => {
    const input = await makePng({ width: 300, height: 200 });
    const a = await renderImage(input, bubble);
    const b = await renderImage(input, meme);
    const heightOf = async (gif: Buffer) => (await sharp(gif).metadata()).height ?? 0;
    expect(await heightOf(b.gif)).toBeGreaterThan(await heightOf(a.gif));
  });

  it('reaches the last step for a narrow source and keeps ladder numbering', async () => {
    const input = await makeGif({ width: 100, height: 80, frames: 4, delay: 40, loop: 0 });
    const full = await renderImage(input, bubble);
    // steps 1 to 3 are predicted to stay over (and 384 and 256 repeat the 256 wide encode of a
    // narrow source), halving is predicted to fit
    const decoded = await decodeFrames(input, { maxWidth: 256 });
    const { applyBubble } = await import('../src/features/imaging/index.js');
    const processed = await applyBubble(decoded, { style: 'white', tail: 'left' });
    const halved = await encodeGif(halveFrames(processed), {
      dither: 0,
      interFrameMaxError: 32,
      effort: 4,
    });
    expect(halved.length).toBeLessThan(full.gif.length);
    const result = await renderImage(input, bubble, { maxBytes: halved.length });
    expect(result.step).toBe(4);
    expect(result.width).toBe(256);
    expect(result.pages).toBe(2);
  });

  it('rejects without encoding when the signal is already aborted', async () => {
    const input = await makeGif({ width: 100, height: 80, frames: 3, delay: 40, loop: 0 });
    const gif = vi.spyOn(Object.getPrototypeOf(sharp()), 'gif');
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(renderImage(input, bubble, { signal: controller.signal })).rejects.toBe(
        controller.signal.reason,
      );
      expect(gif).not.toHaveBeenCalled();
    } finally {
      gif.mockRestore();
    }
  });

  it('stops the ladder when aborted after step 0', async () => {
    const input = await makeGif({ width: 100, height: 80, frames: 4, delay: 40, loop: 0 });
    const controller = new AbortController();
    const proto = Object.getPrototypeOf(sharp());
    const original = proto.gif;
    const gif = vi.spyOn(proto, 'gif').mockImplementation(function (this: unknown, ...args) {
      controller.abort();
      return original.apply(this, args);
    });
    try {
      await expect(
        renderImage(input, bubble, { maxBytes: 100, signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(gif).toHaveBeenCalledTimes(1);
    } finally {
      gif.mockRestore();
    }
  });
});

describe('rung prediction', () => {
  const measured = { bytes: 20_000_000, width: 512 };

  it('scales the measured size by the width squared and halves for half the frames', () => {
    expect(predictRungBytes(measured, { width: 512 })).toBe(20_000_000);
    expect(predictRungBytes(measured, { width: 384 })).toBe(11_250_000);
    expect(predictRungBytes(measured, { width: 256 })).toBe(5_000_000);
    expect(predictRungBytes(measured, { width: 256, halve: true })).toBe(2_500_000);
  });

  it('skips a rung only when 0.9 of its prediction is still over the limit', () => {
    const max = 10 * 1024 ** 2;
    expect(rungPredictedOver(measured, { width: 512 }, max)).toBe(true);
    expect(rungPredictedOver(measured, { width: 384 }, max)).toBe(false);
    // 0.9 x 11.25 MB = 10.125 MB: over a 10 MB limit, not over 10.2 MB
    expect(rungPredictedOver(measured, { width: 384 }, 10_000_000)).toBe(true);
    expect(rungPredictedOver(measured, { width: 384 }, 10_200_000)).toBe(false);
    expect(rungPredictedOver({ bytes: 11_000_000, width: 512 }, { width: 512 }, 10_000_000)).toBe(
      false,
    );
  });
});

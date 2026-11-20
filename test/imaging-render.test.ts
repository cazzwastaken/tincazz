import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  type ImageOperation,
  ImagingError,
  messages,
  renderImage,
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
});

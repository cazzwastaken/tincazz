import { describe, expect, it } from 'vitest';
import {
  applyCaption,
  captionLayout,
  decodeFrames,
  type Frames,
  ImagingError,
  messages,
  renderCaptionText,
} from '../src/features/imaging/index.js';
import { frameColor, makePng } from './support/images.js';

function strip(width: number, height: number, pages: number): Frames {
  const data = Buffer.alloc(width * height * pages * 4);
  for (let page = 0; page < pages; page++) {
    const [r, g, b] = frameColor(page + 1);
    for (let i = page * width * height * 4; i < (page + 1) * width * height * 4; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return {
    data,
    width,
    pageHeight: height,
    pages,
    delay: Array.from({ length: pages }, (_, i) => 40 + i * 10),
    loop: 3,
  };
}

const px = (f: Frames, page: number, x: number, y: number): number[] => {
  const o = ((page * f.pageHeight + y) * f.width + x) * 4;
  return [f.data[o] ?? -1, f.data[o + 1] ?? -1, f.data[o + 2] ?? -1, f.data[o + 3] ?? -1];
};

function hasDarkPixel(f: Frames, page: number, rows: number): boolean {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < f.width; x++) {
      if (
        px(f, page, x, y)
          .slice(0, 3)
          .every((c) => c < 64)
      )
        return true;
    }
  }
  return false;
}

const barOf = (input: Frames, out: Frames) => out.pageHeight - input.pageHeight;

describe('captionLayout', () => {
  it('scales with the width within 16..64 and pads by half the size', () => {
    expect(captionLayout(256)).toEqual({ size: 26, padding: 13 });
    expect(captionLayout(50)).toEqual({ size: 16, padding: 8 });
    expect(captionLayout(5000)).toEqual({ size: 64, padding: 32 });
  });
});

describe('renderCaptionText', () => {
  it('renders raw RGBA that fits the width', async () => {
    const t = await renderCaptionText('hello', 300, 30);
    expect(t.data.length).toBe(t.width * t.height * 4);
    expect(t.width).toBeLessThanOrEqual(300 - 30);
  });
});

describe('applyCaption', () => {
  it('adds a white bar with dark text above every frame', async () => {
    const input = strip(300, 200, 3);
    const out = await applyCaption(input, 'when the code works');
    const bar = barOf(input, out);
    const { padding } = captionLayout(300);
    expect(bar).toBeGreaterThan(2 * padding);
    expect(out.width).toBe(300);
    for (let page = 0; page < 3; page++) {
      expect(px(out, page, 0, 1)).toEqual([255, 255, 255, 255]);
      expect(hasDarkPixel(out, page, bar)).toBe(true);
      const [r, g, b] = frameColor(page + 1);
      expect(px(out, page, 150, bar + 100)).toEqual([r, g, b, 255]);
    }
  });

  it('keeps pages, delays and loop', async () => {
    const input = strip(300, 200, 3);
    const out = await applyCaption(input, 'hi');
    expect([out.pages, out.delay, out.loop]).toEqual([3, input.delay, 3]);
  });

  it('escapes markup instead of interpreting it', async () => {
    const input = strip(300, 200, 1);
    const plain = barOf(input, await applyCaption(input, 'x'));
    const out = await applyCaption(input, '<span size="99999">x</span> & y');
    expect(barOf(input, out)).toBeLessThan(plain * 3);
  });

  it('rejects text that cannot fit even at the smallest size', async () => {
    await expect(applyCaption(strip(256, 64, 1), 'word '.repeat(160))).rejects.toThrow(
      new ImagingError(messages.captionTooLong),
    );
  });

  it('captions a small decoded image', async () => {
    const frames = await decodeFrames(await makePng({ width: 32, height: 32 }), { maxWidth: 256 });
    expect(frames.width).toBe(256);
    expect(captionLayout(frames.width).size).toBe(26);
    const out = await applyCaption(frames, 'tiny');
    expect(out.pageHeight).toBeGreaterThan(frames.pageHeight);
  });

  it('renders emoji', async () => {
    const input = strip(300, 200, 1);
    const out = await applyCaption(input, '😂');
    expect(barOf(input, out)).toBeGreaterThan(0);
    // Noto Emoji renders in colour here, so look for ink rather than black pixels.
    const bar = barOf(input, out);
    let ink = 0;
    for (let y = 0; y < bar; y++) {
      for (let x = 0; x < out.width; x++) {
        if (px(out, 0, x, y).some((c) => c < 200)) ink++;
      }
    }
    expect(ink).toBeGreaterThan(100);
  });
});

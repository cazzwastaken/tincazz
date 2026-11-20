import { describe, expect, it } from 'vitest';
import {
  applyBubble,
  bubbleGeometry,
  type Frames,
  type TailSide,
} from '../src/features/imaging/index.js';
import { frameColor } from './support/images.js';

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

const px = (f: Frames, page: number, x: number, y: number) => {
  const o = ((page * f.pageHeight + y) * f.width + x) * 4;
  return [f.data[o], f.data[o + 1], f.data[o + 2], f.data[o + 3]];
};

const W = 300;
const H = 200;

// A point inside the left tail triangle, halfway down it (centred between its two edges).
function tailPoint() {
  const g = bubbleGeometry(W, H);
  const y = Math.round((g.edgeY + g.tipY) / 2) - 2;
  const t = (y - g.edgeY) / (g.tipY - g.edgeY);
  const from = g.tailBaseFrom + (g.tipX - g.tailBaseFrom) * t;
  const to = g.tailBaseTo + (g.tipX - g.tailBaseTo) * t;
  return { x: Math.round((from + to) / 2), y };
}

describe('bubbleGeometry', () => {
  it('is bound by the width on a tall frame and the height on a wide one', () => {
    expect(bubbleGeometry(200, 800).curveY).toBe(40);
    expect(bubbleGeometry(800, 100).curveY).toBe(20);
  });

  it('follows the pinned proportions', () => {
    expect(bubbleGeometry(W, H)).toEqual({
      curveY: 40,
      edgeY: 22,
      tailBaseFrom: 75,
      tailBaseTo: 105,
      tipX: 66,
      tipY: 80,
    });
  });
});

describe('applyBubble', () => {
  for (const tail of ['left', 'right'] as TailSide[]) {
    it(`cuts a transparent bubble with the tail on the ${tail}`, async () => {
      const out = await applyBubble(strip(W, H, 3), { style: 'transparent', tail });
      const { x, y } = tailPoint();
      const cut = tail === 'left' ? x : W - x;
      const kept = tail === 'left' ? W - x : x;
      for (let page = 0; page < 3; page++) {
        expect(px(out, page, 150, 2)[3]).toBe(0);
        expect(px(out, page, 150, 190)[3]).toBe(255);
        expect(px(out, page, cut, y)[3]).toBe(0);
        expect(px(out, page, kept, y)[3]).toBe(255);
      }
    });
  }

  it('paints a white bubble on every frame', async () => {
    const out = await applyBubble(strip(W, H, 3), { style: 'white', tail: 'left' });
    for (let page = 0; page < 3; page++) {
      expect(px(out, page, 150, 2)).toEqual([255, 255, 255, 255]);
    }
  });

  it('keeps pages, delays, loop and size', async () => {
    const input = strip(W, H, 3);
    const out = await applyBubble(input, { style: 'transparent', tail: 'left' });
    expect([out.width, out.pageHeight, out.pages, out.delay, out.loop]).toEqual([
      W,
      H,
      3,
      input.delay,
      3,
    ]);
  });
});

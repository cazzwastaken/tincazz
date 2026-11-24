import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  type DiceTint,
  type DieFace,
  diceImageSize,
  renderDice,
} from '../src/features/dice/index.js';

const faces: DieFace[] = [1, 2, 3, 4, 5, 6, 'unknown'];
const tints: DiceTint[] = ['rolling', 'win', 'loss'];

/** Raw RGBA pixels of a rendering. */
async function pixels(tint: DiceTint) {
  const { data } = await sharp(await renderDice(1, 1, tint))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return (x: number, y: number) => {
    const i = (y * diceImageSize.width + x) * 4;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0] as const;
  };
}

describe('renderDice', () => {
  it.each(tints)(
    'draws every face on both sides in the %s tint as a PNG of the fixed size',
    async (tint) => {
      for (const face of faces) {
        for (const png of [await renderDice(face, 3, tint), await renderDice(2, face, tint)]) {
          const meta = await sharp(png).metadata();
          expect(meta.format).toBe('png');
          expect([meta.width, meta.height]).toEqual([diceImageSize.width, diceImageSize.height]);
          expect(png.length).toBeLessThan(60_000);
        }
      }
    },
  );

  it('gives every face and tint its own picture', async () => {
    const seen = new Set<string>();
    for (const tint of tints) {
      for (const face of faces) {
        seen.add((await renderDice(face, 1, tint)).toString('base64'));
      }
    }
    expect(seen.size).toBe(faces.length * tints.length);
  });

  it('is cached: the same buffer comes back', async () => {
    expect(await renderDice(5, 2, 'win')).toBe(await renderDice(5, 2, 'win'));
  });

  it('tints a win green with a gold edge and a loss red', async () => {
    const win = await pixels('win');
    // The body near a corner of the left die, away from the pips, and its edge on the left side.
    expect(win(90, 90)[1]).toBeGreaterThan(win(90, 90)[0]);
    expect(win(38, 212)[0]).toBeGreaterThan(200);
    expect(win(38, 212)[2]).toBeLessThan(60);
    const loss = await pixels('loss');
    expect(loss(90, 90)[0]).toBeGreaterThan(loss(90, 90)[1]);
  });

  it('draws on a transparent background', async () => {
    expect((await pixels('rolling'))(0, 0)[3]).toBe(0);
  });
});

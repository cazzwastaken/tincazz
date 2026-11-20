import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Frames, halveFrames, sampleGroups } from '../src/features/imaging/index.js';

describe('sampleGroups (property)', () => {
  it('covers every page once, in order, in min(total, cap) near-equal groups', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 200 }),
        (total, cap) => {
          const groups = sampleGroups(total, cap);
          expect(groups).toHaveLength(Math.min(total, cap));
          expect(groups.flat()).toEqual(Array.from({ length: total }, (_, i) => i));
          const sizes = groups.map((group) => group.length);
          expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1);
          expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

describe('halveFrames (property)', () => {
  it('keeps total time and size, and halves the page count rounding up', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 60 }),
        (delay) => {
          const frames: Frames = {
            data: Buffer.alloc(2 * 2 * 4 * delay.length),
            width: 2,
            pageHeight: 2,
            pages: delay.length,
            delay,
            loop: 0,
          };
          const halved = halveFrames(frames);
          const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
          expect(halved.pages).toBe(Math.ceil(delay.length / 2));
          expect(halved.delay).toHaveLength(halved.pages);
          expect(sum(halved.delay)).toBe(sum(delay));
          expect(halved.data.length).toBe(2 * 2 * 4 * halved.pages);
        },
      ),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { spinFrames } from '../src/features/gamba/index.js';

const json = (value: unknown) => JSON.stringify(value);

describe('spinFrames', () => {
  it('gives two reel frames with no buttons and no result', () => {
    const frames = spinFrames('1', 250);
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      const text = json(frame);
      expect(text).toContain('spinning');
      expect(text).toContain('Bet 250');
      expect(text).not.toContain('gamba:');
      expect(text).not.toContain('balance');
    }
  });
});

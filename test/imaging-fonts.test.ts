import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  captionFont,
  captionFontFile,
  emojiFontFile,
  ensureFonts,
  messageFont,
  messageFontFiles,
} from '../src/features/imaging/index.js';

describe('imaging fonts', () => {
  it('font files exist', () => {
    expect(existsSync(captionFontFile)).toBe(true);
    expect(existsSync(emojiFontFile)).toBe(true);
    for (const file of messageFontFiles) expect(existsSync(file)).toBe(true);
  });

  it('messageFont falls back to Noto Emoji too', () => {
    expect(messageFont(16)).toBe('Noto Sans, Noto Emoji 16');
  });

  it('captionFont uses the comma form', () => {
    expect(captionFont(40)).toBe('Barlow Condensed, Noto Emoji, Black 40');
  });

  it('renders caption text with the bundled font', async () => {
    await ensureFonts();
    const { info } = await sharp({
      text: {
        text: 'HELLO',
        font: captionFont(40),
        fontfile: captionFontFile,
        rgba: true,
        dpi: 72,
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    expect(info.height).toBeGreaterThan(20);
    expect(info.height).toBeLessThan(70);
    expect(info.width).toBeGreaterThan(60);
  });

  it('ensureFonts is idempotent', () => {
    expect(ensureFonts()).toBe(ensureFonts());
  });
});

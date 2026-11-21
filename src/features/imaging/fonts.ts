import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const captionFontFile = fileURLToPath(
  new URL('../../../assets/fonts/BarlowCondensed-Black.ttf', import.meta.url),
);
export const emojiFontFile = fileURLToPath(
  new URL('../../../assets/fonts/NotoEmoji.ttf', import.meta.url),
);
/** Noto Sans for message screenshots: the regular face for text, semibold for names. */
export const messageFontFiles = [
  fileURLToPath(new URL('../../../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
  fileURLToPath(new URL('../../../assets/fonts/NotoSans-SemiBold.ttf', import.meta.url)),
] as const;

/** Pango font description: the comma form falls back to Noto Emoji for emoji glyphs. */
export function captionFont(sizePx: number): string {
  return `Barlow Condensed, Noto Emoji, Black ${sizePx}`;
}

/** Pango font description of message text, with the same emoji fallback. */
export function messageFont(sizePx: number): string {
  return `Noto Sans, Noto Emoji ${sizePx}`;
}

let fontsReady: Promise<void> | undefined;

/**
 * Renders a throwaway glyph with each extra font file once, so fontconfig registers Noto Emoji
 * (the fallback of every caption) and the message fonts for later renders.
 */
export function ensureFonts(): Promise<void> {
  fontsReady ??= (async () => {
    for (const fontfile of [emojiFontFile, ...messageFontFiles]) {
      await sharp({ text: { text: '😀', fontfile, rgba: true, dpi: 72 } })
        .png()
        .toBuffer();
    }
  })();
  return fontsReady;
}

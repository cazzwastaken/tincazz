import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const captionFontFile = fileURLToPath(
  new URL('../../../assets/fonts/BarlowCondensed-Black.ttf', import.meta.url),
);
export const emojiFontFile = fileURLToPath(
  new URL('../../../assets/fonts/NotoEmoji.ttf', import.meta.url),
);

/** Pango font description: the comma form falls back to Noto Emoji for emoji glyphs. */
export function captionFont(sizePx: number): string {
  return `Barlow Condensed, Noto Emoji, Black ${sizePx}`;
}

let fontsReady: Promise<void> | undefined;

/** Renders a throwaway emoji once so fontconfig registers Noto Emoji for later captions. */
export function ensureFonts(): Promise<void> {
  fontsReady ??= sharp({
    text: { text: '😀', fontfile: emojiFontFile, rgba: true, dpi: 72 },
  })
    .png()
    .toBuffer()
    .then(() => undefined);
  return fontsReady;
}

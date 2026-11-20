import sharp from 'sharp';
import { ImagingError, messages } from './errors.js';
import { captionFont, captionFontFile, ensureFonts } from './fonts.js';
import { type Frames, fromSharp, toSharp } from './frames.js';
import { escapeMarkup } from './text.js';

const minSize = 12;

/** Font size and bar padding in pixels for a frame of `width`. */
export function captionLayout(width: number): { size: number; padding: number } {
  const size = Math.min(64, Math.max(16, Math.round(width / 10)));
  return { size, padding: Math.round(size / 2) };
}

/** Raw RGBA of black, centred, word-wrapped text. Takes sanitised text that is not yet escaped. */
export async function renderCaptionText(
  text: string,
  width: number,
  size: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  const padding = Math.round(size / 2);
  const { data, info } = await sharp({
    text: {
      text: `<span foreground="black">${escapeMarkup(text)}</span>`,
      font: captionFont(size),
      fontfile: captionFontFile,
      width: width - 2 * padding,
      align: 'centre',
      wrap: 'word-char',
      rgba: true,
      dpi: 72,
    },
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Adds a white bar with the caption above every frame. */
export async function applyCaption(frames: Frames, text: string): Promise<Frames> {
  await ensureFonts();

  let size = captionLayout(frames.width).size;
  let rendered = await renderCaptionText(text, frames.width, size);
  while (rendered.height > frames.pageHeight) {
    size = Math.floor(size * 0.85);
    if (size < minSize) throw new ImagingError(messages.captionTooLong);
    rendered = await renderCaptionText(text, frames.width, size);
  }

  const padding = Math.round(size / 2);
  const barHeight = rendered.height + 2 * padding;
  const rowBytes = frames.width * 4;
  const frameBytes = rowBytes * frames.pageHeight;
  const barBytes = rowBytes * barHeight;
  const data = Buffer.alloc((barBytes + frameBytes) * frames.pages);
  for (let page = 0; page < frames.pages; page++) {
    const start = page * (barBytes + frameBytes);
    data.fill(255, start, start + barBytes);
    frames.data.copy(data, start + barBytes, page * frameBytes, (page + 1) * frameBytes);
  }

  const pageHeight = frames.pageHeight + barHeight;
  const overlay = await sharp({
    create: {
      width: frames.width,
      height: pageHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: rendered.data,
        raw: { width: rendered.width, height: rendered.height, channels: 4 },
        top: padding,
        left: Math.max(0, Math.round((frames.width - rendered.width) / 2)),
      },
    ])
    .png()
    .toBuffer();

  const img = toSharp({ ...frames, data, pageHeight }).composite([
    { input: overlay, tile: true, gravity: 'northwest' },
  ]);
  return fromSharp(img, frames);
}

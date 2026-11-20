import sharp from 'sharp';
import { limits } from './config.js';
import { ImagingError, messages } from './errors.js';
import { type Frames, sampleGroups } from './frames.js';

/** Source pages decoded per sharp call: bounds memory on long animations. */
const chunkPages = 25;
/** GIF players treat a missing delay as about this long. */
const defaultDelayMs = 100;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Decode an image or animation into a strip at the working width (enlarged to `limits.minWidth`,
 * shrunk to `maxWidth`). Animations over the frame cap are sampled evenly: each kept frame stands
 * for a run of consecutive pages and gets their summed delay, so the total time is kept.
 */
export async function decodeFrames(input: Buffer, options: { maxWidth: number }): Promise<Frames> {
  try {
    return await decode(input, options.maxWidth);
  } catch (error) {
    if (error instanceof ImagingError) throw error;
    throw new ImagingError(messages.notImage);
  }
}

async function decode(input: Buffer, maxWidth: number): Promise<Frames> {
  const head = await sharp(input).metadata();
  const srcWidth = head.width;
  const srcPageHeight = head.pageHeight ?? head.height;
  const total = head.pages ?? 1;
  if (!srcWidth || !srcPageHeight) throw new ImagingError(messages.notImage);
  if (
    srcWidth > limits.maxSourceSide ||
    srcPageHeight > limits.maxSourceSide ||
    total > limits.maxSourcePages
  ) {
    throw new ImagingError(messages.tooManyPixels);
  }

  const width = clamp(srcWidth, limits.minWidth, maxWidth);
  const pageHeight = Math.max(1, Math.round((srcPageHeight * width) / srcWidth));
  const cap = Math.min(limits.maxFrames, Math.floor(limits.maxStripPixels / (width * pageHeight)));
  if (cap < 1) throw new ImagingError(messages.tooManyPixels);

  const groups = sampleGroups(total, cap);
  const frameBytes = width * pageHeight * 4;
  const data = Buffer.alloc(frameBytes * groups.length);
  const delay =
    total > 1
      ? groups.map((group) =>
          group.reduce((sum, page) => sum + (head.delay?.[page] ?? defaultDelayMs), 0),
        )
      : [0];

  // Output frame i is the first page of group i. Walk the source in chunks and copy those pages.
  let next = 0;
  for (let start = 0; start < total && next < groups.length; start += chunkPages) {
    const count = Math.min(chunkPages, total - start);
    const { data: chunk, info } = await sharp(input, {
      page: start,
      pages: count,
      limitInputPixels: limits.maxSourceSide ** 2 * chunkPages,
    })
      .resize({ width, height: pageHeight, fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== pageHeight * count || info.channels !== 4) {
      throw new Error(`unexpected decoded size ${info.width}x${info.height}x${info.channels}`);
    }
    for (; next < groups.length; next++) {
      const page = groups[next]?.[0] ?? total;
      if (page >= start + count) break;
      const offset = (page - start) * frameBytes;
      chunk.copy(data, next * frameBytes, offset, offset + frameBytes);
    }
  }

  return { data, width, pageHeight, pages: groups.length, delay, loop: head.loop ?? 0 };
}

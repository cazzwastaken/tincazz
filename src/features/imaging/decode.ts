import sharp, { type Metadata } from 'sharp';
import { limits } from './config.js';
import { ImagingError, messages } from './errors.js';
import { type Frames, sampleGroups } from './frames.js';

/** Source pages decoded per sharp call: bounds memory on long animations. */
const chunkPages = 25;
/** Browsers and Discord play a missing delay, or one of 10 ms or less, at this speed. */
const defaultDelayMs = 100;
const playedDelay = (ms: number | undefined) =>
  ms === undefined || ms <= 10 ? defaultDelayMs : ms;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Decode an image or animation into a strip at the working width (enlarged to `limits.minWidth`,
 * shrunk to `maxWidth`). An aborted `signal` stops the decode between chunks and throws its reason. Animations over the frame cap are sampled evenly: each kept frame stands
 * for a run of consecutive pages and gets their summed delay, so the total time is kept.
 */
export async function decodeFrames(
  input: Buffer,
  options: { maxWidth: number; signal?: AbortSignal },
): Promise<Frames> {
  try {
    return await decode(input, options.maxWidth, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof ImagingError) throw error;
    throw new ImagingError(messages.notImage);
  }
}

/** Source size from the header probe: a single page is measured after EXIF orientation. */
function sourceSize(head: Metadata) {
  const pages = head.pages ?? 1;
  if (pages === 1) {
    return { width: head.autoOrient.width, pageHeight: head.autoOrient.height, pages };
  }
  return { width: head.width, pageHeight: head.pageHeight ?? head.height, pages };
}

/** Whether a probed source is over the per-frame, page count or total decode budget. */
export function sourceTooLarge(source: { width: number; pageHeight: number; pages: number }) {
  return (
    source.width > limits.maxSourceSide ||
    source.pageHeight > limits.maxSourceSide ||
    source.pages > limits.maxSourcePages ||
    source.width * source.pageHeight * source.pages > limits.maxSourcePixels
  );
}

async function decode(input: Buffer, maxWidth: number, signal?: AbortSignal): Promise<Frames> {
  signal?.throwIfAborted();
  const head = await sharp(input).metadata();
  const source = sourceSize(head);
  const { width: srcWidth, pageHeight: srcPageHeight, pages: total } = source;
  if (!srcWidth || !srcPageHeight) throw new ImagingError(messages.notImage);
  if (sourceTooLarge(source)) throw new ImagingError(messages.tooManyPixels);

  const width = clamp(srcWidth, limits.minWidth, maxWidth);
  const pageHeight = Math.max(1, Math.round((srcPageHeight * width) / srcWidth));
  const cap = Math.min(limits.maxFrames, Math.floor(limits.maxStripPixels / (width * pageHeight)));
  if (cap < 1) throw new ImagingError(messages.tooManyPixels);

  const groups = sampleGroups(total, cap);
  const frameBytes = width * pageHeight * 4;
  const data = Buffer.alloc(frameBytes * groups.length);
  const delay =
    total > 1
      ? groups.map((group) => group.reduce((sum, page) => sum + playedDelay(head.delay?.[page]), 0))
      : [0];

  // Output frame i is the first page of group i. Walk the source in chunks and copy those pages.
  let next = 0;
  for (let start = 0; start < total && next < groups.length; start += chunkPages) {
    signal?.throwIfAborted();
    const count = Math.min(chunkPages, total - start);
    const { data: chunk, info } = await sharp(input, {
      page: start,
      pages: count,
      limitInputPixels: limits.maxSourceSide ** 2 * chunkPages,
      // EXIF orientation only applies to a single still image
      autoOrient: total === 1,
    })
      .timeout({ seconds: limits.jobTimeoutMs / 1000 })
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

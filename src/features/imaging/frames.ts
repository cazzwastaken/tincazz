import sharp, { type Sharp } from 'sharp';

/**
 * Decoded frames as one raw RGBA strip: `pages` frames of `width` x `pageHeight` stacked top to
 * bottom. A static image is one frame with delay `[0]`.
 */
export interface Frames {
  data: Buffer;
  width: number;
  pageHeight: number;
  pages: number;
  /** milliseconds per frame, one entry per page */
  delay: number[];
  /** 0 loops forever */
  loop: number;
}

/**
 * Split pages `0..total-1` into `min(total, cap)` consecutive groups whose sizes differ by at most
 * one, spread evenly so the kept frames sample the whole animation.
 */
export function sampleGroups(total: number, cap: number): number[][] {
  const count = Math.min(total, cap);
  const groups: number[][] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * total) / count);
    const end = Math.floor(((i + 1) * total) / count);
    groups.push(Array.from({ length: end - start }, (_, k) => start + k));
  }
  return groups;
}

/** The strip as a sharp raw input that knows its page height. */
export function toSharp(frames: Frames): Sharp {
  return sharp(frames.data, {
    raw: {
      width: frames.width,
      height: frames.pageHeight * frames.pages,
      channels: 4,
      pageHeight: frames.pageHeight,
    },
  });
}

/** Render `img` to a 4-channel strip of `meta.delay.length` pages. */
export async function fromSharp(img: Sharp, meta: Pick<Frames, 'delay' | 'loop'>): Promise<Frames> {
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pages = meta.delay.length;
  return {
    data,
    width: info.width,
    pageHeight: info.height / pages,
    pages,
    delay: [...meta.delay],
    loop: meta.loop,
  };
}

/** Halve the frame count: keep the first frame of each pair and give it both delays. */
export function halveFrames(frames: Frames): Frames {
  const pages = Math.ceil(frames.pages / 2);
  const frameBytes = frames.width * frames.pageHeight * 4;
  const data = Buffer.alloc(frameBytes * pages);
  const delay: number[] = [];
  for (let page = 0; page < pages; page++) {
    const source = page * 2;
    frames.data.copy(data, page * frameBytes, source * frameBytes, (source + 1) * frameBytes);
    delay.push((frames.delay[source] ?? 0) + (frames.delay[source + 1] ?? 0));
  }
  return { ...frames, data, pages, delay };
}

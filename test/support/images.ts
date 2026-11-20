import sharp from 'sharp';

export type Rgb = [number, number, number];

/**
 * A flat colour per frame index, distinct for the first 216 frames, so tests can tell frames apart
 * after a round trip. Channels step by 51, far enough apart to survive GIF quantisation.
 */
export function frameColor(index: number): Rgb {
  const i = index % 216;
  return [(i % 6) * 51, (Math.floor(i / 6) % 6) * 51, Math.floor(i / 36) * 51];
}

export interface GifSpec {
  width: number;
  height: number;
  frames: number;
  /** ms per frame; one value per frame, or one value for all of them */
  delay: number[] | number;
  /** 0 is infinite */
  loop: number;
  colors?: Rgb[];
}

/** An animated GIF, each frame filled with one flat colour (`colors[i]` or `frameColor(i)`). */
export function makeGif({ width, height, frames, delay, loop, colors }: GifSpec): Promise<Buffer> {
  const frameBytes = width * height * 4;
  const data = Buffer.alloc(frameBytes * frames);
  for (let page = 0; page < frames; page++) {
    const [r, g, b] = colors?.[page] ?? frameColor(page);
    for (let offset = page * frameBytes; offset < (page + 1) * frameBytes; offset += 4) {
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  const delays = Array.isArray(delay) ? delay : Array.from({ length: frames }, () => delay);
  return sharp(data, { raw: { width, height: height * frames, channels: 4, pageHeight: height } })
    .gif({ delay: delays, loop })
    .toBuffer();
}

export function makePng({
  width,
  height,
  alpha = false,
}: {
  width: number;
  height: number;
  alpha?: boolean;
}): Promise<Buffer> {
  return sharp({
    create: alpha
      ? { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } }
      : { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
}

export function makeJpeg({ width, height }: { width: number; height: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
}

/** The RGB of a pixel in frame `page` of a 4-channel strip. */
export function pixelAt(
  frames: { data: Buffer; width: number; pageHeight: number },
  page: number,
  x = 0,
  y = 0,
): Rgb {
  const offset = ((page * frames.pageHeight + y) * frames.width + x) * 4;
  return [frames.data[offset] ?? -1, frames.data[offset + 1] ?? -1, frames.data[offset + 2] ?? -1];
}

/** Round a GIF delay to its stored centisecond precision (libvips rounds ties to even, so avoid 5 ms ties). */
export const toCentis = (ms: number) => Math.round(ms / 10) * 10;

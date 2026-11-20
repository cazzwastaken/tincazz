import { limits } from './config.js';
import { ImagingError, messages } from './errors.js';
import { type Frames, toSharp } from './frames.js';

/** Encoder knobs the size ladder turns to make the output smaller. */
export interface GifTuning {
  interFrameMaxError?: number;
  dither?: number;
  effort?: number;
}

/**
 * Encode the strip as a GIF, keeping delays and loop. A single static frame carries no delay. A
 * frame over the GIF format's 16 bit sides is reported as too many pixels.
 */
export async function encodeGif(frames: Frames, tuning: GifTuning = {}): Promise<Buffer> {
  try {
    return await toSharp(frames)
      .gif({
        loop: frames.loop,
        ...(frames.pages > 1 ? { delay: frames.delay } : {}),
        effort: 7,
        ...tuning,
      })
      .timeout({ seconds: limits.jobTimeoutMs / 1000 })
      .toBuffer();
  } catch (error) {
    if (error instanceof Error && error.message.includes('too large for the GIF format')) {
      throw new ImagingError(messages.tooManyPixels);
    }
    throw error;
  }
}

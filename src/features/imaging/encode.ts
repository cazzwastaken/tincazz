import { limits } from './config.js';
import { type Frames, toSharp } from './frames.js';

/** Encoder knobs the size ladder turns to make the output smaller. */
export interface GifTuning {
  interFrameMaxError?: number;
  dither?: number;
}

/** Encode the strip as a GIF, keeping delays and loop. A single static frame carries no delay. */
export function encodeGif(frames: Frames, tuning: GifTuning = {}): Promise<Buffer> {
  return toSharp(frames)
    .gif({
      loop: frames.loop,
      ...(frames.pages > 1 ? { delay: frames.delay } : {}),
      effort: 7,
      ...tuning,
    })
    .timeout({ seconds: limits.jobTimeoutMs / 1000 })
    .toBuffer();
}

import type { BubbleStyle, TailSide } from './args.js';
import { applyBubble } from './bubble.js';
import { applyCaption } from './caption.js';
import { limits } from './config.js';
import { decodeFrames } from './decode.js';
import { encodeGif, type GifTuning } from './encode.js';
import { ImagingError, messages } from './errors.js';
import { type Frames, halveFrames } from './frames.js';

export type ImageOperation =
  | { kind: 'bubble'; style: BubbleStyle; tail: TailSide }
  | { kind: 'caption'; text: string };

export interface RenderResult {
  gif: Buffer;
  width: number;
  pages: number;
  /** index of the ladder step that produced the result */
  step: number;
}

interface LadderStep {
  maxWidth: number;
  tuning?: GifTuning;
  halve?: boolean;
}

/** Retry rungs also encode at a lower effort: they must fit the job timeout after a failed try. */
const squeezed: GifTuning = { dither: 0, interFrameMaxError: 32, effort: 4 };

/** Predictions may be this much too high before a rung is skipped (squeezing shrinks it more). */
const predictionSafety = 0.9;

/** Size of an encode that went over the limit, the base for predicting later rungs. */
export interface MeasuredEncode {
  bytes: number;
  width: number;
}

/** Bytes a rung is expected to produce: scaled by its width squared and halved for half the frames. */
export function predictRungBytes(
  measured: MeasuredEncode,
  rung: { width: number; halve?: boolean },
): number {
  return measured.bytes * (rung.width / measured.width) ** 2 * (rung.halve ? 0.5 : 1);
}

/** Whether a rung is still over `maxBytes` even if its prediction is 10% too high. */
export function rungPredictedOver(
  measured: MeasuredEncode,
  rung: { width: number; halve?: boolean },
  maxBytes: number,
): boolean {
  return predictRungBytes(measured, rung) * predictionSafety > maxBytes;
}

/**
 * From best quality to smallest output; the first step that fits the byte limit wins. After an
 * encode over the limit, rungs predicted to stay over it are skipped without decoding.
 */
const ladder: readonly LadderStep[] = [
  { maxWidth: 512 },
  { maxWidth: 512, tuning: squeezed },
  { maxWidth: 384, tuning: squeezed },
  { maxWidth: 256, tuning: squeezed },
  { maxWidth: 256, tuning: squeezed, halve: true },
];

function operate(frames: Frames, op: ImageOperation): Promise<Frames> {
  return op.kind === 'bubble'
    ? applyBubble(frames, { style: op.style, tail: op.tail })
    : applyCaption(frames, op.text);
}

/**
 * Decode, apply the operation and encode, walking the size ladder until the GIF fits `maxBytes`.
 * The decode and operation run once per distinct working width and only that width's frames are
 * kept. An aborted `signal` is checked before every decode and encode, so a timed out job stops
 * at the next step instead of running the whole ladder. Steps keep their ladder index even when
 * earlier ones are skipped.
 */
export async function renderImage(
  input: Buffer,
  op: ImageOperation,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<RenderResult> {
  const { signal } = options;
  const maxBytes = options.maxBytes ?? limits.outputBytes;
  let frames: Frames | undefined;
  let frameMaxWidth = 0;
  let encodedWidth = 0;
  let measured: MeasuredEncode | undefined;
  for (const [step, rung] of ladder.entries()) {
    // A source narrower than the rung keeps its measured width.
    const width = Math.min(rung.maxWidth, measured?.width ?? rung.maxWidth);
    if (measured && rungPredictedOver(measured, { width, halve: rung.halve }, maxBytes)) continue;
    if (rung.maxWidth !== frameMaxWidth) {
      frames = undefined; // drop the previous width's buffers before building the next
      const decoded = await decodeFrames(input, { maxWidth: rung.maxWidth, signal });
      // Decoding clamps up to the minimum width, so a narrow source can land on the width it
      // already encoded at: a new width step that resulted in the same width cannot shrink the
      // output unless it halves the frames, skip it.
      frames = await operate(decoded, op);
      frameMaxWidth = rung.maxWidth;
      if (frames.width === encodedWidth && !rung.halve) continue;
    }
    if (frames === undefined) continue;
    signal?.throwIfAborted();
    const current = rung.halve ? halveFrames(frames) : frames;
    const gif = await encodeGif(current, rung.tuning);
    encodedWidth = current.width;
    if (gif.length <= maxBytes) {
      return { gif, width: current.width, pages: current.pages, step };
    }
    measured = { bytes: gif.length, width: current.width };
  }
  signal?.throwIfAborted();
  throw new ImagingError(messages.outputTooBig);
}

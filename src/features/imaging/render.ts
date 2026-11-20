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
  | { kind: 'meme'; text: string };

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

const squeezed: GifTuning = { dither: 0, interFrameMaxError: 32 };

/** From best quality to smallest output; the first step that fits the byte limit wins. */
const ladder: readonly LadderStep[] = [
  { maxWidth: 512 },
  { maxWidth: 512, tuning: { interFrameMaxError: 16 } },
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
 * kept; the last step halves the already processed 256 wide frames.
 */
export async function renderImage(
  input: Buffer,
  op: ImageOperation,
  options: { maxBytes?: number } = {},
): Promise<RenderResult> {
  const maxBytes = options.maxBytes ?? limits.outputBytes;
  let frames: Frames | undefined;
  let frameMaxWidth = 0;
  let encodedWidth = 0;
  for (const [step, rung] of ladder.entries()) {
    if (rung.maxWidth !== frameMaxWidth) {
      frames = undefined; // drop the previous width's buffers before building the next
      const decoded = await decodeFrames(input, { maxWidth: rung.maxWidth });
      // Decoding clamps up to the minimum width, so a narrow source can land on the width it
      // already encoded at: a new width step that resulted in the same width cannot shrink the
      // output, skip it.
      frames = await operate(decoded, op);
      frameMaxWidth = rung.maxWidth;
      if (frames.width === encodedWidth) continue;
    }
    if (frames === undefined) continue;
    const current = rung.halve ? halveFrames(frames) : frames;
    const gif = await encodeGif(current, rung.tuning);
    encodedWidth = current.width;
    if (gif.length <= maxBytes) {
      return { gif, width: current.width, pages: current.pages, step };
    }
  }
  throw new ImagingError(messages.outputTooBig);
}

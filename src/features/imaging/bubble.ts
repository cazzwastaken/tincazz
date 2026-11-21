import type { BubbleStyle, TailSide } from './args.js';
import { type Frames, fromSharp, toSharp } from './frames.js';

export interface BubbleGeometry {
  /** lowest point of the curved bottom edge */
  curveY: number;
  /** where the curve meets the sides */
  edgeY: number;
  tailBaseFrom: number;
  tailBaseTo: number;
  tipX: number;
  tipY: number;
}

/**
 * `image` scales the bubble with the frame. `message` is for message screenshots, which are drawn
 * with a band of {@link messageBubble}`.depth` (a fraction of the width) above the message: the
 * curve ends at that band and the tail tip dips just into the message's top padding, so the
 * bubble sits right on top of the author's name instead of floating above it.
 */
export type BubbleShape = 'image' | 'message';

/** The message bubble, as fractions of the frame width (screenshots scale uniformly). */
export const messageBubble = { depth: 1 / 12, tail: 1 / 50 } as const;

/** Bubble proportions for a frame, in left-tail coordinates. */
export function bubbleGeometry(
  width: number,
  height: number,
  shape: BubbleShape = 'image',
): BubbleGeometry {
  const curveY =
    shape === 'message'
      ? Math.round(width * messageBubble.depth)
      : Math.round(Math.min(0.2 * width, 0.2 * height));
  const tipY =
    shape === 'message'
      ? curveY + Math.round(width * messageBubble.tail)
      : Math.round(Math.min(0.4 * width, 0.4 * height));
  return {
    curveY,
    edgeY: Math.round(curveY * 0.55),
    tailBaseFrom: 0.25 * width,
    tailBaseTo: 0.35 * width,
    tipX: 0.22 * width,
    tipY,
  };
}

/** One frame-sized SVG overlay: the curved bubble body and its tail. */
export function bubbleSvg(
  width: number,
  height: number,
  tail: TailSide,
  fill: string,
  shape: BubbleShape = 'image',
): Buffer {
  const g = bubbleGeometry(width, height, shape);
  const ctrlY = 2 * g.curveY - g.edgeY;
  const body = `M-2,-2 H${width + 2} V${g.edgeY} Q${width / 2},${ctrlY} -2,${g.edgeY} Z`;
  const tailPath = `M${g.tailBaseFrom},${g.edgeY} L${g.tipX},${g.tipY} L${g.tailBaseTo},${g.edgeY} Z`;
  const flip = tail === 'right' ? ` transform="translate(${width},0) scale(-1,1)"` : '';
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g${flip} fill="${fill}"><path d="${body}"/><path d="${tailPath}"/></g></svg>`,
  );
}

/** Cuts (transparent) or paints (white) a speech bubble into the top of every frame. */
export function applyBubble(
  frames: Frames,
  options: { style: BubbleStyle; tail: TailSide; shape?: BubbleShape },
): Promise<Frames> {
  const white = options.style === 'white';
  const svg = bubbleSvg(
    frames.width,
    frames.pageHeight,
    options.tail,
    white ? 'white' : 'black',
    options.shape,
  );
  const img = toSharp(frames).composite([
    { input: svg, tile: true, gravity: 'northwest', blend: white ? 'over' : 'dest-out' },
  ]);
  return fromSharp(img, frames);
}

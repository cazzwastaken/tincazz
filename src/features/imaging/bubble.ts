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

/** Bubble proportions for a frame, in left-tail coordinates. */
export function bubbleGeometry(width: number, height: number): BubbleGeometry {
  const curveY = Math.round(Math.min(0.2 * width, 0.2 * height));
  return {
    curveY,
    edgeY: Math.round(curveY * 0.55),
    tailBaseFrom: 0.25 * width,
    tailBaseTo: 0.35 * width,
    tipX: 0.22 * width,
    tipY: Math.round(Math.min(0.4 * width, 0.4 * height)),
  };
}

/** One frame-sized SVG overlay: the curved bubble body and its tail. */
export function bubbleSvg(width: number, height: number, tail: TailSide, fill: string): Buffer {
  const g = bubbleGeometry(width, height);
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
  options: { style: BubbleStyle; tail: TailSide },
): Promise<Frames> {
  const white = options.style === 'white';
  const svg = bubbleSvg(frames.width, frames.pageHeight, options.tail, white ? 'white' : 'black');
  const img = toSharp(frames).composite([
    { input: svg, tile: true, gravity: 'northwest', blend: white ? 'over' : 'dest-out' },
  ]);
  return fromSharp(img, frames);
}

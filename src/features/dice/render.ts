import sharp from 'sharp';

/** A die face to draw: 1-6 pips, or `unknown` for the not-yet-rolled placeholder. */
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6 | 'unknown';

/** `rolling` is the neutral look, `win` green with a gold edge, `loss` dimmed red. */
export type DiceTint = 'rolling' | 'win' | 'loss';

const dieSize = 180;
const gap = 36;
const pad = 16;
const scale = 2;
const logicalWidth = 2 * dieSize + gap + 2 * pad;
const logicalHeight = dieSize + 2 * pad;

/** Size of the PNG `renderDice` returns. */
export const diceImageSize = {
  width: logicalWidth * scale,
  height: logicalHeight * scale,
} as const;

const palette: Record<DiceTint, { body: string; edge: string; edgeWidth: number; pip: string }> = {
  rolling: { body: '#f5f5f7', edge: '#c3c6d0', edgeWidth: 4, pip: '#23252b' },
  win: { body: '#dcf7e6', edge: '#f1c40f', edgeWidth: 8, pip: '#14532d' },
  loss: { body: '#d6b4b4', edge: '#8f4a4a', edgeWidth: 4, pip: '#5a1a1a' },
};

const a = 0.27;
const b = 0.5;
const c = 0.73;
const pipSpots: Record<1 | 2 | 3 | 4 | 5 | 6, [number, number][]> = {
  1: [[b, b]],
  2: [
    [a, a],
    [c, c],
  ],
  3: [
    [a, a],
    [b, b],
    [c, c],
  ],
  4: [
    [a, a],
    [c, a],
    [a, c],
    [c, c],
  ],
  5: [
    [a, a],
    [c, a],
    [b, b],
    [a, c],
    [c, c],
  ],
  6: [
    [a, a],
    [c, a],
    [a, b],
    [c, b],
    [a, c],
    [c, c],
  ],
};

function dieSvg(face: DieFace, tint: DiceTint, x: number): string {
  const colors = palette[tint];
  const inset = colors.edgeWidth / 2;
  const unknown = face === 'unknown';
  const body = `<rect x="${x + inset}" y="${pad + inset}" width="${dieSize - colors.edgeWidth}" height="${dieSize - colors.edgeWidth}" rx="${dieSize * 0.2}" fill="${unknown ? '#e4e6ec' : colors.body}" stroke="${colors.edge}" stroke-width="${colors.edgeWidth}"${unknown ? ' stroke-dasharray="14 10"' : ''}/>`;
  if (face === 'unknown') {
    const cx = x + dieSize / 2;
    const cy = pad + dieSize / 2;
    // A drawn question mark rather than text, so no font is needed.
    return `${body}<path d="M ${cx - 26} ${cy - 30} a 26 26 0 1 1 40 22 q -14 8 -14 26" fill="none" stroke="#7b7f8e" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${cx}" cy="${cy + 46}" r="9" fill="#7b7f8e"/>`;
  }
  const pips = pipSpots[face]
    .map(
      ([u, v]) =>
        `<circle cx="${x + u * dieSize}" cy="${pad + v * dieSize}" r="${dieSize * 0.095}" fill="${colors.pip}"/>`,
    )
    .join('');
  return body + pips;
}

function diceSvg(left: DieFace, right: DieFace, tint: DiceTint): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${logicalWidth * scale}" height="${logicalHeight * scale}" viewBox="0 0 ${logicalWidth} ${logicalHeight}">${dieSvg(left, tint, pad)}${dieSvg(right, tint, pad + dieSize + gap)}</svg>`;
}

// At most 7 x 7 x 3 = 147 small PNGs, so every image is drawn once per process.
const cache = new Map<string, Buffer>();

/** Two dice side by side as a transparent PNG. Pure drawing: no fonts, no network. */
export async function renderDice(left: DieFace, right: DieFace, tint: DiceTint): Promise<Buffer> {
  const key = `${left}|${right}|${tint}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const png = await sharp(Buffer.from(diceSvg(left, right, tint)))
    .png()
    .toBuffer();
  cache.set(key, png);
  return png;
}

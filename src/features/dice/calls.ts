/** What a player bets on. Exact totals are 2-12 except 7, which has its own call. */
export type DiceCall =
  | { kind: 'high' | 'low' | 'seven' | 'doubles' }
  | { kind: 'exact'; target: number };

export const defaultCall: DiceCall = { kind: 'high' };

const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'] as const;

/** The die face for 1-6. */
export function dieFace(n: number): string {
  return faces[n - 1] ?? '';
}

/** A compact code for a call, safe to put in a custom ID. */
export function encodeCall(call: DiceCall): string {
  switch (call.kind) {
    case 'high':
      return 'h';
    case 'low':
      return 'l';
    case 'seven':
      return '7';
    case 'doubles':
      return 'd';
    case 'exact':
      return `e${call.target}`;
  }
}

/**
 * The inverse of `encodeCall`; undefined for anything else, including `e7` (that is `seven`) and
 * padded totals like `e09`, so `encodeCall(decodeCall(code)) === code` whenever it decodes.
 */
export function decodeCall(code: string): DiceCall | undefined {
  switch (code) {
    case 'h':
      return { kind: 'high' };
    case 'l':
      return { kind: 'low' };
    case '7':
      return { kind: 'seven' };
    case 'd':
      return { kind: 'doubles' };
  }
  const match = /^e([2-9]|1[0-2])$/.exec(code);
  if (!match) return undefined;
  const target = Number(match[1]);
  if (target < 2 || target > 12 || target === 7) return undefined;
  return { kind: 'exact', target };
}

/** Every call a player can make, in menu order. */
export const allCalls: readonly DiceCall[] = [
  { kind: 'high' },
  { kind: 'low' },
  { kind: 'seven' },
  { kind: 'doubles' },
  ...[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((target) => ({ kind: 'exact', target }) as const),
];

export function callLabel(call: DiceCall): string {
  switch (call.kind) {
    case 'high':
      return 'High';
    case 'low':
      return 'Low';
    case 'seven':
      return 'Seven';
    case 'doubles':
      return 'Doubles';
    case 'exact':
      return `Exact ${call.target}`;
  }
}

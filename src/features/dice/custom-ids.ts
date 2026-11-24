import { type DiceCall, decodeCall, encodeCall } from './calls.js';
import { wager } from './config.js';

/** The terms every dice control carries: the player, the bet and the call the next roll uses. */
interface DiceTerms {
  userId: string;
  bet: number;
  call: DiceCall;
}

/** The Roll again button: the player and terms of the roll it repeats. */
export interface RollAgainId extends DiceTerms {
  kind: 'again';
}

/** The Double button: the same call at twice the bet (clamped to the maximum), already applied. */
export interface DoubleId extends DiceTerms {
  kind: 'double';
}

/** The Change call menu: the terms shown on the card, which the chosen call replaces. */
export interface CallSelectId extends DiceTerms {
  kind: 'call';
}

export type DiceId = RollAgainId | DoubleId | CallSelectId;

const prefix = 'dc';
const kinds = ['again', 'double', 'call'] as const;

const encode = (kind: DiceId['kind'], { userId, bet, call }: DiceTerms) =>
  `${prefix}:${kind}:${userId}:${bet}:${encodeCall(call)}`;

export const encodeRollAgainId = (terms: DiceTerms): string => encode('again', terms);
export const encodeDoubleId = (terms: DiceTerms): string => encode('double', terms);
export const encodeCallSelectId = (terms: DiceTerms): string => encode('call', terms);

function parseBet(raw: string): number | undefined {
  if (!/^\d{1,5}$/.test(raw)) {
    return undefined;
  }
  const bet = Number(raw);
  return bet >= wager.minBet && bet <= wager.maxBet ? bet : undefined;
}

/** Decodes a dice component ID, or undefined for anything that is not a valid one. */
export function decodeDiceId(customId: string): DiceId | undefined {
  const parts = customId.split(':');
  const kind = kinds.find((k) => k === parts[1]);
  if (parts.length !== 5 || parts[0] !== prefix || kind === undefined) {
    return undefined;
  }
  const [, , userId = '', rawBet = '', rawCall = ''] = parts;
  const bet = parseBet(rawBet);
  const call = decodeCall(rawCall);
  if (!/^\d{1,20}$/.test(userId) || bet === undefined || call === undefined) {
    return undefined;
  }
  return { kind, userId, bet, call };
}

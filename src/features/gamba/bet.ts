import { InsufficientFundsError } from '../economy/errors.js';

/** A game's bet limits, in coins; `defaultBet` is what a play without a bet costs. */
export interface BetLimits {
  readonly minBet: number;
  readonly maxBet: number;
  readonly defaultBet: number;
}

// No parameter properties: Node's strip-only TypeScript loader (used for pieces in tests) rejects them.
export class InvalidBetError extends Error {
  public readonly kind: 'format' | 'range';
  public readonly input: string;
  /** The limits the bet was checked against, so the error text shows the right game's range. */
  public readonly limits: BetLimits;

  public constructor(kind: 'format' | 'range', input: string, limits: BetLimits) {
    super(`Invalid bet (${kind}): ${input}`);
    this.kind = kind;
    this.input = input;
    this.limits = limits;
  }
}

/**
 * Parses "100", "2.5k", "all" or "half" into a whole coin amount within a game's bet limits.
 * `all` is the whole wallet up to the game's maximum (a bigger wallet bets the maximum), and `half`
 * needs twice the minimum bet in the wallet.
 */
export function parseBet(input: string, balance: number, limits: BetLimits): number {
  const text = input.trim().toLowerCase();

  let fixed: number | undefined;
  if (/^\d+$/.test(text)) {
    fixed = Number(text);
  } else if (/^\d+(\.\d+)?k$/.test(text)) {
    const [whole = '0', fraction = ''] = text.slice(0, -1).split('.');
    if (fraction.length > 3) {
      throw new InvalidBetError('format', input, limits);
    }
    fixed = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  } else if (text !== 'all' && text !== 'half') {
    throw new InvalidBetError('format', input, limits);
  }

  if (balance < limits.minBet) {
    throw new InsufficientFundsError(balance, limits.minBet);
  }

  let value: number;
  if (fixed !== undefined) {
    value = fixed;
  } else if (text === 'all') {
    value = Math.min(balance, limits.maxBet);
  } else {
    value = Math.floor(balance / 2);
    if (value < limits.minBet) {
      // Half the wallet is below the minimum: the wallet is short, the text is not a bad range.
      throw new InsufficientFundsError(balance, limits.minBet * 2);
    }
  }

  if (value < limits.minBet || value > limits.maxBet) {
    throw new InvalidBetError('range', input, limits);
  }
  if (value > balance) {
    throw new InsufficientFundsError(balance, value);
  }
  return value;
}

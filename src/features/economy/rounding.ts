import { randomInt as cryptoRandomInt } from 'node:crypto';

/** Returns an integer in `[0, max)`. */
type Draw = (max: number) => number;

/**
 * Rounds `numerator / denominator` to a whole number without bias: the floor, plus one coin with
 * probability equal to the fractional part. The expected value is exactly the unrounded amount, so
 * small bets keep the advertised return instead of losing a fraction of a coin on every payout.
 */
export function roundUnbiased(
  numerator: number,
  denominator: number,
  randomInt: Draw = cryptoRandomInt,
): number {
  const whole = Math.floor(numerator / denominator);
  const remainder = numerator - whole * denominator;
  return remainder > 0 && randomInt(denominator) < remainder ? whole + 1 : whole;
}

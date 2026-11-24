import { roundUnbiased } from '../economy/rounding.js';
import type { RandomInt } from '../gamba/roll.js';
import { coinflip } from './config.js';

/**
 * Coins raked from a flip's pool (both stakes) into the gamba pot: the rake percentage of the
 * pool, rounded to the nearest coin and at least one. Player flips move exactly this from the
 * players to the pot, so rounding bias does not mint coins.
 */
export function flipRake(bet: number): number {
  return Math.max(1, Math.round((2 * bet * coinflip.rakePercent) / 100));
}

/**
 * The rake taken from a winning flip against the bot. The bot only pays out on a win, so the rake
 * comes off the payout and a loss adds nothing to the pot. At 50/50 the pot gains the rake half
 * the time, which equals the player's expected loss (rake / 2 = 3% of the bet). Rounded unbiased
 * so the expectation holds at every bet size.
 */
export function botFlipRake(bet: number, randomInt?: RandomInt): number {
  return roundUnbiased(2 * bet * coinflip.rakePercent, 100, randomInt);
}

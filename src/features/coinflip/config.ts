import type { BetLimits } from '../gamba/bet.js';

/** Bet limits for a flip, in coins; `defaultBet` is what a flip without a bet costs. */
export const wager = { minBet: 10, maxBet: 10_000, defaultBet: 10 } as const satisfies BetLimits;

/** Coinflip rules: the share of the pool raked into the gamba pot, and how long challenges live and how many one player may have. */
export const coinflip = {
  rakePercent: 3,
  expiryMs: { challenge: 60_000, open: 120_000 },
  /** Live (not yet closed) challenges one player may have in a guild, rematches included. */
  maxLiveChallenges: 3,
} as const;

/** The stages of a coin in the air, shown in order before the result card. */
export const flipAnimation = { stages: ['toss', 'spin', 'fall', 'edge'] } as const;

export type FlipStage = (typeof flipAnimation.stages)[number];

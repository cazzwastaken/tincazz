import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { pots } from '../../db/schema.js';
import { type PayoutTier, pot } from './config.js';

/** Coins a wager adds to the pot: a percentage of the bet, and nothing for bets of 100 or less. */
export function potContribution(bet: number): number {
  if (bet <= pot.contributionAbove) return 0;
  return Math.floor((bet * pot.contributionPercent) / 100);
}

/** The part of the pot a jackpot pays: all of it from the full-share bet, scaled below. */
export function potShare(amount: number, bet: number): number {
  if (bet >= pot.fullShareBet) return amount;
  return Math.floor((amount * bet) / pot.fullShareBet);
}

/** The share of the pot's excess over the seed a tier wins, in basis points; 0 for none. */
function tierShareBps(tier: PayoutTier): number {
  const shares: Partial<Record<PayoutTier, number>> = pot.shareBps;
  return shares[tier] ?? 0;
}

/** What a win of `tier` may take from the pot at most: a multiple of the bet; 0 for none. */
export function maxPotWin(bet: number, tier: PayoutTier): number {
  const limits: Partial<Record<PayoutTier, number>> = pot.maxWinPerBet;
  return (limits[tier] ?? 0) * bet;
}

/**
 * What a rare (non-jackpot) win takes from the pot: a share of its excess, scaled by the bet and
 * limited by `maxPotWin`.
 */
export function rareWinShare(amount: number, bet: number, tier: PayoutTier): number {
  const excess = Math.max(0, amount - pot.seed);
  const share = potShare(Math.floor((excess * tierShareBps(tier)) / 10_000), bet);
  return Math.min(share, maxPotWin(bet, tier));
}

/**
 * Adds the bet's contribution to the guild pot (creating it at the seed) and pays out what the
 * tier wins: the share on a jackpot, topping the remainder up to the seed, or a share of the
 * excess on a rarer win. Either is limited by `maxPotWin` and the rest stays in the pot. Does not
 * touch wallets.
 */
export function settlePot(
  tx: DbOrTx,
  guildId: string,
  bet: number,
  tier: PayoutTier,
  userId: string,
  now: number,
): { potWon: number; pot: number } {
  tx.insert(pots).values({ guildId, amount: pot.seed }).onConflictDoNothing().run();
  const current = tx.select().from(pots).where(eq(pots.guildId, guildId)).get();
  const afterContribution = (current?.amount ?? pot.seed) + potContribution(bet);

  if (tier !== 'cppTriple') {
    // Not a jackpot, so the last winner (shown as the last jackpot) stays as it is.
    const potWon = rareWinShare(afterContribution, bet, tier);
    const remaining = afterContribution - potWon;
    tx.update(pots).set({ amount: remaining }).where(eq(pots.guildId, guildId)).run();
    return { potWon, pot: remaining };
  }

  const potWon = Math.min(potShare(afterContribution, bet), maxPotWin(bet, tier));
  const remaining = Math.max(pot.seed, afterContribution - potWon);
  tx.update(pots)
    .set({ amount: remaining, lastWinnerId: userId, lastWonAt: now })
    .where(eq(pots.guildId, guildId))
    .run();
  return { potWon, pot: remaining };
}

/** Adds coins to the guild pot (creating it at the seed) and returns the new amount. */
export function addToPot(tx: DbOrTx, guildId: string, amount: number): number {
  tx.insert(pots).values({ guildId, amount: pot.seed }).onConflictDoNothing().run();
  const current = tx.select().from(pots).where(eq(pots.guildId, guildId)).get();
  const next = (current?.amount ?? pot.seed) + amount;
  tx.update(pots).set({ amount: next }).where(eq(pots.guildId, guildId)).run();
  return next;
}

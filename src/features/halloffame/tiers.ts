import { type HallTier, hallTiers } from './config.js';

/**
 * The tier for a message whose peak count is `peak` against `threshold`: the first tier whose
 * `below` bound is above peak / threshold (compared by multiplication, so no float rounding at the
 * boundaries). A ratio on a bound belongs to the next tier. The last tier is open ended.
 */
export function tierFor(
  peak: number,
  threshold: number,
  tiers: readonly HallTier[] = hallTiers,
): HallTier {
  const base = Math.max(1, threshold);
  const found = tiers.find((tier) => peak < tier.below * base);
  const last = tiers[tiers.length - 1];
  if (found) return found;
  if (!last) throw new Error('hall tiers must not be empty');
  return last;
}

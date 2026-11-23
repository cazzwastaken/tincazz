const minute = 60_000;

export const giveaway = {
  emoji: '🎉',
  maxPrizeLength: 100,
  maxDurationLength: 20,
  minDurationMs: minute,
  maxDurationMs: 30 * 24 * 60 * minute,
  scanMs: 1000,
  debounceMs: 3000,
  refreshMs: minute,
  publishRetryMs: 5_000,
  accessRetryMs: 5 * minute,
  maxAccessRetryMs: 60 * minute,
  maxConcurrentSyncs: 4,
} as const;

export const giveawayDurationHint =
  'Use a duration from 1 minute to 30 days, such as 12 hours or 1 day.';

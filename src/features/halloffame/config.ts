const second = 1000;
const minute = 60 * second;
const mebibyte = 1024 * 1024;

export const hallOfFame = {
  /** Distinct people (not counting the author or bots) a message needs. */
  minThreshold: 2,
  maxThreshold: 50,
  defaultThreshold: 5,
  maxExemptChannels: 50,

  /** Quoted message text is cut to this many characters (on a code point boundary). */
  maxTextLength: 1500,
  maxReplySnippetLength: 80,
  maxAttachmentNames: 5,
  /** Images re-uploaded to the hall post, so it outlives Discord's expiring CDN links. */
  maxImages: 4,
  maxImageBytes: 8 * mebibyte,
  maxImageBytesTotal: 8 * mebibyte,
  /** Emoji shown in the footer's breakdown. */
  maxBreakdownEmojis: 3,
  /** Emoji whose reactors are fetched for one message. */
  maxReactionEmojis: 20,
  /** Discord's page size when listing the users who reacted. */
  reactorPageSize: 100,

  /** Reactions on one message are batched until this long after the last one... */
  debounceMs: 3 * second,
  /** ...but never held back longer than this. */
  maxWaitMs: 30 * second,
  queueConcurrency: 2,
  /** Evaluations beyond this wait are dropped; the next reaction triggers another. */
  queueCap: 200,
  /** Tracked messages whose "reactions needed before refetching" counter is remembered. */
  counterCacheSize: 5000,
  counterTtlMs: 30 * minute,
  /**
   * Authors (bots, apps, webhooks) already seen on a message, so their later reactions are dropped
   * before any fetch. Whether an id is a bot never changes, so this can be long.
   */
  botAuthorCacheSize: 2000,
  botAuthorTtlMs: 6 * 60 * minute,
  /** A posted entry is re-evaluated for a higher peak at most this often. */
  peakCooldownMs: 30 * second,
  /** A posted entry is redrawn for an edit of the original at most this often (deferred, not dropped). */
  editCooldownMs: 10 * second,
  /** A channel that answered 403/404 is skipped for this long. */
  failureMemoryMs: 10 * minute,
  /** A deleted source channel is remembered this long, for an induction already under way. */
  deletedChannelMemoryMs: 10 * minute,
  /** A claim still `publishing` this long after it was made is recovered at startup and hourly. */
  publishStaleMs: 5 * minute,
  /** How often abandoned claims are looked for, besides once at startup. */
  recoveryIntervalMs: 60 * minute,
  /** Pages of 100 hall messages scanned for the card of an abandoned claim. */
  recoveryScanPages: 3,
} as const;

export interface HallTier {
  /** Exclusive upper bound of peak / threshold for this tier. */
  below: number;
  emoji: string;
  color: number;
}

/** Tiers by how far a message's peak count is above the threshold; the last one is open ended. */
export const hallTiers: readonly HallTier[] = [
  { below: 2, emoji: '⭐', color: 0xf1c40f },
  { below: 4, emoji: '🌟', color: 0xe67e22 },
  { below: 8, emoji: '💫', color: 0xe91e63 },
  { below: Number.POSITIVE_INFINITY, emoji: '👑', color: 0x9b59b6 },
];

const minute = 60_000;

export const poll = {
  maxQuestionLength: 200,
  maxOptionLength: 80,
  minOptions: 2,
  maxOptions: 9,
  maxOpenPerHost: 3,
  minDurationMs: minute,
  maxDurationMs: 7 * 24 * 60 * minute,
  defaultDurationMs: 24 * 60 * minute,
  /** Longest duration text accepted, so a pasted wall of text is rejected early. */
  maxDurationLength: 20,
  scanMs: 1000,
  debounceMs: 3000,
  recountMs: 15 * minute,
  retryMs: minute,
  /** Wait before recounting again after a vote event made a recount's snapshot stale. */
  racedRecountRetryMs: 5_000,
  publishRetryMs: 5_000,
  /** A poll still `publishing` this long after it was queued is given up on. */
  publishTtlMs: 10 * minute,
  accessRetryMs: 5 * minute,
  maxAccessRetryMs: 60 * minute,
  maxConcurrentSyncs: 4,
  splitBarWidth: 16,
  optionBarWidth: 10,
} as const;

export const yesNoOptions = ['Yes', 'No'] as const;
export const yesNoEmojis = ['👍', '👎'] as const;
export const optionEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'] as const;

export const pollDurationHint = 'Use a duration from 1 minute to 7 days, such as 30m, 2h or 3d.';

export const pollUsage =
  'Usage: `?poll <question>` for yes/no, or `?poll "<question>" | option | option` (2 to 9 options). Add `--anon` and `--for 2h` at the end.';

import { hallOfFame } from './config.js';

/** One person who reacted. */
export interface Reactor {
  id: string;
  bot: boolean;
}

/** The people who reacted with one emoji. `emoji` is any stable key (unicode or `name:id`). */
export interface EmojiReactors {
  emoji: string;
  users: readonly Reactor[];
}

export interface EmojiCount {
  emoji: string;
  count: number;
}

export interface Score {
  /** Distinct people (not the author, not bots) across every emoji counted so far. */
  distinct: number;
  /** Distinct people per emoji, most first, ties by emoji key so the order never depends on input. */
  perEmoji: EmojiCount[];
}

/**
 * Incremental tally, so a fetch can stop as soon as the threshold is reached (`enough`). The same
 * person reacting with five emoji counts once; the author and bots never count; adding an emoji
 * again (another page of users) merges instead of double counting.
 */
export class ReactorTally {
  private readonly everyone = new Set<string>();
  private readonly byEmoji = new Map<string, Set<string>>();

  constructor(private readonly authorId: string) {}

  add(emoji: string, users: readonly Reactor[]): void {
    let set = this.byEmoji.get(emoji);
    for (const user of users) {
      if (user.bot || user.id === this.authorId) continue;
      if (!set) {
        set = new Set();
        this.byEmoji.set(emoji, set);
      }
      set.add(user.id);
      this.everyone.add(user.id);
    }
  }

  get distinct(): number {
    return this.everyone.size;
  }

  /** Whether `threshold` is reached, so no more users need to be fetched. */
  enough(threshold: number): boolean {
    return this.everyone.size >= threshold;
  }

  score(): Score {
    const perEmoji = [...this.byEmoji].map(([emoji, set]) => ({ emoji, count: set.size }));
    perEmoji.sort(
      (a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0),
    );
    return { distinct: this.everyone.size, perEmoji };
  }
}

export interface DistinctScore extends Score {
  /** False when counting stopped early at `stopAt`, so `distinct` is a lower bound. */
  complete: boolean;
}

/**
 * Distinct people who reacted, across all emoji. With `stopAt` the remaining emoji are skipped once
 * that many distinct people are known (a message that qualifies needs no further fetching).
 */
export function distinctScore(
  reactorsByEmoji: readonly EmojiReactors[],
  authorId: string,
  options: { stopAt?: number } = {},
): DistinctScore {
  const tally = new ReactorTally(authorId);
  let complete = true;
  for (const entry of reactorsByEmoji) {
    if (options.stopAt !== undefined && tally.enough(options.stopAt)) {
      complete = false;
      break;
    }
    tally.add(entry.emoji, entry.users);
  }
  return { ...tally.score(), complete };
}

/** The top emoji for the card's footer, optionally only those the card can show. */
export function topBreakdown(
  perEmoji: readonly EmojiCount[],
  max: number = hallOfFame.maxBreakdownEmojis,
  usable: (emoji: string) => boolean = () => true,
): EmojiCount[] {
  return perEmoji.filter((entry) => entry.count > 0 && usable(entry.emoji)).slice(0, max);
}

/** A reaction as the gateway reports it: `normal` excludes super (burst) reactions. */
export interface ReactionCount {
  emoji: string;
  normal: number;
}

/** Normal (non-burst) reactions on the message; at least the number of distinct people. */
export function normalReactionTotal(reactions: readonly ReactionCount[]): number {
  let total = 0;
  for (const reaction of reactions) total += Math.max(0, reaction.normal);
  return total;
}

/**
 * Cheap pre-check before fetching any reactors: fewer normal reactions than the threshold cannot
 * come from enough distinct people.
 */
export function mightQualify(reactions: readonly ReactionCount[], threshold: number): boolean {
  return normalReactionTotal(reactions) >= threshold;
}

/** The emoji whose reactors are fetched: the most reacted first, capped. */
export function emojisToFetch(
  reactions: readonly ReactionCount[],
  max: number = hallOfFame.maxReactionEmojis,
): ReactionCount[] {
  return reactions
    .filter((reaction) => reaction.normal > 0)
    .sort((a, b) => b.normal - a.normal || (a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0))
    .slice(0, max);
}

/**
 * How many more reactions being added are needed before a message that scored `distinct` could
 * reach `threshold`, so that many adds can be counted off without fetching. Never below 1.
 */
export function reactionsNeeded(threshold: number, distinct: number): number {
  return Math.max(1, threshold - distinct);
}

/** One reaction add against a "needed" counter: whether it is time to fetch, and what is left. */
export function countdown(remaining: number): { ready: boolean; remaining: number } {
  return remaining <= 1
    ? { ready: true, remaining: 0 }
    : { ready: false, remaining: remaining - 1 };
}

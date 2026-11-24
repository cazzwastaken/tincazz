import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  distinctScore,
  type EmojiReactors,
  hallTiers,
  reactionsNeeded,
  tierFor,
} from '../src/features/halloffame/index.js';

const reactor = fc.record({
  id: fc.constantFrom('author', '1', '2', '3', '4', '5', '6', '7'),
  bot: fc.boolean(),
});
const emojis = fc.array(
  fc.record({
    emoji: fc.constantFrom('⭐', '🔥', '👍', 'a:1', 'b:2'),
    users: fc.array(reactor, { maxLength: 8 }),
  }),
  { maxLength: 8 },
) satisfies fc.Arbitrary<EmojiReactors[]>;

describe('fuzz: hall of fame score', () => {
  it('never counts the author or bots, and never exceeds the distinct humans', () => {
    fc.assert(
      fc.property(emojis, (input) => {
        const score = distinctScore(input, 'author');
        const humans = new Set(
          input.flatMap((e) => e.users.filter((u) => !u.bot && u.id !== 'author').map((u) => u.id)),
        );
        // A person who is a bot on one entry and not another still counts through the human one.
        expect(score.distinct).toBe(humans.size);
        for (const entry of score.perEmoji) {
          expect(entry.count).toBeGreaterThan(0);
          expect(entry.count).toBeLessThanOrEqual(score.distinct);
        }
        expect(Math.max(0, ...score.perEmoji.map((e) => e.count))).toBeLessThanOrEqual(
          score.distinct,
        );
      }),
    );
  });

  it('does not depend on the order of emoji or users', () => {
    fc.assert(
      fc.property(emojis, fc.nat(), (input, seed) => {
        const shuffled = [...input]
          .map((e) => ({ ...e, users: [...e.users].reverse() }))
          .sort((a, b) => ((a.emoji.length * 31 + seed) % 7) - ((b.emoji.length * 31 + seed) % 7))
          .reverse();
        expect(distinctScore(shuffled, 'author').distinct).toBe(
          distinctScore(input, 'author').distinct,
        );
        const a = distinctScore(input, 'author').perEmoji;
        const b = distinctScore(shuffled, 'author').perEmoji;
        expect(b).toEqual(a);
      }),
    );
  });

  it('stopping early is a lower bound that reaches the threshold when full does', () => {
    fc.assert(
      fc.property(emojis, fc.integer({ min: 1, max: 8 }), (input, stopAt) => {
        const full = distinctScore(input, 'author');
        const early = distinctScore(input, 'author', { stopAt });
        expect(early.distinct).toBeLessThanOrEqual(full.distinct);
        expect(early.distinct >= stopAt).toBe(full.distinct >= stopAt);
      }),
    );
  });

  it('counts down to a fetch in exactly the needed adds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 50 }), fc.integer({ min: 0, max: 60 }), (t, d) => {
        expect(reactionsNeeded(t, d)).toBeGreaterThanOrEqual(1);
        if (d < t) expect(reactionsNeeded(t, d)).toBe(t - d);
      }),
    );
  });

  it('tiers rise monotonically with the peak', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 50 }),
        fc.nat(5000),
        fc.nat(5000),
        (threshold, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(hallTiers.indexOf(tierFor(low, threshold))).toBeLessThanOrEqual(
            hallTiers.indexOf(tierFor(high, threshold)),
          );
        },
      ),
    );
  });
});

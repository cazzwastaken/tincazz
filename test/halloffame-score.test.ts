import { describe, expect, it } from 'vitest';
import {
  countdown,
  distinctScore,
  emojisToFetch,
  mightQualify,
  normalReactionTotal,
  ReactorTally,
  reactionsNeeded,
  tierFor,
  topBreakdown,
} from '../src/features/halloffame/index.js';

const user = (id: string, bot = false) => ({ id, bot });

describe('hall of fame scoring', () => {
  it('counts a person once however many emoji they used', () => {
    const score = distinctScore(
      [
        { emoji: '⭐', users: [user('1'), user('2')] },
        { emoji: '🔥', users: [user('1'), user('3')] },
        { emoji: '👍', users: [user('1')] },
      ],
      'author',
    );
    expect(score.distinct).toBe(3);
    expect(score.perEmoji).toEqual([
      { emoji: '⭐', count: 2 },
      { emoji: '🔥', count: 2 },
      { emoji: '👍', count: 1 },
    ]);
    expect(score.complete).toBe(true);
  });

  it('ignores the author and bots', () => {
    const score = distinctScore(
      [{ emoji: '⭐', users: [user('author'), user('bot', true), user('1')] }],
      'author',
    );
    expect(score.distinct).toBe(1);
    expect(score.perEmoji).toEqual([{ emoji: '⭐', count: 1 }]);
  });

  it('drops an emoji only the author and bots used', () => {
    const score = distinctScore([{ emoji: '⭐', users: [user('author')] }], 'author');
    expect(score).toEqual({ distinct: 0, perEmoji: [], complete: true });
  });

  it('stops early once the threshold is reached', () => {
    const score = distinctScore(
      [
        { emoji: 'a', users: [user('1'), user('2')] },
        { emoji: 'b', users: [user('3')] },
      ],
      'x',
      { stopAt: 2 },
    );
    expect(score.distinct).toBe(2);
    expect(score.complete).toBe(false);
    expect(score.perEmoji).toEqual([{ emoji: 'a', count: 2 }]);
  });

  it('keeps counting when the threshold is not reached', () => {
    const score = distinctScore([{ emoji: 'a', users: [user('1')] }], 'x', { stopAt: 2 });
    expect(score.complete).toBe(true);
  });

  it('tallies pages of one emoji without double counting', () => {
    const tally = new ReactorTally('x');
    tally.add('a', [user('1'), user('2')]);
    tally.add('a', [user('2'), user('3')]);
    expect(tally.distinct).toBe(3);
    expect(tally.enough(3)).toBe(true);
    expect(tally.enough(4)).toBe(false);
    expect(tally.score().perEmoji).toEqual([{ emoji: 'a', count: 3 }]);
  });

  it('breaks ties by emoji so the order is stable', () => {
    const a = distinctScore(
      [
        { emoji: 'b', users: [user('1')] },
        { emoji: 'a', users: [user('2')] },
      ],
      'x',
    );
    const b = distinctScore(
      [
        { emoji: 'a', users: [user('2')] },
        { emoji: 'b', users: [user('1')] },
      ],
      'x',
    );
    expect(a).toEqual(b);
    expect(a.perEmoji.map((e) => e.emoji)).toEqual(['a', 'b']);
  });

  it('takes the top breakdown and filters unusable emoji', () => {
    const per = [
      { emoji: 'a', count: 5 },
      { emoji: 'custom:1', count: 4 },
      { emoji: 'b', count: 3 },
      { emoji: 'c', count: 2 },
    ];
    expect(topBreakdown(per).map((e) => e.emoji)).toEqual(['a', 'custom:1', 'b']);
    expect(topBreakdown(per, 3, (e) => !e.startsWith('custom')).map((e) => e.emoji)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('pre-checks with the normal reaction counts only', () => {
    const reactions = [
      { emoji: 'a', normal: 2 },
      { emoji: 'b', normal: 1 },
      { emoji: 'c', normal: 0 },
    ];
    expect(normalReactionTotal(reactions)).toBe(3);
    expect(mightQualify(reactions, 3)).toBe(true);
    expect(mightQualify(reactions, 4)).toBe(false);
  });

  it('fetches the most reacted emoji, capped', () => {
    const reactions = Array.from({ length: 30 }, (_, i) => ({ emoji: `e${i}`, normal: i }));
    const picked = emojisToFetch(reactions);
    expect(picked).toHaveLength(20);
    expect(picked[0]?.emoji).toBe('e29');
    expect(picked.some((r) => r.normal === 0)).toBe(false);
    expect(emojisToFetch(reactions, 2).map((r) => r.emoji)).toEqual(['e29', 'e28']);
  });

  it('counts reactions needed before the next fetch', () => {
    expect(reactionsNeeded(5, 2)).toBe(3);
    expect(reactionsNeeded(5, 5)).toBe(1);
    expect(reactionsNeeded(5, 9)).toBe(1);
    expect(countdown(3)).toEqual({ ready: false, remaining: 2 });
    expect(countdown(1)).toEqual({ ready: true, remaining: 0 });
    expect(countdown(0)).toEqual({ ready: true, remaining: 0 });
  });
});

describe('hall of fame tiers', () => {
  it('picks the tier by peak over threshold, a ratio on a bound going up', () => {
    expect(tierFor(5, 5).emoji).toBe('⭐');
    expect(tierFor(9, 5).emoji).toBe('⭐');
    expect(tierFor(10, 5).emoji).toBe('🌟');
    expect(tierFor(19, 5).emoji).toBe('🌟');
    expect(tierFor(20, 5).emoji).toBe('💫');
    expect(tierFor(39, 5).emoji).toBe('💫');
    expect(tierFor(40, 5).emoji).toBe('👑');
    expect(tierFor(5000, 5).emoji).toBe('👑');
  });

  it('treats a peak below the threshold as the lowest tier', () => {
    expect(tierFor(0, 5).emoji).toBe('⭐');
    expect(tierFor(3, 0).emoji).toBe('🌟');
  });
});

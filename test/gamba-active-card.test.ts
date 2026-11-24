import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  activeCardCount,
  activeCardMax,
  clearActiveCards,
  isActiveCard,
  setActiveCard,
} from '../src/features/gamba/active-card.js';

describe('active gamba cards', () => {
  beforeEach(clearActiveCards);

  it('tracks the newest card per user', () => {
    setActiveCard('1', 'a');
    setActiveCard('1', 'b');
    expect(isActiveCard('1', 'a')).toBe(false);
    expect(isActiveCard('1', 'b')).toBe(true);
    expect(activeCardCount()).toBe(1);
  });

  it('never tracks more than the cap, dropping the least recently set user', () => {
    for (let index = 0; index < activeCardMax + 10; index++) {
      setActiveCard(`u${index}`, `m${index}`);
    }
    expect(activeCardCount()).toBe(activeCardMax);
    // An evicted user adopts the card they click, so nothing breaks for them.
    expect(isActiveCard('u0', 'old')).toBe(true);
    expect(isActiveCard(`u${activeCardMax + 9}`, `m${activeCardMax + 9}`)).toBe(true);
  });

  it('stays within the cap for any sequence of users', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(20_000), fc.boolean()), { maxLength: 300 }), (steps) => {
        clearActiveCards();
        for (const [user, set] of steps) {
          if (set) setActiveCard(String(user), 'm');
          else isActiveCard(String(user), 'm');
        }
        expect(activeCardCount()).toBeLessThanOrEqual(activeCardMax);
      }),
      { numRuns: 20 },
    );
  });
});

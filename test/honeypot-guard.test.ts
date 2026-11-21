import { container } from '@sapphire/framework';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { finish, guardKey, resetGuard, tryBegin } from '../src/features/honeypot/guard.js';

describe('honeypot guard', () => {
  beforeEach(resetGuard);

  it('builds the key from the guild and the user', () => {
    expect(guardKey('1', '5')).toBe('1:5');
  });

  it('begins once and blocks while in flight', () => {
    const k = guardKey('1', '5');
    expect(tryBegin(k, 0)).toEqual({ begun: true });
    expect(tryBegin(k, 10_000_000)).toEqual({ begun: false, blockedBy: 'in-flight' });
  });

  it('blocks for 60 s counted from the finish', () => {
    const k = guardKey('1', '5');
    tryBegin(k, 0);
    finish(k, 5_000, 'softbanned');
    expect(tryBegin(k, 64_999)).toEqual({ begun: false, blockedBy: 'softbanned' });
    expect(tryBegin(k, 65_000)).toEqual({ begun: true });
  });

  it('remembers a failed outcome', () => {
    const k = guardKey('1', '5');
    tryBegin(k, 0);
    finish(k, 0, 'failed');
    expect(tryBegin(k, 59_999)).toEqual({ begun: false, blockedBy: 'failed' });
    expect(tryBegin(k, 60_000)).toEqual({ begun: true });
  });

  it('keeps guilds and users apart', () => {
    expect(tryBegin(guardKey('1', '5'), 0)).toEqual({ begun: true });
    expect(tryBegin(guardKey('2', '5'), 0)).toEqual({ begun: true });
    expect(tryBegin(guardKey('1', '6'), 0)).toEqual({ begun: true });
  });

  it('prunes expired entries on access', () => {
    const k1 = guardKey('1', '5');
    const k2 = guardKey('1', '6');
    tryBegin(k1, 0);
    finish(k1, 0, 'softbanned');
    expect(container.honeypotGuard?.has(k1)).toBe(true);
    tryBegin(k2, 60_000);
    expect(container.honeypotGuard?.has(k1)).toBe(false);
  });

  it('never prunes an in-flight entry', () => {
    const k1 = guardKey('1', '5');
    tryBegin(k1, 0);
    tryBegin(guardKey('1', '6'), 10_000_000);
    expect(container.honeypotGuard?.get(k1)).toEqual({ state: 'in-flight' });
  });

  it('gives exactly one begin per user for any interleaving inside the cooldown', () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((k) =>
          fc.array(
            fc.record({
              user: fc.integer({ min: 0, max: k - 1 }),
              dt: fc.integer({ min: 0, max: 500 }),
              finishFirst: fc.boolean(),
            }),
            { maxLength: 100 },
          ),
        ),
        (events) => {
          resetGuard();
          let t = 0;
          let begins = 0;
          const inFlight = new Set<number>();
          for (const e of events) {
            t += e.dt;
            const key = guardKey('g', String(e.user));
            if (e.finishFirst && inFlight.has(e.user)) {
              finish(key, t, 'softbanned');
              inFlight.delete(e.user);
            }
            if (tryBegin(key, t).begun) {
              begins++;
              inFlight.add(e.user);
            }
          }
          // t <= 50_000 < 60_000, so no cooldown can expire.
          return begins === new Set(events.map((e) => e.user)).size;
        },
      ),
    ));
});

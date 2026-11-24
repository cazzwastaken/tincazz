import { container } from '@sapphire/framework';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import {
  assertChallengeCapacity,
  ChallengeLimitError,
  clearChallenges,
  closeChallengeCard,
  coinflip,
  forgetChallengeCard,
  liveChallengeCount,
  reserveChallengeSlot,
  trackChallengeCard,
} from '../src/features/coinflip/index.js';

const players = ['1', '2'] as const;
const guilds = ['10', '20'] as const;

const op = fc.oneof(
  fc.record({
    kind: fc.constant('create' as const),
    player: fc.constantFrom(...players),
    guild: fc.constantFrom(...guilds),
  }),
  fc.record({ kind: fc.constant('cancel' as const), pick: fc.nat(40) }),
  fc.record({ kind: fc.constant('forget' as const), pick: fc.nat(40) }),
);

const view = (challengerId: string) => ({
  challengerId,
  opponentId: undefined,
  bet: 10,
  side: 'heads' as const,
  expiresAt: Date.now() + 600_000,
});

describe('live challenge limit (model)', () => {
  beforeEach(() => {
    container.db = openDatabase(':memory:');
    clearChallenges();
  });
  afterEach(clearChallenges);

  it('never lets a player hold more live challenges than the cap in a guild', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 60 }), async (ops) => {
        container.db = openDatabase(':memory:');
        clearChallenges();
        const live: { id: string; player: string; guild: string }[] = [];
        let next = 0;
        for (const step of ops) {
          if (step.kind === 'create') {
            const inGuild = live.filter(
              (row) => row.player === step.player && row.guild === step.guild,
            ).length;
            if (inGuild >= coinflip.maxLiveChallenges) {
              expect(() => assertChallengeCapacity(step.guild, step.player)).toThrow(
                ChallengeLimitError,
              );
              continue;
            }
            assertChallengeCapacity(step.guild, step.player);
            const id = `m${next++}`;
            trackChallengeCard(step.guild, 'c', id, view(step.player), async () => undefined);
            live.push({ id, player: step.player, guild: step.guild });
          } else if (live.length > 0) {
            const [row] = live.splice(step.pick % live.length, 1);
            if (step.kind === 'cancel') {
              await closeChallengeCard(
                row?.id as string,
                { ...view(row?.player as string), expiresAt: 0 },
                'cancelled',
                async () => undefined,
              );
            } else {
              forgetChallengeCard(row?.id as string);
            }
          }
          for (const player of players) {
            for (const guild of guilds) {
              const count = liveChallengeCount(guild, player);
              expect(count).toBe(
                live.filter((row) => row.player === player && row.guild === guild).length,
              );
              expect(count).toBeLessThanOrEqual(coinflip.maxLiveChallenges);
            }
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('does not count a closed challenge whose card is still being edited', async () => {
    trackChallengeCard('10', 'c', 'm', view('1'), async () => undefined);
    let release: () => void = () => undefined;
    const pending = closeChallengeCard(
      'm',
      { ...view('1'), expiresAt: 0 },
      'expired',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(liveChallengeCount('10', '1')).toBe(0);
    release();
    await pending;
  });

  it('counts in-flight reservations with live rows and frees them once released', () => {
    const releases: (() => void)[] = [];
    trackChallengeCard('10', 'c', 'live', view('1'), async () => undefined);
    for (let taken = 1; taken < coinflip.maxLiveChallenges; taken++) {
      releases.push(reserveChallengeSlot('10', '1'));
    }
    expect(() => reserveChallengeSlot('10', '1')).toThrow(ChallengeLimitError);
    // Other players and guilds are unaffected.
    releases.push(reserveChallengeSlot('10', '2'), reserveChallengeSlot('20', '1'));

    const [first] = releases;
    first?.();
    first?.();
    releases.push(reserveChallengeSlot('10', '1'));
    expect(() => reserveChallengeSlot('10', '1')).toThrow(ChallengeLimitError);
    for (const release of releases) release();
    expect(() => assertChallengeCapacity('10', '1')).not.toThrow();
  });

  it('never admits more concurrent reservations than the cap allows (model)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(coinflip.maxLiveChallenges + 3), { maxLength: 30 }), (picks) => {
        container.db = openDatabase(':memory:');
        const held: (() => void)[] = [];
        for (const pick of picks) {
          if (pick === 0 && held.length > 0) {
            held.pop()?.();
            continue;
          }
          try {
            held.push(reserveChallengeSlot('10', '1'));
          } catch (error) {
            expect(error).toBeInstanceOf(ChallengeLimitError);
          }
          expect(held.length).toBeLessThanOrEqual(coinflip.maxLiveChallenges);
        }
        for (const release of held) release();
      }),
    );
  });
});

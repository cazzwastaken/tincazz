import { container } from '@sapphire/framework';
import type { Client } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { pendingCoinflipChallenges } from '../src/db/schema.js';
import {
  clearChallenges,
  closeChallengeCard,
  liveChallengeCount,
  reopen,
  restoreChallengeCards,
  scheduleExpiry,
  trackChallengeCard,
  tryClose,
} from '../src/features/coinflip/index.js';

const json = (value: unknown) => JSON.stringify(value);
const view = (expiresAt: number) => ({
  challengerId: '1',
  opponentId: undefined,
  bet: 10,
  side: 'heads' as const,
  expiresAt,
});

function stubClient() {
  const edit = vi.fn(async (_messageId: string, _options: unknown) => ({}));
  const client = {
    channels: {
      cache: new Map(),
      fetch: vi.fn(async () => ({ isSendable: () => true, messages: { edit } })),
    },
  };
  return { client: client as unknown as Client, edit };
}

describe('challenge timers and restarts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    container.db = openDatabase(':memory:');
    container.logger = { warn: vi.fn(), error: vi.fn() } as unknown as typeof container.logger;
    clearChallenges();
  });

  afterEach(() => {
    clearChallenges();
    vi.useRealTimers();
  });

  it('re-arms a short acceptor challenge for the time that is left, not the full expiry', async () => {
    const onExpire = vi.fn(async () => undefined);
    scheduleExpiry('m', 60_000, onExpire);
    await vi.advanceTimersByTimeAsync(20_000);
    // An acceptor claims the card, cannot cover the stake and hands it back with 40s remaining.
    expect(tryClose('m')).toBe(true);
    reopen('m', 40_000);

    await vi.advanceTimersByTimeAsync(39_999);
    expect(onExpire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(tryClose('m')).toBe(false);
  });

  it('re-arms a live challenge after a restart and expires it at its original deadline', async () => {
    const original = vi.fn(async () => ({}));
    trackChallengeCard('2', 'c', 'm', view(Date.now() + 60_000), original);
    await vi.advanceTimersByTimeAsync(10_000);
    clearChallenges();

    const { client, edit } = stubClient();
    restoreChallengeCards(client);
    expect(liveChallengeCount('2', '1')).toBe(1);
    await vi.advanceTimersByTimeAsync(49_000);
    expect(edit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(edit).toHaveBeenCalledExactlyOnceWith('m', expect.anything());
    expect(json(edit.mock.calls[0])).toContain('Challenge expired.');
    expect(container.db.select().from(pendingCoinflipChallenges).all()).toEqual([]);
    expect(original).not.toHaveBeenCalled();
  });

  it('finishes a cancellation whose card edit never happened, right after a restart', async () => {
    trackChallengeCard('2', 'c', 'm', view(Date.now() + 60_000), async () => ({}));
    await closeChallengeCard('m', view(0), 'cancelled', async () => {
      throw new Error('discord down');
    }).catch(() => undefined);
    clearChallenges();

    const { client, edit } = stubClient();
    restoreChallengeCards(client);
    await vi.advanceTimersByTimeAsync(0);

    expect(json(edit.mock.calls[0])).toContain('cancelled');
    expect(container.db.select().from(pendingCoinflipChallenges).all()).toEqual([]);
  });
});

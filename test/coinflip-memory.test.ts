import { container } from '@sapphire/framework';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearChallenges,
  closedCount,
  closedMax,
  closedTtlMs,
  scheduleExpiry,
  tryClose,
} from '../src/features/coinflip/index.js';

describe('coinflip challenge memory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearChallenges();
  });

  afterEach(() => {
    clearChallenges();
    vi.useRealTimers();
  });

  it('forgets closed keys after the TTL, so the map does not grow forever', async () => {
    for (let index = 0; index < 100; index++) {
      tryClose(`m${index}`);
      tryClose(`rematch:m${index}`);
    }
    expect(closedCount()).toBe(200);
    await vi.advanceTimersByTimeAsync(closedTtlMs);
    tryClose('fresh');
    expect(closedCount()).toBe(1);
  });

  it('still refuses a second close within the TTL', async () => {
    tryClose('m');
    await vi.advanceTimersByTimeAsync(closedTtlMs - 1);
    expect(tryClose('m')).toBe(false);
  });

  it('never holds more than the cap, dropping the oldest keys first', () => {
    for (let index = 0; index < closedMax + 50; index++) {
      tryClose(`m${index}`);
    }
    expect(closedCount()).toBeLessThanOrEqual(closedMax);
    expect(tryClose(`m${closedMax + 49}`)).toBe(false);
    expect(tryClose('m0')).toBe(true);
  });

  it('keeps no timers or handlers once every challenge expired', async () => {
    for (let index = 0; index < 20; index++) {
      scheduleExpiry(`m${index}`, 60_000, async () => undefined);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(container.coinflipChallenges?.timers.size).toBe(0);
    expect(container.coinflipChallenges?.handlers.size).toBe(0);
  });
});

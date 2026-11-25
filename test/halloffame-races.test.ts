import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { getHallEntry, hallOfFame } from '../src/features/halloffame/index.js';
import {
  guildId,
  harness,
  messageId,
  people,
  sourceChannelId,
  t0,
} from './support/hall-discord.js';

let db: Db;
beforeEach(() => {
  db = openDatabase(':memory:');
  vi.useFakeTimers({ now: t0 });
});
afterEach(() => {
  vi.useRealTimers();
  closeDatabase(db);
});

const entry = () => getHallEntry(db, guildId, messageId);

/**
 * An induction whose send reached Discord but whose answer was lost, and whose card cannot be
 * found right away either: the claim stays `publishing` while the card exists.
 */
async function claimKeptWithCard() {
  const h = harness(db, vi);
  h.fake.addMessage();
  h.fake.react(messageId, '⭐', people(0, 5));
  h.fake.faults.send = 'other';
  h.fake.sendCreatesBeforeFault = true;
  h.fake.faults.fetchRecent = 'other';
  h.add('2000');
  await h.settle();
  expect(entry()?.status).toBe('publishing');
  expect(h.fake.posted.size).toBe(1);
  h.fake.faults.send = undefined;
  h.fake.faults.fetchRecent = undefined;
  return h;
}

describe('a source deleted while its claim is still publishing', () => {
  it('removes the card Discord created when the message is deleted', async () => {
    const h = await claimKeptWithCard();
    await h.runner.onSourceMessagesDeleted(guildId, [messageId]);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('removes the card Discord created when the channel is deleted', async () => {
    const h = await claimKeptWithCard();
    await h.runner.onSourceChannelDeleted(sourceChannelId);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('keeps the claim when the card cannot be looked for, and the recovery cleans up later', async () => {
    const h = await claimKeptWithCard();
    h.fake.faults.fetchRecent = 'other';
    h.warn.mockClear();
    await h.runner.onSourceMessagesDeleted(guildId, [messageId]);
    // The card exists and only the claim records it: the row must stay for the recovery.
    expect(entry()?.status).toBe('publishing');
    expect(h.fake.posted.size).toBe(1);
    expect(h.warn).toHaveBeenCalledTimes(1);

    h.fake.faults.fetchRecent = undefined;
    h.fake.messages.delete(messageId);
    await h.runner.recover({ all: true });
    await h.settle(hallOfFame.editCooldownMs);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('does the same for a deleted channel', async () => {
    const h = await claimKeptWithCard();
    h.fake.faults.fetchRecent = 'other';
    h.warn.mockClear();
    await h.runner.onSourceChannelDeleted(sourceChannelId);
    expect(entry()?.status).toBe('publishing');
    expect(h.fake.posted.size).toBe(1);
    expect(h.warn).toHaveBeenCalledTimes(1);

    h.fake.faults.fetchRecent = undefined;
    h.fake.messages.delete(messageId);
    await h.runner.recover({ all: true });
    await h.settle(hallOfFame.editCooldownMs);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('is cleaned up by the recovery once the source is found gone', async () => {
    const h = await claimKeptWithCard();
    h.fake.messages.delete(messageId);
    await h.runner.recover({ all: true });
    await h.settle(hallOfFame.editCooldownMs);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });
});

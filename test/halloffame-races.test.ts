import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { getHallEntry, hallOfFame } from '../src/features/halloffame/index.js';
import {
  channelInfo,
  guildId,
  type Harness,
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

describe('a source channel deleted while an induction is under way', () => {
  async function deletedAfterRead(h: Harness, deleteId: string) {
    let deleting: Promise<unknown> | undefined;
    h.fake.afterFetchMessage = () => {
      h.fake.afterFetchMessage = undefined;
      deleting = h.runner.onSourceChannelDeleted(deleteId);
    };
    h.add('2000');
    await h.settle();
    await deleting;
    await h.settle(hallOfFame.editCooldownMs);
  }

  it('does not claim or post for a channel that was deleted after the read', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    await deletedAfterRead(h, sourceChannelId);
    expect(h.fake.log.send).toHaveLength(0);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('does the same for a thread whose parent channel was deleted', async () => {
    const h = harness(db, vi);
    const thread = '21';
    h.fake.channels.set(
      thread,
      channelInfo(thread, 'a thread', { isThread: true, parentId: sourceChannelId }),
    );
    h.fake.addMessage({ channelId: thread });
    h.fake.react(messageId, '⭐', people(0, 6));
    h.add('2000', { channelId: thread });
    let deleting: Promise<unknown> | undefined;
    h.fake.afterFetchMessage = () => {
      h.fake.afterFetchMessage = undefined;
      deleting = h.runner.onSourceChannelDeleted(sourceChannelId);
    };
    await h.settle();
    await deleting;
    await h.settle(hallOfFame.editCooldownMs);
    expect(h.fake.log.send).toHaveLength(0);
    expect(entry()).toBeUndefined();
  });

  it('removes the card of a channel deleted while the card was being sent', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    let deleting: Promise<unknown> | undefined;
    h.fake.duringSend = () => {
      h.fake.duringSend = undefined;
      deleting = h.runner.onSourceChannelDeleted(sourceChannelId);
    };
    h.add('2000');
    await h.settle();
    await deleting;
    await h.settle(hallOfFame.editCooldownMs);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('drops reactions on the deleted channel afterwards', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    await h.runner.onSourceChannelDeleted(sourceChannelId);
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
  });
});

describe('an edit that arrives while the claim is publishing', () => {
  it('is picked up once the card is recorded', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 5));
    let release: () => void = () => undefined;
    h.fake.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.add('2000');
    await vi.advanceTimersByTimeAsync(hallOfFame.debounceMs);
    expect(entry()?.status).toBe('publishing');

    const message = h.fake.messages.get(messageId);
    if (message) message.facts.content = 'edited while posting';
    h.runner.onMessageUpdate(guildId, messageId);
    release();
    await h.runner.idle();
    expect(entry()?.status).toBe('posted');
    expect(JSON.stringify(h.fake.log.send[0]?.post.card.toJSON())).not.toContain('edited while');

    await h.settle(hallOfFame.editCooldownMs);
    expect(JSON.stringify(h.fake.log.edit.at(-1)?.post.card.toJSON())).toContain(
      'edited while posting',
    );
  });

  it('costs no edit when nothing changed', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 5));
    h.add('2000');
    await h.settle();
    await h.settle(hallOfFame.peakCooldownMs);
    expect(h.fake.log.edit).toHaveLength(0);
  });
});

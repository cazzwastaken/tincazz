import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { getHallEntry, hallCard, hallOfFame } from '../src/features/halloffame/index.js';
import {
  botId,
  guildId,
  hallChannelId,
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

const entry = (id = messageId) => getHallEntry(db, guildId, id);

/** Posts through the runner, then rewinds the row to `publishing`, as a crash before saving would. */
async function crashedAfterSend(ageMs = hallOfFame.publishStaleMs + 1) {
  const h = harness(db, vi);
  h.fake.addMessage();
  h.fake.react(messageId, '⭐', people(0, 5));
  h.add('2000');
  await h.settle();
  await h.settle(hallOfFame.peakCooldownMs);
  db.$client
    .prepare(
      `update hall_of_fame_entries set status = 'publishing', hall_message_id = null,
       peak_count = 0, last_rendered_hash = null, created_at = ?`,
    )
    .run(Date.now() - ageMs);
  return h;
}

describe('hall of fame recovery', () => {
  it('adopts the card that was sent but never recorded', async () => {
    const h = await crashedAfterSend();
    const sentId = h.fake.log.send[0]?.id;
    await h.runner.recover();

    expect(entry()).toMatchObject({ status: 'posted', hallMessageId: sentId });
    // Never a second post: the card is refreshed in place with the real count.
    await h.settle();
    expect(h.fake.log.send).toHaveLength(1);
    expect(h.fake.log.edit.at(-1)?.messageId).toBe(sentId);
    expect(entry()?.peakCount).toBe(5);
  });

  it('releases a claim whose card was never sent, so the message can be inducted', async () => {
    const h = await crashedAfterSend();
    h.fake.posted.clear();
    await h.runner.recover();
    expect(entry()).toBeUndefined();

    h.add('2001');
    await h.settle();
    expect(entry()?.status).toBe('posted');
  });

  it('leaves a fresh claim alone unless everything is abandoned, as at startup', async () => {
    const h = await crashedAfterSend(1_000);
    h.fake.posted.clear();
    await h.runner.recover();
    expect(entry()?.status).toBe('publishing');
    await h.runner.recover({ all: true });
    expect(entry()).toBeUndefined();
  });

  it('keeps the claim when the hall cannot be read, so a retry cannot double post', async () => {
    const h = await crashedAfterSend();
    h.fake.faults.fetchRecent = 'forbidden';
    await h.runner.recover();
    expect(entry()?.status).toBe('publishing');
    h.fake.faults.fetchRecent = 'other';
    await h.runner.recover();
    expect(entry()?.status).toBe('publishing');

    h.fake.faults.fetchRecent = undefined;
    await h.runner.recover();
    expect(entry()?.status).toBe('posted');
  });

  it('releases the claim when the hall channel is gone', async () => {
    const h = await crashedAfterSend();
    h.fake.faults.fetchRecent = 'unknown-channel';
    await h.runner.recover();
    expect(entry()).toBeUndefined();
  });

  it('finds the card further back in the hall channel', async () => {
    const h = await crashedAfterSend();
    const ours = h.fake.log.send[0]?.id as string;
    const other = hallCard({
      author: {
        id: '1',
        displayName: 'x',
        username: 'x',
        avatarUrl: 'https://cdn.discordapp.com/a.png',
      },
      source: { guildId, channelId: sourceChannelId, messageId: '77', createdAt: t0 },
      body: {
        forwarded: false,
        text: 'other',
        note: undefined,
        images: [],
        stickers: [],
        files: [],
        moreFiles: 0,
        embedMedia: [],
      },
      peak: 5,
      threshold: 5,
      breakdown: [],
      uploaded: [],
    });
    for (let i = 0; i < 150; i++) {
      h.fake.posted.set(String(BigInt(ours) + 1n + BigInt(i)), {
        channelId: hallChannelId,
        post: { card: other, files: [] },
      });
    }
    await h.runner.recover();
    expect(entry()).toMatchObject({ status: 'posted', hallMessageId: ours });
  });

  it('does not mistake the card of a message with a longer id for ours', async () => {
    const h = await crashedAfterSend();
    // Our card links to .../100; make the only card in the hall one that links to .../1000.
    const sent = h.fake.log.send[0];
    if (!sent) throw new Error('no card');
    const json = JSON.stringify(sent.post.card.toJSON()).replaceAll(
      `/${sourceChannelId}/${messageId}`,
      `/${sourceChannelId}/${messageId}0`,
    );
    h.fake.posted.set(sent.id, {
      channelId: hallChannelId,
      post: { card: { toJSON: () => JSON.parse(json) } as never, files: [] },
    });
    await h.runner.recover();
    expect(entry()).toBeUndefined();
  });

  it('ignores a card that someone else posted', async () => {
    const h = await crashedAfterSend();
    const sent = h.fake.log.send[0];
    if (!sent) throw new Error('no card');
    h.fake.fetchRecent = async () => [
      {
        id: sent.id,
        authorId: `not-${botId}`,
        links: [`https://discord.com/channels/${guildId}/${sourceChannelId}/${messageId}`],
      },
    ];
    await h.runner.recover();
    expect(entry()).toBeUndefined();
  });

  it('does nothing for entries that are already posted', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 5));
    h.add('2000');
    await h.settle();
    const before = entry();
    await h.runner.recover({ all: true });
    expect(entry()).toEqual(before);
  });
});

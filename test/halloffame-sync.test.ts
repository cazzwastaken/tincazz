import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import {
  addHallExempt,
  bumpHallPeak,
  claimHallEntry,
  getHallEntry,
  hallOfFame,
  markHallPosted,
  setHallChannel,
} from '../src/features/halloffame/index.js';
import {
  authorId,
  channelInfo,
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

const entry = () => getHallEntry(db, guildId, messageId);
const image = (n: number) => ({
  id: String(n),
  name: `pic${n}.png`,
  url: `https://cdn.discordapp.com/attachments/1/${n}/pic${n}.png?ex=1`,
  size: 1000,
  contentType: 'image/png',
});

/** A posted entry made through the runner itself, so card, hash and row agree. */
async function posted(options: { images?: number } = {}) {
  const h = harness(db, vi);
  h.fake.addMessage({
    facts: {
      content: 'a fine message',
      attachments: Array.from({ length: options.images ?? 0 }, (_, i) => image(i)),
      stickers: [],
      embeds: [],
      snapshots: [],
    },
  });
  h.fake.react(messageId, '⭐', people(0, 5));
  h.add('2000');
  await h.settle();
  // Past the refinement's cooldown too, so the entry is quiet.
  await h.settle(hallOfFame.peakCooldownMs);
  return h;
}

describe('hall of fame sync', () => {
  it('raises the peak and edits the card when more people react', async () => {
    const h = await posted();
    const before = entry();
    h.fake.react(messageId, '⭐', people(0, 9));
    h.add('3000');
    await h.settle();
    await h.settle(hallOfFame.peakCooldownMs);

    const row = entry();
    expect(row?.peakCount).toBe(9);
    expect(row?.lastRenderedHash).not.toBe(before?.lastRenderedHash);
    const edit = h.fake.log.edit.at(-1);
    expect(edit?.messageId).toBe(before?.hallMessageId);
    expect(JSON.stringify(edit?.post.card.toJSON())).toContain('**9** people');
  });

  it('does not edit when nothing about the card changed', async () => {
    const h = await posted();
    const edits = h.fake.log.edit.length;
    const hash = entry()?.lastRenderedHash;
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(h.fake.log.edit).toHaveLength(edits);
    expect(entry()?.lastRenderedHash).toBe(hash);
  });

  it('skips the image downloads of an unchanged card', async () => {
    const h = await posted({ images: 2 });
    const downloads = h.fake.log.downloaded.length;
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(h.fake.log.downloaded).toHaveLength(downloads);
    expect(h.fake.log.edit).toHaveLength(0);
  });

  it('re-uploads the images with every edit, and drops one the author removed', async () => {
    const h = await posted({ images: 2 });
    expect(h.fake.log.send[0]?.post.files.map((f) => f.name)).toEqual(['hall-0.png', 'hall-1.png']);

    const message = h.fake.messages.get(messageId);
    if (!message) throw new Error('missing');
    message.facts = { ...message.facts, content: 'edited text' };
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    const first = h.fake.log.edit.at(-1);
    expect(first?.post.files.map((f) => f.name)).toEqual(['hall-0.png', 'hall-1.png']);
    expect(JSON.stringify(first?.post.card.toJSON())).toContain('edited text');

    message.facts = { ...message.facts, attachments: [image(0)] };
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    const second = h.fake.log.edit.at(-1);
    expect(second?.post.files.map((f) => f.name)).toEqual(['hall-0.png']);
    expect(JSON.stringify(second?.post.card.toJSON())).not.toContain('hall-1.png');
  });

  it('retries a failed image on the next sync instead of caching the failure', async () => {
    const h = await posted({ images: 1 });
    const message = h.fake.messages.get(messageId);
    if (!message) throw new Error('missing');
    message.facts = { ...message.facts, content: 'changed' };
    h.fake.downloads.set(image(0).url, new Error('cdn down'));
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(h.fake.log.edit.at(-1)?.post.files).toEqual([]);

    h.fake.downloads.delete(image(0).url);
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(h.fake.log.edit.at(-1)?.post.files.map((f) => f.name)).toEqual(['hall-0.png']);
  });

  it('never lowers the peak, whatever order syncs finish in', async () => {
    const h = await posted();
    h.fake.react(messageId, '⭐', people(0, 8));
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(entry()?.peakCount).toBe(8);

    h.fake.react(messageId, '⭐', people(0, 6));
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(entry()?.peakCount).toBe(8);
    expect(JSON.stringify(h.fake.log.edit.at(-1)?.post.card.toJSON())).toContain('**8** people');

    // Removing reactions only refreshes.
    h.fake.react(messageId, '⭐', []);
    h.runner.onReactionChange({ guildId, channelId: sourceChannelId, messageId });
    await h.settle(hallOfFame.peakCooldownMs);
    expect(entry()?.peakCount).toBe(8);
    expect(entry()?.status).toBe('posted');
  });

  it('peak writes are MAX at the store, so a slow older sync cannot lower it', async () => {
    const h = await posted();
    const row = entry();
    if (!row) throw new Error('missing');
    bumpHallPeak(db, guildId, messageId, 12, t0);
    bumpHallPeak(db, guildId, messageId, 7, t0);
    expect(entry()?.peakCount).toBe(12);
    h.runner.stop();
  });

  it('defers reaction work inside the cooldown instead of dropping it', async () => {
    const h = await posted();
    h.fake.react(messageId, '⭐', people(0, 7));
    h.add('3000');
    await h.settle();
    // First sync after the cooldown has long passed: runs immediately.
    expect(entry()?.peakCount).toBe(7);

    h.fake.react(messageId, '⭐', people(0, 11));
    h.add('3001');
    await h.settle(hallOfFame.debounceMs);
    expect(entry()?.peakCount).toBe(7);

    await h.settle(hallOfFame.peakCooldownMs);
    expect(entry()?.peakCount).toBe(11);
  });

  it('coalesces a burst of reactions into one sync', async () => {
    const h = await posted();
    const fetched = h.fake.log.fetchMessage;
    h.fake.react(messageId, '⭐', people(0, 9));
    for (const user of people(20, 4)) h.add(user);
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(fetched + 1);
  });

  it('holds a steady stream of reactions back no longer than the maximum wait', async () => {
    const h = await posted();
    const fetched = h.fake.log.fetchMessage;
    for (let i = 0; i < 20; i++) {
      h.add(String(4000 + i));
      await vi.advanceTimersByTimeAsync(hallOfFame.debounceMs - 1_000);
    }
    await h.runner.idle();
    expect(h.fake.log.fetchMessage).toBeGreaterThan(fetched);
  });

  it('deletes the row before the hall message when the source is gone', async () => {
    const h = await posted();
    const hallId = entry()?.hallMessageId as string;
    let rowWhenDeleted: unknown = 'unset';
    h.fake.beforeDelete = () => {
      rowWhenDeleted = entry();
    };
    h.fake.messages.delete(messageId);
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();

    expect(rowWhenDeleted).toBeUndefined();
    expect(h.fake.log.deleted).toEqual([{ channelId: hallChannelId, messageId: hallId }]);
    expect(entry()).toBeUndefined();
    // Our own delete event finds no row, so nothing is tombstoned.
    expect(h.runner.onHallMessagesDeleted(guildId, [hallId])).toEqual([]);
  });

  it('removes the hall post when the source message is deleted', async () => {
    const h = await posted();
    const hallId = entry()?.hallMessageId as string;
    let rowWhenDeleted: unknown = 'unset';
    h.fake.beforeDelete = () => {
      rowWhenDeleted = entry();
    };
    await h.runner.onSourceMessagesDeleted(guildId, [messageId, '999']);
    expect(rowWhenDeleted).toBeUndefined();
    expect(h.fake.posted.has(hallId)).toBe(false);
    expect(entry()).toBeUndefined();
  });

  it('removes the hall posts of a deleted source channel', async () => {
    const h = await posted();
    const rows = await h.runner.onSourceChannelDeleted(sourceChannelId);
    expect(rows).toHaveLength(1);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('removes the hall posts of threads when their parent channel is deleted', async () => {
    const h = harness(db, vi);
    const thread = '21';
    h.fake.channels.set(
      thread,
      channelInfo(thread, 'a thread', { isThread: true, parentId: sourceChannelId }),
    );
    // One message from a thread of the source channel, one from an unrelated channel.
    h.fake.addMessage({ channelId: thread });
    h.fake.react(messageId, '⭐', people(0, 5));
    h.add('2000', { channelId: thread });
    await h.settle(hallOfFame.peakCooldownMs);
    h.fake.channels.set('22', channelInfo('22', 'elsewhere'));
    h.fake.addMessage({ id: '101', channelId: '22' });
    h.fake.react('101', '⭐', people(0, 5));
    h.add('2001', { messageId: '101', channelId: '22' });
    await h.settle(hallOfFame.peakCooldownMs);
    expect(h.fake.posted.size).toBe(2);
    expect(entry()).toMatchObject({ channelId: thread, parentChannelId: sourceChannelId });

    // Discord sends no thread delete when the parent goes, only the channel delete.
    const rows = await h.runner.onSourceChannelDeleted(sourceChannelId);
    expect(rows.map((row) => row.messageId)).toEqual([messageId]);
    expect(entry()).toBeUndefined();
    expect(h.fake.posted.size).toBe(1);
    expect(getHallEntry(db, guildId, '101')).toBeDefined();
  });

  it('makes a tombstone of a deleted hall post, and never posts it again', async () => {
    const h = await posted();
    const hallId = entry()?.hallMessageId as string;
    const rows = h.runner.onHallMessagesDeleted(guildId, [hallId]);
    expect(rows).toHaveLength(1);
    expect(entry()?.status).toBe('removed');

    h.fake.react(messageId, '⭐', people(0, 12));
    h.add('3000');
    await h.settle(hallOfFame.peakCooldownMs);
    expect(h.fake.log.send).toHaveLength(1);
    expect(entry()?.status).toBe('removed');
  });

  it('tombstones when an edit finds the hall post gone', async () => {
    const h = await posted();
    const hallId = entry()?.hallMessageId as string;
    h.fake.posted.delete(hallId);
    h.fake.react(messageId, '⭐', people(0, 9));
    h.add('3000');
    await h.settle();
    expect(entry()?.status).toBe('removed');
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('does not tombstone on missing permissions or a transient error', async () => {
    const h = await posted();
    h.fake.react(messageId, '⭐', people(0, 9));
    h.fake.faults.edit = 'forbidden';
    h.add('3000');
    await h.settle();
    expect(entry()?.status).toBe('posted');

    h.fake.faults.edit = 'other';
    h.fake.react(messageId, '⭐', people(0, 10));
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(entry()?.status).toBe('posted');
    expect(h.warn).toHaveBeenCalled();

    // The next sync still brings the card up to date.
    h.fake.faults.edit = undefined;
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(JSON.stringify(h.fake.log.edit.at(-1)?.post.card.toJSON())).toContain('**10** people');
  });

  it('leaves the card alone when the reactors cannot be counted', async () => {
    const h = await posted();
    const edits = h.fake.log.edit.length;
    h.fake.faults.fetchReactors = 'other';
    h.fake.react(messageId, '⭐', people(0, 9));
    h.runner.onMessageUpdate(guildId, messageId);
    await h.settle();
    expect(h.fake.log.edit).toHaveLength(edits);
    expect(entry()?.peakCount).toBe(5);
  });

  it('keeps editing a post in the old hall channel after the hall changed', async () => {
    const h = await posted();
    h.fake.channels.set('31', channelInfo('31', 'hall-2'));
    setHallChannel(db, guildId, '31', t0);
    h.fake.react(messageId, '⭐', people(0, 9));
    h.add('3000');
    await h.settle();
    expect(h.fake.log.edit.at(-1)?.channelId).toBe(hallChannelId);
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('forgets the entries of a deleted hall channel', async () => {
    const h = await posted();
    expect(h.runner.onHallChannelDeleted(hallChannelId)).toHaveLength(1);
    expect(entry()).toBeUndefined();
  });

  it('ignores a message update for a message that is not in the hall', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.runner.onMessageUpdate(guildId, messageId);
    h.runner.onReactionChange({ guildId, channelId: sourceChannelId, messageId });
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
  });

  it('does not edit a claim that is still being published', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    claimHallEntry(
      db,
      { guildId, messageId, channelId: sourceChannelId, authorId, hallChannelId },
      t0,
    );
    h.runner.onMessageUpdate(guildId, messageId);
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
    markHallPosted(
      db,
      guildId,
      messageId,
      { hallMessageId: '1', peakCount: 5, renderedHash: 'x' },
      t0,
    );
  });

  describe('a source channel that became ineligible after the induction', () => {
    const edited = async (h: Awaited<ReturnType<typeof posted>>) => {
      const message = h.fake.messages.get(messageId);
      if (!message) throw new Error('missing');
      message.facts = { ...message.facts, content: 'a secret added later' };
      h.fake.react(messageId, '⭐', people(0, 9));
      h.runner.onMessageUpdate(guildId, messageId);
      await h.settle();
    };
    const frozen = (h: Awaited<ReturnType<typeof posted>>, reason: string) => {
      expect(h.fake.log.edit).toHaveLength(0);
      expect(entry()?.peakCount).toBe(5);
      expect(h.fake.log.deleted).toHaveLength(0);
      expect(h.debug).toHaveBeenCalledWith(expect.stringContaining(reason));
    };

    it('stops copying edits once the channel is exempt', async () => {
      const h = await posted();
      addHallExempt(db, guildId, sourceChannelId, t0);
      await edited(h);
      frozen(h, 'exempt');
    });

    it('stops copying edits once the channel is exempt through its category', async () => {
      const h = await posted();
      h.fake.channels.set(
        sourceChannelId,
        channelInfo(sourceChannelId, 'memes', { categoryId: '77' }),
      );
      addHallExempt(db, guildId, '77', t0);
      await edited(h);
      frozen(h, 'exempt');
    });

    it('stops copying edits once the channel is private and the hall is public', async () => {
      const h = await posted();
      h.fake.channels.set(
        sourceChannelId,
        channelInfo(sourceChannelId, 'memes', { audience: ['staff-role'] }),
      );
      await edited(h);
      frozen(h, 'audience-mismatch');
    });

    it('stops copying edits once a role that cannot see the source can see the hall', async () => {
      const h = await posted();
      // The source is for staff only, and a members-only hall would show it to members.
      h.fake.channels.set(
        sourceChannelId,
        channelInfo(sourceChannelId, 'staff', { audience: ['staff'] }),
      );
      h.fake.channels.set(
        hallChannelId,
        channelInfo(hallChannelId, 'hall', { audience: ['member'] }),
      );
      await edited(h);
      frozen(h, 'audience-mismatch');
    });

    it('stops copying edits once the channel is age-restricted and the hall is not', async () => {
      const h = await posted();
      h.fake.channels.set(sourceChannelId, channelInfo(sourceChannelId, 'memes', { nsfw: true }));
      await edited(h);
      frozen(h, 'nsfw-to-sfw');
    });

    it('stops copying edits when the source turned out to be a private thread', async () => {
      const h = await posted();
      h.fake.channels.set(
        sourceChannelId,
        channelInfo(sourceChannelId, 'memes', { isThread: true, isPrivateThread: true }),
      );
      await edited(h);
      frozen(h, 'private-thread');
    });

    it('stops copying edits when the hall channel cannot be resolved', async () => {
      const h = await posted();
      h.fake.channels.delete(hallChannelId);
      await edited(h);
      frozen(h, 'unavailable');
    });

    it('resumes once the channel is eligible again', async () => {
      const h = await posted();
      addHallExempt(db, guildId, sourceChannelId, t0);
      await edited(h);
      expect(h.fake.log.edit).toHaveLength(0);
      db.$client.prepare('delete from guild_hall_exempt_channels').run();
      h.runner.onMessageUpdate(guildId, messageId);
      await h.settle();
      expect(JSON.stringify(h.fake.log.edit.at(-1)?.post.card.toJSON())).toContain(
        'a secret added later',
      );
    });

    it('still deletes the hall post when the source is deleted', async () => {
      const h = await posted();
      const hallId = entry()?.hallMessageId as string;
      addHallExempt(db, guildId, sourceChannelId, t0);
      h.fake.messages.delete(messageId);
      h.runner.onMessageUpdate(guildId, messageId);
      await h.settle();
      expect(entry()).toBeUndefined();
      expect(h.fake.posted.has(hallId)).toBe(false);

      const again = await posted();
      addHallExempt(db, guildId, sourceChannelId, t0);
      const row = entry()?.hallMessageId as string;
      await again.runner.onSourceMessagesDeleted(guildId, [messageId]);
      expect(entry()).toBeUndefined();
      expect(again.fake.posted.has(row)).toBe(false);
    });
  });
});

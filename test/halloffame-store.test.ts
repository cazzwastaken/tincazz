import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { hallOfFame, hallTiers } from '../src/features/halloffame/config.js';
import {
  abandonedHallClaims,
  addHallExempt,
  bumpHallPeak,
  claimHallEntry,
  clearHallChannelEverywhere,
  deleteHallEntries,
  deleteHallEntriesByHallChannel,
  deleteHallEntriesBySourceChannel,
  deleteHallEntry,
  getHallEntry,
  getHallEntryByHallMessage,
  type HallClaim,
  hallExemptChannels,
  hallSettings,
  markHallMessagesRemoved,
  markHallPosted,
  releaseHallClaim,
  removeExemptEverywhere,
  removeHallExempt,
  setHallChannel,
  setHallRenderedHash,
  setHallThreshold,
} from '../src/features/halloffame/store.js';
import { logChannelId, setLogChannel } from '../src/features/settings/store.js';

const claim = (messageId = 'm1', overrides: Partial<HallClaim> = {}): HallClaim => ({
  guildId: 'g1',
  messageId,
  channelId: 'c1',
  authorId: 'a1',
  hallChannelId: 'h1',
  ...overrides,
});

function post(db: Db, messageId = 'm1', hallMessageId = `hm-${messageId}`, peak = 5) {
  claimHallEntry(db, claim(messageId), 10);
  return markHallPosted(
    db,
    'g1',
    messageId,
    { hallMessageId, peakCount: peak, renderedHash: 'x' },
    11,
  );
}

describe('hall of fame config', () => {
  it('orders the tiers by ratio and ends open ended', () => {
    const bounds = hallTiers.map((tier) => tier.below);
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));
    expect(bounds.at(-1)).toBe(Number.POSITIVE_INFINITY);
    expect(hallOfFame.defaultThreshold).toBeGreaterThanOrEqual(hallOfFame.minThreshold);
    expect(hallOfFame.defaultThreshold).toBeLessThanOrEqual(hallOfFame.maxThreshold);
  });
});

describe('hall of fame settings', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('defaults to off with the default threshold', () => {
    expect(hallSettings(db, 'g1')).toEqual({ channelId: undefined, threshold: 5 });
  });

  it('round-trips the channel and returns the previous settings', () => {
    expect(setHallChannel(db, 'g1', '70', 1)).toEqual({ channelId: undefined, threshold: 5 });
    expect(hallSettings(db, 'g1')).toEqual({ channelId: '70', threshold: 5 });
    expect(setHallChannel(db, 'g1', '71', 2)).toEqual({ channelId: '70', threshold: 5 });
    expect(setHallChannel(db, 'g1', null, 3)).toEqual({ channelId: '71', threshold: 5 });
    expect(hallSettings(db, 'g1').channelId).toBeUndefined();
  });

  it('round-trips the threshold and keeps it when the channel changes', () => {
    expect(setHallThreshold(db, 'g1', 12, 1)).toEqual({ channelId: undefined, threshold: 5 });
    setHallChannel(db, 'g1', '70', 2);
    expect(hallSettings(db, 'g1')).toEqual({ channelId: '70', threshold: 12 });
    setHallChannel(db, 'g1', null, 3);
    expect(setHallThreshold(db, 'g1', 7, 4)).toEqual({ channelId: undefined, threshold: 12 });
    expect(hallSettings(db, 'g1').threshold).toBe(7);
  });

  it('does not disturb other guild settings and is per guild', () => {
    setLogChannel(db, 'g1', 'mod', '9', 1);
    setHallChannel(db, 'g1', '70', 2);
    setHallThreshold(db, 'g1', 9, 3);
    expect(logChannelId(db, 'g1', 'mod')).toBe('9');
    expect(hallSettings(db, 'g2')).toEqual({ channelId: undefined, threshold: 5 });
  });

  it('clears a deleted hall channel in every guild that used it', () => {
    setHallChannel(db, 'g1', '70', 1);
    setHallChannel(db, 'g2', '70', 1);
    setHallChannel(db, 'g3', '71', 1);
    expect(clearHallChannelEverywhere(db, '70', 2).sort()).toEqual(['g1', 'g2']);
    expect(hallSettings(db, 'g1').channelId).toBeUndefined();
    expect(hallSettings(db, 'g3').channelId).toBe('71');
    expect(clearHallChannelEverywhere(db, '70', 3)).toEqual([]);
  });
});

describe('hall of fame exempt channels', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('adds, lists in order, rejects duplicates and removes', () => {
    expect(addHallExempt(db, 'g1', 'c2', 1)).toBe('added');
    expect(addHallExempt(db, 'g1', 'c1', 2)).toBe('added');
    expect(addHallExempt(db, 'g1', 'c2', 3)).toBe('exists');
    expect(hallExemptChannels(db, 'g1')).toEqual(['c2', 'c1']);
    expect(hallExemptChannels(db, 'g2')).toEqual([]);
    expect(removeHallExempt(db, 'g1', 'c2')).toBe(true);
    expect(removeHallExempt(db, 'g1', 'c2')).toBe(false);
    expect(hallExemptChannels(db, 'g1')).toEqual(['c1']);
  });

  it('caps the list per guild', () => {
    for (let i = 0; i < hallOfFame.maxExemptChannels; i++) {
      expect(addHallExempt(db, 'g1', `c${i}`, i)).toBe('added');
    }
    expect(addHallExempt(db, 'g1', 'extra', 99)).toBe('full');
    expect(addHallExempt(db, 'g1', 'c0', 99)).toBe('exists');
    expect(addHallExempt(db, 'g2', 'extra', 99)).toBe('added');
    expect(removeHallExempt(db, 'g1', 'c0')).toBe(true);
    expect(addHallExempt(db, 'g1', 'extra', 100)).toBe('added');
  });

  it('removes a deleted channel from every guild and returns them', () => {
    addHallExempt(db, 'g1', 'c1', 1);
    addHallExempt(db, 'g2', 'c1', 1);
    addHallExempt(db, 'g2', 'c2', 1);
    expect(removeExemptEverywhere(db, 'c1').sort()).toEqual(['g1', 'g2']);
    expect(hallExemptChannels(db, 'g1')).toEqual([]);
    expect(hallExemptChannels(db, 'g2')).toEqual(['c2']);
    expect(removeExemptEverywhere(db, 'c1')).toEqual([]);
  });
});

describe('hall of fame migration', () => {
  it('creates both tables, the unique hall message index and the settings columns', () => {
    const db = openDatabase(':memory:');
    const names = (sql: string) => db.$client.prepare(sql).pluck().all() as string[];
    expect(
      names(
        "select name from sqlite_master where type = 'table' and name in ('guild_hall_exempt_channels', 'hall_of_fame_entries')",
      ).sort(),
    ).toEqual(['guild_hall_exempt_channels', 'hall_of_fame_entries']);
    expect(names("select name from pragma_table_info('guild_settings')")).toEqual(
      expect.arrayContaining(['hall_channel_id', 'hall_threshold']),
    );
    expect(
      names(
        "select name from pragma_index_list('hall_of_fame_entries') where \"unique\" = 1 and origin = 'c'",
      ),
    ).toHaveLength(1);
  });
});

describe('hall of fame entries', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('claims once: a second claim sees the first, whatever its status', () => {
    const first = claimHallEntry(db, claim(), 10);
    expect(first.kind).toBe('claimed');
    expect(first.entry).toMatchObject({
      status: 'publishing',
      hallMessageId: null,
      peakCount: 0,
      createdAt: 10,
    });
    const second = claimHallEntry(db, claim('m1', { hallChannelId: 'other' }), 20);
    expect(second.kind).toBe('existing');
    expect(second.entry).toMatchObject({
      status: 'publishing',
      hallChannelId: 'h1',
      createdAt: 10,
    });

    markHallPosted(db, 'g1', 'm1', { hallMessageId: 'hm', peakCount: 6, renderedHash: 'h' }, 30);
    expect(claimHallEntry(db, claim(), 40)).toMatchObject({
      kind: 'existing',
      entry: { status: 'posted', hallMessageId: 'hm' },
    });
  });

  it('lets exactly one of many racing claims win', () => {
    const results = Array.from({ length: 25 }, (_, i) => claimHallEntry(db, claim(), i));
    expect(results.filter((result) => result.kind === 'claimed')).toHaveLength(1);
    expect(results[0]?.kind).toBe('claimed');
  });

  it('claims the same message id in different guilds independently', () => {
    expect(claimHallEntry(db, claim('m1'), 1).kind).toBe('claimed');
    expect(claimHallEntry(db, claim('m1', { guildId: 'g2' }), 1).kind).toBe('claimed');
  });

  it('marks a claim posted with its hall message, peak and hash', () => {
    claimHallEntry(db, claim(), 10);
    const posted = markHallPosted(
      db,
      'g1',
      'm1',
      { hallMessageId: 'hm', peakCount: 7, renderedHash: 'abc' },
      11,
    );
    expect(posted).toMatchObject({
      status: 'posted',
      hallMessageId: 'hm',
      peakCount: 7,
      lastRenderedHash: 'abc',
      updatedAt: 11,
    });
    expect(getHallEntry(db, 'g1', 'm1')).toEqual(posted);
    expect(getHallEntryByHallMessage(db, 'g1', 'hm')).toEqual(posted);
    expect(getHallEntryByHallMessage(db, 'g2', 'hm')).toBeUndefined();
  });

  it('refuses to mark posted when the claim is gone or already posted', () => {
    const details = { hallMessageId: 'hm', peakCount: 5, renderedHash: 'h' };
    expect(markHallPosted(db, 'g1', 'm1', details, 1)).toBeUndefined();
    claimHallEntry(db, claim(), 1);
    deleteHallEntry(db, 'g1', 'm1');
    expect(markHallPosted(db, 'g1', 'm1', details, 2)).toBeUndefined();
    expect(getHallEntryByHallMessage(db, 'g1', 'hm')).toBeUndefined();

    expect(post(db)).toBeDefined();
    expect(
      markHallPosted(db, 'g1', 'm1', { ...details, hallMessageId: 'second' }, 3),
    ).toBeUndefined();
    expect(getHallEntry(db, 'g1', 'm1')?.hallMessageId).toBe('hm-m1');
  });

  it('keeps hall message ids unique', () => {
    post(db, 'm1', 'same');
    claimHallEntry(db, claim('m2'), 1);
    expect(() =>
      markHallPosted(db, 'g1', 'm2', { hallMessageId: 'same', peakCount: 5, renderedHash: 'h' }, 2),
    ).toThrow();
  });

  it('releases only a claim that is still publishing, so the message can retry', () => {
    claimHallEntry(db, claim(), 1);
    expect(releaseHallClaim(db, 'g1', 'm1')).toBe(true);
    expect(releaseHallClaim(db, 'g1', 'm1')).toBe(false);
    expect(claimHallEntry(db, claim(), 2).kind).toBe('claimed');

    post(db, 'm2');
    expect(releaseHallClaim(db, 'g1', 'm2')).toBe(false);
    expect(getHallEntry(db, 'g1', 'm2')?.status).toBe('posted');
  });

  it('never lowers the peak and returns the row to render', () => {
    post(db, 'm1', 'hm', 5);
    expect(bumpHallPeak(db, 'g1', 'm1', 9, 20)?.peakCount).toBe(9);
    expect(bumpHallPeak(db, 'g1', 'm1', 6, 21)?.peakCount).toBe(9);
    expect(bumpHallPeak(db, 'g1', 'm1', 0, 22)?.peakCount).toBe(9);
    expect(bumpHallPeak(db, 'g1', 'm1', 9, 23)?.peakCount).toBe(9);
    expect(getHallEntry(db, 'g1', 'm1')?.peakCount).toBe(9);
  });

  it('only bumps posted entries', () => {
    expect(bumpHallPeak(db, 'g1', 'm1', 9, 1)).toBeUndefined();
    claimHallEntry(db, claim(), 1);
    expect(bumpHallPeak(db, 'g1', 'm1', 9, 2)).toBeUndefined();
    expect(getHallEntry(db, 'g1', 'm1')?.peakCount).toBe(0);
    post(db, 'm2', 'hm2');
    markHallMessagesRemoved(db, ['hm2'], 3);
    expect(bumpHallPeak(db, 'g1', 'm2', 99, 4)).toBeUndefined();
  });

  it('keeps the highest peak when a post races a higher count', () => {
    claimHallEntry(db, claim(), 1);
    const posted = markHallPosted(
      db,
      'g1',
      'm1',
      { hallMessageId: 'hm', peakCount: 3, renderedHash: 'h' },
      2,
    );
    expect(posted?.peakCount).toBe(3);
  });

  it('stores the rendered hash of posted entries only', () => {
    expect(setHallRenderedHash(db, 'g1', 'm1', 'a', 1)).toBe(false);
    post(db);
    expect(setHallRenderedHash(db, 'g1', 'm1', 'b', 30)).toBe(true);
    expect(getHallEntry(db, 'g1', 'm1')).toMatchObject({ lastRenderedHash: 'b', updatedAt: 30 });
  });

  it('tombstones a deleted hall post and blocks any re-claim', () => {
    post(db, 'm1', 'hm1');
    post(db, 'm2', 'hm2');
    const removed = markHallMessagesRemoved(db, ['hm1', 'unknown'], 40);
    expect(removed.map((row) => row.messageId)).toEqual(['m1']);
    expect(getHallEntry(db, 'g1', 'm1')).toMatchObject({ status: 'removed', hallMessageId: 'hm1' });
    expect(getHallEntry(db, 'g1', 'm2')?.status).toBe('posted');

    expect(claimHallEntry(db, claim('m1'), 50)).toMatchObject({
      kind: 'existing',
      entry: { status: 'removed' },
    });
    expect(markHallMessagesRemoved(db, ['hm1'], 60)).toEqual([]);
    expect(releaseHallClaim(db, 'g1', 'm1')).toBe(false);
    expect(markHallMessagesRemoved(db, [], 61)).toEqual([]);
  });

  it('does not tombstone a row that was deleted first (source deleted before the hall post)', () => {
    post(db, 'm1', 'hm1');
    const deleted = deleteHallEntry(db, 'g1', 'm1');
    expect(deleted).toMatchObject({ status: 'posted', hallMessageId: 'hm1' });
    // The caller now deletes the hall message; its delete event finds nothing to tombstone.
    expect(markHallMessagesRemoved(db, ['hm1'], 5)).toEqual([]);
    expect(getHallEntry(db, 'g1', 'm1')).toBeUndefined();
  });

  it('deletes by source message, returning the row once', () => {
    post(db, 'm1');
    expect(deleteHallEntry(db, 'g1', 'm2')).toBeUndefined();
    expect(deleteHallEntry(db, 'g2', 'm1')).toBeUndefined();
    expect(deleteHallEntry(db, 'g1', 'm1')?.hallMessageId).toBe('hm-m1');
    expect(deleteHallEntry(db, 'g1', 'm1')).toBeUndefined();
    // Deleting the source also forgets a tombstone, which can no longer matter.
    post(db, 'm3', 'hm3');
    markHallMessagesRemoved(db, ['hm3'], 1);
    expect(deleteHallEntry(db, 'g1', 'm3')?.status).toBe('removed');
  });

  it('deletes a bulk of source messages in one guild', () => {
    post(db, 'm1');
    post(db, 'm2');
    post(db, 'm3');
    claimHallEntry(db, claim('m4', { guildId: 'g2' }), 1);
    const rows = deleteHallEntries(db, 'g1', ['m1', 'm3', 'm4', 'nope']);
    expect(rows.map((row) => row.messageId).sort()).toEqual(['m1', 'm3']);
    expect(getHallEntry(db, 'g1', 'm2')).toBeDefined();
    expect(getHallEntry(db, 'g2', 'm4')).toBeDefined();
    expect(deleteHallEntries(db, 'g1', [])).toEqual([]);
  });

  it('deletes by source channel, thread included', () => {
    claimHallEntry(db, claim('m1', { channelId: 'c1' }), 1);
    claimHallEntry(db, claim('m2', { channelId: 'c1' }), 1);
    claimHallEntry(db, claim('m3', { channelId: 'thread' }), 1);
    const rows = deleteHallEntriesBySourceChannel(db, 'c1');
    expect(rows.map((row) => row.messageId).sort()).toEqual(['m1', 'm2']);
    expect(getHallEntry(db, 'g1', 'm3')).toBeDefined();
    expect(deleteHallEntriesBySourceChannel(db, 'c1')).toEqual([]);
  });

  it('deletes the entries of threads when their parent channel is deleted', () => {
    claimHallEntry(db, claim('m1', { channelId: 'c1' }), 1);
    claimHallEntry(db, claim('m2', { channelId: 't1', parentChannelId: 'c1' }), 1);
    claimHallEntry(db, claim('m3', { channelId: 't2', parentChannelId: 'c1' }), 1);
    claimHallEntry(db, claim('m4', { channelId: 't3', parentChannelId: 'c2' }), 1);
    claimHallEntry(db, claim('m5', { channelId: 'c3' }), 1);
    expect(getHallEntry(db, 'g1', 'm2')?.parentChannelId).toBe('c1');
    expect(getHallEntry(db, 'g1', 'm1')?.parentChannelId).toBeNull();
    const rows = deleteHallEntriesBySourceChannel(db, 'c1');
    expect(rows.map((row) => row.messageId).sort()).toEqual(['m1', 'm2', 'm3']);
    expect(getHallEntry(db, 'g1', 'm4')).toBeDefined();
    expect(getHallEntry(db, 'g1', 'm5')).toBeDefined();
    // A deleted thread still matches by its own id.
    expect(deleteHallEntriesBySourceChannel(db, 't3').map((row) => row.messageId)).toEqual(['m4']);
  });

  it('deletes by hall channel, leaving entries in another hall channel', () => {
    post(db, 'm1');
    claimHallEntry(db, claim('m2'), 1);
    claimHallEntry(db, claim('m3', { hallChannelId: 'h2' }), 1);
    const rows = deleteHallEntriesByHallChannel(db, 'h1');
    expect(rows.map((row) => row.messageId).sort()).toEqual(['m1', 'm2']);
    expect(getHallEntry(db, 'g1', 'm3')?.hallChannelId).toBe('h2');
  });

  it('lists only publishing claims older than the cutoff, oldest first', () => {
    claimHallEntry(db, claim('old2'), 20);
    claimHallEntry(db, claim('old1'), 10);
    claimHallEntry(db, claim('fresh'), 100);
    post(db, 'done');
    expect(abandonedHallClaims(db, 50).map((row) => row.messageId)).toEqual(['old1', 'old2']);
    expect(abandonedHallClaims(db, 10)).toEqual([]);
    releaseHallClaim(db, 'g1', 'old1');
    expect(abandonedHallClaims(db, 50).map((row) => row.messageId)).toEqual(['old2']);
  });
});

import { MessageType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import {
  addHallExempt,
  getHallEntry,
  hallOfFame,
  setHallChannel,
} from '../src/features/halloffame/index.js';
import { setHoneypot } from '../src/features/honeypot/index.js';
import {
  authorId,
  botId,
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

describe('hall of fame induction', () => {
  it('posts a message that enough distinct people reacted to', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 3));
    h.fake.react(messageId, '🔥', people(2, 3));

    for (const user of people(0, 5)) h.add(user);
    await h.settle();

    expect(h.fake.log.send).toHaveLength(1);
    const sent = h.fake.log.send[0];
    expect(sent?.channelId).toBe(hallChannelId);
    expect(sent?.post.nonce).toBe(messageId);
    const row = entry();
    expect(row).toMatchObject({
      status: 'posted',
      hallMessageId: sent?.id,
      peakCount: 5,
      hallChannelId,
      authorId,
    });
    expect(row?.lastRenderedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('waits for the debounce and fetches once for a burst', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    for (const user of people(0, 6)) h.add(user);
    expect(h.fake.log.fetchMessage).toBe(0);
    await h.settle(hallOfFame.debounceMs - 1);
    expect(h.fake.log.fetchMessage).toBe(0);
    await h.settle(1);
    expect(h.fake.log.fetchMessage).toBe(1);
  });

  it('does not post below the threshold and skips fetching until enough adds could matter', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 2));
    h.add(people(0, 1)[0] as string);
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);
    expect(entry()).toBeUndefined();
    expect(h.fake.log.fetchMessage).toBe(1);

    // 2 of 5 people so far: three more adds are needed before it can qualify.
    h.add('2000');
    h.add('2001');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);

    h.fake.react(messageId, '⭐', people(0, 5));
    h.add('2002');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(2);
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('counts a person once however many emoji they use', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    for (const emoji of ['⭐', '🔥', '😂', '👍', '❤️', '🎉'])
      h.fake.react(messageId, emoji, ['2000']);
    h.add('2000');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);
    expect(entry()).toBeUndefined();
  });

  it('never counts the author or bots', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', [authorId, ...people(0, 3)], ['777', '778']);
    h.add(people(0, 1)[0] as string);
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);

    h.fake.react(messageId, '⭐', [authorId, ...people(0, 5)], ['777']);
    h.add('2001');
    h.add('2002');
    h.add('2003');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(1);
    expect(entry()?.peakCount).toBe(5);
  });

  it('drops cheap rejects before any fetch', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    const base = { guildId, channelId: sourceChannelId, messageId };
    h.runner.onReactionAdd({ ...base, userId: '2000', isBot: true, burst: false });
    h.runner.onReactionAdd({ ...base, userId: '2000', isBot: false, burst: true });
    h.runner.onReactionAdd({ ...base, userId: botId, isBot: false, burst: false });
    h.runner.onReactionAdd({
      ...base,
      userId: '2000',
      isBot: false,
      burst: false,
      messageAuthorId: '2000',
    });
    h.runner.onReactionAdd({
      ...base,
      userId: '2000',
      isBot: false,
      burst: false,
      messageAuthorId: botId,
    });
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
  });

  it('ignores reactions while no hall channel is set, and in the hall or exempt channels', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));

    h.add('2000', { channelId: hallChannelId });
    addHallExempt(db, guildId, sourceChannelId, t0);
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);

    db.$client.prepare('delete from guild_hall_exempt_channels').run();
    setHallChannel(db, guildId, null, t0);
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
  });

  it('never inducts from the honeypot channel', async () => {
    const h = harness(db, vi);
    setHoneypot(db, guildId, sourceChannelId, '555', t0);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
  });

  it.each([
    ['a bot author', { author: { bot: true } }],
    ['a webhook author', { author: { webhook: true } }],
    ['a system message', { type: MessageType.UserJoin }],
  ])('skips %s', async (_name, change) => {
    const h = harness(db, vi);
    const base = h.fake.addMessage();
    h.fake.addMessage({
      ...base,
      ...('type' in change ? { type: change.type } : {}),
      author: { ...base.author, ...('author' in change ? change.author : {}) },
    });
    h.fake.react(messageId, '⭐', people(0, 6));
    h.add('2000');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);
    expect(entry()).toBeUndefined();
  });

  it('stops refetching a message that can never qualify', async () => {
    const h = harness(db, vi);
    const base = h.fake.addMessage();
    h.fake.addMessage({ ...base, author: { ...base.author, bot: true } });
    h.fake.react(messageId, '⭐', people(0, 6));
    for (let round = 0; round < 3; round++) {
      h.add(`200${round}`);
      await h.settle();
    }
    expect(h.fake.log.fetchMessage).toBe(1);
  });

  it('does not let private content into a public hall, or nsfw into a safe one', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));

    h.fake.channels.set(
      sourceChannelId,
      channelInfo(sourceChannelId, 'staff', { everyoneCanView: false }),
    );
    h.add('2000');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);

    h.fake.channels.set(sourceChannelId, channelInfo(sourceChannelId, 'spicy', { nsfw: true }));
    h.add('2001');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);

    // Private into a private hall, nsfw into an nsfw hall: allowed.
    h.fake.channels.set(
      sourceChannelId,
      channelInfo(sourceChannelId, 'staff', { everyoneCanView: false }),
    );
    h.fake.channels.set(
      hallChannelId,
      channelInfo(hallChannelId, 'hall', { everyoneCanView: false }),
    );
    h.add('2002');
    await h.settle(hallOfFame.maxWaitMs);
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('skips private threads and threads of an exempt channel, and uses the parent for threads', async () => {
    const h = harness(db, vi);
    const thread = '21';
    h.fake.addMessage({ channelId: thread });
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.channels.set(
      thread,
      channelInfo(thread, 'a thread', {
        isThread: true,
        isPrivateThread: true,
        parentId: sourceChannelId,
      }),
    );
    h.add('2000', { channelId: thread });
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);

    h.fake.channels.set(
      thread,
      channelInfo(thread, 'a thread', { isThread: true, parentId: sourceChannelId }),
    );
    addHallExempt(db, guildId, sourceChannelId, t0);
    h.add('2001', { channelId: thread });
    await h.settle();
    expect(h.fake.log.send).toHaveLength(0);
    expect(h.fake.log.fetchMessage).toBe(0);
  });

  it('skips a source the bot cannot read and remembers it for ten minutes', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.faults.fetchMessage = 'forbidden';
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);

    h.fake.faults.fetchMessage = undefined;
    h.add('2001');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);

    await vi.advanceTimersByTimeAsync(hallOfFame.failureMemoryMs);
    h.add('2002');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('does not remember a deleted message as a channel failure', async () => {
    const h = harness(db, vi);
    h.add('2000');
    await h.settle();
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.add('2001');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('skips when the bot lacks permissions in the source or the hall, without claiming', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));

    const noHistory = channelInfo(sourceChannelId, 'memes');
    noHistory.can.readHistory = false;
    h.fake.channels.set(sourceChannelId, noHistory);
    h.add('2000');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);

    h.runner.forgetFailures();
    h.fake.channels.set(sourceChannelId, channelInfo(sourceChannelId, 'memes'));
    const noAttach = channelInfo(hallChannelId, 'hall');
    noAttach.can.attachFiles = false;
    h.fake.channels.set(hallChannelId, noAttach);
    h.add('2001');
    await h.settle();
    expect(entry()).toBeUndefined();
    expect(h.fake.log.send).toHaveLength(0);
    expect(h.warn).toHaveBeenCalled();
  });

  it('exits the count early and refines the peak after the cooldown', async () => {
    const h = harness(db, vi, { threshold: 3 });
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 4));
    h.fake.react(messageId, '🔥', people(0, 3));
    h.fake.react(messageId, '😂', people(10, 9));
    h.add('2000');
    await h.settle();

    // The most reacted emoji alone reaches the threshold, so only one was fetched.
    expect(h.fake.log.fetchReactors).toBe(1);
    expect(entry()?.peakCount).toBe(9);

    await h.settle(hallOfFame.peakCooldownMs);
    expect(h.fake.log.fetchReactors).toBe(1 + 3);
    expect(entry()?.peakCount).toBe(13);
    expect(h.fake.log.edit).toHaveLength(1);
  });

  it('posts one card for concurrent triggers', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    let open: () => void = () => undefined;
    h.fake.sendGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    h.add('2000');
    await vi.advanceTimersByTimeAsync(hallOfFame.debounceMs);
    expect(entry()?.status).toBe('publishing');

    h.add('2001');
    h.add('2002');
    await vi.advanceTimersByTimeAsync(hallOfFame.debounceMs);
    open();
    await h.runner.idle();
    await h.settle(hallOfFame.peakCooldownMs);
    expect(h.fake.log.send).toHaveLength(1);
    expect(entry()?.status).toBe('posted');
  });

  it('deletes the sent message when the claim was discarded mid-post', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.duringSend = () => {
      db.$client.prepare('delete from hall_of_fame_entries').run();
    };
    h.add('2000');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(1);
    expect(h.fake.log.deleted).toEqual([
      { channelId: hallChannelId, messageId: h.fake.log.send[0]?.id },
    ]);
    expect(h.fake.posted.size).toBe(0);
    expect(entry()).toBeUndefined();
  });

  it('releases the claim when the send fails, so it can be retried', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.faults.send = 'other';
    h.add('2000');
    await h.settle();
    expect(entry()).toBeUndefined();
    expect(h.warn).toHaveBeenCalled();

    h.fake.faults.send = undefined;
    h.add('2001');
    await h.settle();
    expect(entry()?.status).toBe('posted');
    expect(h.fake.log.send).toHaveLength(1);
  });

  it('remembers a hall channel that refuses the send', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.faults.send = 'forbidden';
    h.add('2000');
    await h.settle();
    const fetched = h.fake.log.fetchMessage;
    h.add('2001');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(fetched);
  });

  it('re-uploads images, and still posts when one download fails', async () => {
    const h = harness(db, vi);
    const url = (n: number) => `https://cdn.discordapp.com/attachments/1/${n}/pic${n}.png?ex=1`;
    h.fake.addMessage({
      facts: {
        content: 'pics',
        attachments: [1, 2].map((n) => ({
          id: String(n),
          name: `pic${n}.png`,
          url: url(n),
          size: 1000,
          contentType: 'image/png',
        })),
        stickers: [],
        embeds: [],
        snapshots: [],
      },
    });
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.downloads.set(url(1), new Error('boom'));
    h.add('2000');
    await h.settle();

    const sent = h.fake.log.send[0];
    expect(sent?.post.files.map((f) => f.name)).toEqual(['hall-1.png']);
    const json = JSON.stringify(sent?.post.card.toJSON());
    expect(json).toContain('attachment://hall-1.png');
    expect(json).not.toContain('attachment://hall-0.png');
    expect(entry()?.status).toBe('posted');
  });

  it('refuses downloads over the size caps', async () => {
    const h = harness(db, vi);
    const url = 'https://cdn.discordapp.com/attachments/1/1/pic.png';
    h.fake.addMessage({
      facts: {
        content: '',
        attachments: [{ id: '1', name: 'pic.png', url, size: 100, contentType: 'image/png' }],
        stickers: [],
        embeds: [],
        snapshots: [],
      },
    });
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.downloads.set(url, Buffer.alloc(hallOfFame.maxImageBytes + 1));
    h.add('2000');
    await h.settle();
    expect(h.fake.log.send[0]?.post.files).toEqual([]);
    expect(entry()?.status).toBe('posted');
  });

  it('puts the reply context and breakdown on the card', async () => {
    const h = harness(db, vi);
    h.fake.addMessage({
      type: MessageType.Reply,
      reply: { authorName: 'Someone', content: 'what do you think', hasMedia: false },
    });
    h.fake.react(messageId, '⭐', people(0, 5));
    h.fake.react(messageId, '🔥', people(0, 2));
    h.add('2000');
    await h.settle();
    const json = JSON.stringify(h.fake.log.send[0]?.post.card.toJSON());
    expect(json).toContain('replying to **Someone**');

    // The early exit left the breakdown partial; the refinement after the cooldown fills it in.
    await h.settle(hallOfFame.peakCooldownMs);
    const refined = JSON.stringify(h.fake.log.edit[0]?.post.card.toJSON());
    expect(refined).toContain('🔥 2');
  });

  it('inducts into the new hall channel after it changed, leaving old posts alone', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.addMessage({ id: '101' });
    h.fake.react(messageId, '⭐', people(0, 6));
    h.fake.react('101', '⭐', people(0, 6));
    h.add('2000');
    await h.settle();
    expect(entry()?.hallChannelId).toBe(hallChannelId);

    h.fake.channels.set('31', channelInfo('31', 'hall-2'));
    setHallChannel(db, guildId, '31', t0);
    h.add('2000', { messageId: '101' });
    await h.settle();
    expect(getHallEntry(db, guildId, '101')?.hallChannelId).toBe('31');
    expect(entry()?.hallChannelId).toBe(hallChannelId);
  });

  it('does nothing after stop', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    h.fake.react(messageId, '⭐', people(0, 6));
    h.add('2000');
    h.runner.stop();
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
  });
});

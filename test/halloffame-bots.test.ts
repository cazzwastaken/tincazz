import { ContainerBuilder, MessageType } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import {
  claimHallEntry,
  getHallEntry,
  hallOfFame,
  markHallPosted,
} from '../src/features/halloffame/index.js';
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

const entry = () => getHallEntry(db, guildId, messageId);
const otherBotId = '901';
const webhookId = '902';

type Harness = ReturnType<typeof harness>;

/** A reaction by a person on a message whose raw payload names its author. */
function reactOn(h: Harness, userId: string, messageAuthorId?: string, id = messageId) {
  h.runner.onReactionAdd({
    guildId,
    channelId: sourceChannelId,
    messageId: id,
    userId,
    messageAuthorId,
    isBot: false,
    burst: false,
  });
}

/** A message by `authorId` that enough people reacted to, as a bot, app or webhook would draw. */
function popularMessage(h: Harness, over: Parameters<Harness['fake']['addMessage']>[0] = {}) {
  const base = h.fake.addMessage();
  const message = h.fake.addMessage({ ...base, ...over });
  h.fake.react(messageId, '⭐', people(0, 8));
  return message;
}

const nothingPosted = (h: Harness) => {
  expect(h.fake.log.send).toHaveLength(0);
  expect(h.fake.log.edit).toHaveLength(0);
  expect(entry()).toBeUndefined();
};

describe('hall of fame ignores bots, apps and itself', () => {
  it('drops reactions on its own polls, giveaways and hall cards before any fetch', async () => {
    const h = harness(db, vi);
    popularMessage(h);
    // A poll, a giveaway and a hall card all have this bot as their author.
    for (const user of people(0, 8)) reactOn(h, user, botId);
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
    expect(h.fake.log.fetchReactors).toBe(0);
    nothingPosted(h);
  });

  it('drops reactions on a message of a known bot before any fetch', async () => {
    const h = harness(db, vi);
    h.fake.knownBots.add(otherBotId);
    popularMessage(h);
    for (const user of people(0, 8)) reactOn(h, user, otherBotId);
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
    nothingPosted(h);
  });

  it('fetches a message of an unknown bot once, then remembers its author', async () => {
    const h = harness(db, vi);
    popularMessage(h, {
      author: {
        id: otherBotId,
        username: 'reaction-roles',
        displayName: 'Reaction roles',
        avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
        bot: true,
        webhook: false,
      },
    });
    reactOn(h, '2000', otherBotId);
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);
    expect(h.fake.log.fetchReactors).toBe(0);

    // Any later reaction, on this or on another message of that bot, is dropped unread.
    for (const user of people(0, 8)) reactOn(h, user, otherBotId);
    reactOn(h, '2001', otherBotId, '101');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);
    nothingPosted(h);
  });

  it('remembers a bot author even when the payload does not name the author', async () => {
    const h = harness(db, vi);
    popularMessage(h, {
      author: {
        id: otherBotId,
        username: 'app',
        displayName: 'App',
        avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
        bot: true,
        webhook: false,
      },
    });
    // No `messageAuthorId` in the payload: the per message counter stops the refetching.
    for (const round of ['2000', '2001', '2002']) {
      reactOn(h, round);
      await h.settle();
    }
    expect(h.fake.log.fetchMessage).toBe(1);
    nothingPosted(h);
  });

  it('never inducts a webhook message, and fetches it once', async () => {
    const h = harness(db, vi);
    popularMessage(h, {
      author: {
        id: webhookId,
        username: 'Announcements',
        displayName: 'Announcements',
        avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
        bot: false,
        webhook: true,
      },
    });
    reactOn(h, '2000', webhookId);
    await h.settle();
    reactOn(h, '2001', webhookId);
    reactOn(h, '2002', webhookId);
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);
    nothingPosted(h);
  });

  it.each([
    ['an interaction response', MessageType.ChatInputCommand],
    ['a context menu response', MessageType.ContextMenuCommand],
    ['a user join', MessageType.UserJoin],
    ['a thread starter', MessageType.ThreadStarterMessage],
  ])('never inducts %s', async (_name, type) => {
    const h = harness(db, vi);
    popularMessage(h, { type });
    reactOn(h, '2000', '1');
    await h.settle();
    reactOn(h, '2001', '1');
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);
    nothingPosted(h);
  });

  it('never inducts a message this bot wrote, even when its author object lacks the bot flag', async () => {
    const h = harness(db, vi);
    const message = popularMessage(h);
    message.author = { ...message.author, id: botId, bot: false };
    reactOn(h, '2000');
    await h.settle();
    nothingPosted(h);
    // Remembered: the next reaction names the author and is dropped before a fetch.
    reactOn(h, '2001', botId);
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(1);
  });

  it('does not let bots, or this bot itself, make up a human message', async () => {
    const h = harness(db, vi);
    h.fake.addMessage();
    // Three people and a crowd of bots: the poll seeding reaction (this bot) and other apps.
    h.fake.react(messageId, '⭐', people(0, 3), ['801', '802', '803', '804', '805', '806']);
    const seeded = h.fake.reactors.get(`${messageId}:⭐`) ?? [];
    // Even a user object that came without the bot flag is not counted when it is this bot.
    h.fake.reactors.set(`${messageId}:⭐`, [...seeded, { id: botId, bot: false }]);
    for (const user of people(0, 3)) reactOn(h, user, '1');
    await h.settle();
    expect(h.fake.log.fetchReactors).toBe(1);
    nothingPosted(h);

    // The same message does qualify with enough people, so the bots were what held it back.
    h.fake.react(messageId, '⭐', people(0, 5), ['801', '802', '803']);
    // Two more people were needed, and the countdown says so.
    reactOn(h, '2000', '1');
    reactOn(h, '2001', '1');
    await h.settle();
    reactOn(h, '2002', '1');
    await h.settle();
    expect(h.fake.log.send).toHaveLength(1);
    expect(entry()?.peakCount).toBe(5);
  });

  it('never inducts a message in the hall channel, such as a hall card', async () => {
    const h = harness(db, vi);
    h.fake.addMessage({ channelId: hallChannelId });
    h.fake.react(messageId, '⭐', people(0, 8));
    h.runner.onReactionAdd({
      guildId,
      channelId: hallChannelId,
      messageId,
      userId: '2000',
      isBot: false,
      burst: false,
    });
    await h.settle();
    expect(h.fake.log.fetchMessage).toBe(0);
    nothingPosted(h);
  });

  describe('a bot message that already has a hall entry', () => {
    const seed = (h: Harness) => {
      popularMessage(h, {
        author: {
          id: otherBotId,
          username: 'app',
          displayName: 'App',
          avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
          bot: true,
          webhook: false,
        },
      });
      claimHallEntry(
        db,
        {
          guildId,
          messageId,
          channelId: sourceChannelId,
          authorId: otherBotId,
          hallChannelId,
        },
        t0,
      );
      markHallPosted(
        db,
        guildId,
        messageId,
        { hallMessageId: '7000', peakCount: 5, renderedHash: 'old' },
        t0,
      );
      h.fake.posted.set('7000', {
        channelId: hallChannelId,
        post: { card: new ContainerBuilder(), files: [] },
      });
    };

    it('is never edited or recounted by reactions, edits or removals', async () => {
      const h = harness(db, vi);
      seed(h);
      // The author is not known yet: one fetch finds out, and the card is left alone.
      reactOn(h, '2000', otherBotId);
      h.runner.onMessageUpdate(guildId, messageId);
      h.runner.onReactionChange({ guildId, channelId: sourceChannelId, messageId });
      await h.settle();
      await h.settle(hallOfFame.peakCooldownMs);
      expect(h.fake.log.fetchReactors).toBe(0);
      expect(h.fake.log.edit).toHaveLength(0);
      expect(h.fake.log.send).toHaveLength(0);
      expect(entry()).toMatchObject({ peakCount: 5, lastRenderedHash: 'old', status: 'posted' });

      // The next reaction costs nothing.
      const fetched = h.fake.log.fetchMessage;
      expect(fetched).toBeGreaterThan(0);
      reactOn(h, '2002', otherBotId);
      await h.settle();
      expect(h.fake.log.fetchMessage).toBe(fetched);
      expect(h.fake.log.fetchReactors).toBe(0);
    });

    it('is still removed when the original is deleted', async () => {
      const h = harness(db, vi);
      seed(h);
      await h.runner.onSourceMessagesDeleted(guildId, [messageId]);
      expect(entry()).toBeUndefined();
      expect(h.fake.log.deleted).toEqual([{ channelId: hallChannelId, messageId: '7000' }]);
    });

    it('is still removed when a sync finds the original gone', async () => {
      const h = harness(db, vi);
      seed(h);
      h.fake.messages.delete(messageId);
      h.runner.onMessageUpdate(guildId, messageId);
      await h.settle();
      expect(entry()).toBeUndefined();
      expect(h.fake.log.deleted).toHaveLength(1);
    });
  });
});

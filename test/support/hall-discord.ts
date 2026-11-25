import { MessageType } from 'discord.js';
import type { Db } from '../../src/db/index.js';
import {
  type ChannelFacts,
  collectLinks,
  createHallRunner,
  type HallChannelInfo,
  type HallDiscord,
  HallDiscordError,
  type HallErrorKind,
  type HallPost,
  type HallReaction,
  type HallRecentMessage,
  type HallRunner,
  type HallSourceMessage,
  hallOfFame,
  setHallChannel,
  setHallThreshold,
} from '../../src/features/halloffame/index.js';
import type { Reactor } from '../../src/features/halloffame/score.js';

export const guildId = '10';
export const sourceChannelId = '20';
export const hallChannelId = '30';
export const authorId = '1';
export const messageId = '100';
export const botId = '900';
export const t0 = Date.UTC(2026, 10, 24);

export const publicChannel = (id: string, over: Partial<ChannelFacts> = {}): ChannelFacts => ({
  id,
  isThread: false,
  isPrivateThread: false,
  nsfw: false,
  // @everyone (its id is the guild id) can view.
  audience: [guildId],
  overwrites: { denied: [], deniedRoles: [], allowedRoles: [] },
  ...over,
});

export const channelInfo = (
  id: string,
  name: string,
  over: Partial<ChannelFacts> = {},
): HallChannelInfo => ({
  facts: publicChannel(id, over),
  name,
  can: { view: true, readHistory: true, send: true, attachFiles: true },
});

export const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

interface PostedCard {
  channelId: string;
  post: HallPost;
}

type Fault = HallErrorKind | undefined;

/** An in-memory stand-in for Discord that records everything the runner does. */
export class FakeHall implements HallDiscord {
  public readonly botId = botId;
  public readonly channels = new Map<string, HallChannelInfo>();
  public readonly messages = new Map<string, HallSourceMessage>();
  public readonly reactors = new Map<string, Reactor[]>();
  public readonly posted = new Map<string, PostedCard>();
  public readonly downloads = new Map<string, Buffer | Error>();
  public readonly log = {
    fetchMessage: 0,
    fetchReactors: 0,
    channel: 0,
    send: [] as Array<{ channelId: string; post: HallPost; id: string }>,
    edit: [] as Array<{ channelId: string; messageId: string; post: HallPost }>,
    deleted: [] as Array<{ channelId: string; messageId: string }>,
    downloaded: [] as string[],
  };
  public faults: {
    fetchMessage?: Fault;
    send?: Fault;
    edit?: Fault;
    fetchRecent?: Fault;
    fetchReactors?: Fault;
  } = {};
  /** With a `send` fault: the card is created before the call fails, as when a response is lost. */
  public sendCreatesBeforeFault = false;
  /** Awaited at the start of every send, to hold a post open. */
  public sendGate: Promise<void> | undefined;
  /** Runs while a send is in flight, after the message was created. */
  public duringSend: (() => void) | undefined;
  public beforeFetchMessage: (() => Promise<void>) | undefined;
  public beforeDelete: ((channelId: string, messageId: string) => void) | undefined;
  private nextId = 5000;

  public constructor() {
    this.channels.set(sourceChannelId, channelInfo(sourceChannelId, 'memes'));
    this.channels.set(hallChannelId, channelInfo(hallChannelId, 'hall'));
  }

  public peekChannel(_guildId: string, channelId: string) {
    return this.channels.get(channelId)?.facts;
  }

  public async channel(_guildId: string, channelId: string) {
    this.log.channel += 1;
    const info = this.channels.get(channelId);
    if (!info) throw new HallDiscordError('unknown-channel');
    return info;
  }

  public async fetchMessage(_guildId: string, channelId: string, id: string) {
    this.log.fetchMessage += 1;
    await this.beforeFetchMessage?.();
    if (this.faults.fetchMessage) throw new HallDiscordError(this.faults.fetchMessage);
    const message = this.messages.get(id);
    if (!message || message.channelId !== channelId) throw new HallDiscordError('unknown-message');
    return structuredClone(message);
  }

  public async fetchReactors(_channelId: string, id: string, key: string, limit: number) {
    this.log.fetchReactors += 1;
    if (this.faults.fetchReactors) throw new HallDiscordError(this.faults.fetchReactors);
    return (this.reactors.get(`${id}:${key}`) ?? []).slice(0, limit);
  }

  public async profile(_guildId: string, userId: string) {
    return {
      displayName: `Member ${userId}`,
      avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
    };
  }

  public async sendHall(channelId: string, post: HallPost) {
    await this.sendGate;
    const fault = this.faults.send;
    if (fault && !this.sendCreatesBeforeFault) throw new HallDiscordError(fault);
    const id = String(this.nextId++);
    this.posted.set(id, { channelId, post });
    this.log.send.push({ channelId, post, id });
    this.duringSend?.();
    if (fault) throw new HallDiscordError(fault);
    return id;
  }

  public async editHall(channelId: string, id: string, post: HallPost) {
    if (this.faults.edit) throw new HallDiscordError(this.faults.edit);
    if (!this.posted.has(id)) throw new HallDiscordError('unknown-message');
    this.posted.set(id, { channelId, post });
    this.log.edit.push({ channelId, messageId: id, post });
  }

  public async deleteHall(channelId: string, id: string) {
    this.beforeDelete?.(channelId, id);
    this.log.deleted.push({ channelId, messageId: id });
    if (!this.posted.delete(id)) throw new HallDiscordError('unknown-message');
  }

  public async fetchRecent(channelId: string, before?: string): Promise<HallRecentMessage[]> {
    if (this.faults.fetchRecent) throw new HallDiscordError(this.faults.fetchRecent);
    const all = [...this.posted.entries()]
      .filter(([, card]) => card.channelId === channelId)
      .map(([id, card]) => ({
        id,
        authorId: botId,
        links: collectLinks(card.post.card.toJSON()),
      }))
      .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
    const older = before ? all.filter((m) => BigInt(m.id) < BigInt(before)) : all;
    return older.slice(0, 100);
  }

  public async download(url: string) {
    this.log.downloaded.push(url);
    const result = this.downloads.get(url) ?? png;
    if (result instanceof Error) throw result;
    return result;
  }

  /** A message in the source channel with sensible defaults. */
  public addMessage(over: Partial<HallSourceMessage> = {}): HallSourceMessage {
    const message: HallSourceMessage = {
      id: messageId,
      channelId: sourceChannelId,
      createdAt: t0 - 60_000,
      type: MessageType.Default,
      author: {
        id: authorId,
        username: 'cazz',
        displayName: 'Cazz',
        avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
        bot: false,
        webhook: false,
      },
      facts: {
        content: 'a fine message',
        attachments: [],
        stickers: [],
        embeds: [],
        snapshots: [],
      },
      reactions: [],
      ...over,
    };
    this.messages.set(message.id, message);
    return message;
  }

  /** People reacting with `emoji` (a unicode emoji); also keeps the message's reaction counts. */
  public react(
    id: string,
    emoji: string,
    userIds: readonly string[],
    bots: readonly string[] = [],
  ) {
    const message = this.messages.get(id);
    if (!message) throw new Error(`no message ${id}`);
    const users: Reactor[] = [
      ...userIds.map((user) => ({ id: user, bot: false })),
      ...bots.map((user) => ({ id: user, bot: true })),
    ];
    this.reactors.set(`${id}:${emoji}`, users);
    const reaction: HallReaction = { emoji, key: emoji, normal: users.length };
    const rest = message.reactions.filter((r) => r.emoji !== emoji);
    message.reactions = users.length > 0 ? [...rest, reaction] : rest;
  }
}

export interface Harness {
  fake: FakeHall;
  runner: HallRunner;
  warn: ReturnType<typeof import('vitest').vi.fn>;
  debug: ReturnType<typeof import('vitest').vi.fn>;
  add(userId: string, over?: { messageId?: string; channelId?: string }): void;
  /** Runs the debounce and everything it queued. */
  settle(ms?: number): Promise<void>;
}

/** A runner on a fake Discord with the hall channel configured; call with fake timers installed. */
export function harness(
  db: Db,
  vi: typeof import('vitest').vi,
  options: { threshold?: number } = {},
): Harness {
  const fake = new FakeHall();
  const warn = vi.fn();
  const debug = vi.fn();
  setHallChannel(db, guildId, hallChannelId, t0);
  if (options.threshold !== undefined) {
    setHallThreshold(db, guildId, options.threshold, t0);
  }
  const runner = createHallRunner({ db, discord: fake, logger: { warn, debug } });
  return {
    fake,
    runner,
    warn,
    debug,
    add(userId, over = {}) {
      runner.onReactionAdd({
        guildId,
        channelId: over.channelId ?? sourceChannelId,
        messageId: over.messageId ?? messageId,
        userId,
        isBot: false,
        burst: false,
      });
    },
    async settle(ms = hallOfFame.debounceMs) {
      await vi.advanceTimersByTimeAsync(ms);
      await runner.idle();
    },
  };
}

export const people = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => String(1000 + from + i));

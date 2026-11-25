import type { ContainerBuilder } from 'discord.js';
import type { MessageFacts } from './content.js';
import type { ChannelFacts } from './eligibility.js';
import type { ReactionCount, Reactor } from './score.js';

/**
 * What went wrong with a Discord call, closed so the runner never needs discord.js error classes.
 * `rejected` is any other 4xx answer (such as an invalid form body): Discord looked at the request
 * and refused it, so nothing was created. `other` is everything else (timeouts, resets, 5xx), where
 * the request may or may not have gone through.
 */
export type HallErrorKind =
  | 'unknown-message'
  | 'unknown-channel'
  | 'forbidden'
  | 'rejected'
  | 'other';

export class HallDiscordError extends Error {
  // Not a parameter property: Node's type stripping (used to load pieces in tests) rejects those.
  public readonly kind: HallErrorKind;

  public constructor(kind: HallErrorKind, message: string = kind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HallDiscordError';
    this.kind = kind;
  }
}

export function hallErrorKind(error: unknown): HallErrorKind {
  return error instanceof HallDiscordError ? error.kind : 'other';
}

/** What the bot may do in a channel, as far as the Hall of Fame cares. */
export interface HallPermissions {
  view: boolean;
  readHistory: boolean;
  send: boolean;
  attachFiles: boolean;
}

export interface HallChannelInfo {
  facts: ChannelFacts;
  name: string;
  can: HallPermissions;
}

/** One emoji on a message. */
export interface HallReaction extends ReactionCount {
  /** Unique text for this emoji: unicode, `<:name:id>` when the guild has it, else `name:id`. */
  emoji: string;
  /** The path part of the reactors route (`name` or `name:id`), not yet URL encoded. */
  key: string;
  /** Normal reactions only; super reactions are not counted. */
  normal: number;
}

export interface HallReply {
  authorName: string;
  content: string;
  hasMedia: boolean;
}

export interface HallSourceAuthor {
  id: string;
  username: string;
  /** Global display name, else the username. */
  displayName: string;
  avatarUrl: string;
  bot: boolean;
  webhook: boolean;
}

/** A message as the Hall of Fame sees it, with no discord.js types left. */
export interface HallSourceMessage {
  id: string;
  channelId: string;
  /** Epoch milliseconds. */
  createdAt: number;
  type: number;
  author: HallSourceAuthor;
  facts: MessageFacts;
  reactions: readonly HallReaction[];
  reply?: HallReply | undefined;
}

export interface HallProfile {
  displayName: string;
  avatarUrl: string;
}

export interface HallFile {
  name: string;
  data: Buffer;
}

/** A hall message: the card, the files its gallery points at, and an idempotency key for a send. */
export interface HallPost {
  card: ContainerBuilder;
  /** Sent with the message, and again with every edit (an edit lists exactly these attachments). */
  files: readonly HallFile[];
  nonce?: string | undefined;
}

/** A message in the hall channel, reduced to what recovery looks for. */
export interface HallRecentMessage {
  id: string;
  authorId: string;
  /** Every link found in its components (button URLs). */
  links: readonly string[];
}

/**
 * Everything the runner needs from Discord. Methods throw `HallDiscordError`. The discord.js
 * implementation is `createHallDiscord`; tests use a fake.
 */
export interface HallDiscord {
  readonly botId: string;
  /** The channel's facts from the cache only, or undefined when it is not cached. */
  peekChannel(guildId: string, channelId: string): ChannelFacts | undefined;
  channel(guildId: string, channelId: string): Promise<HallChannelInfo>;
  fetchMessage(guildId: string, channelId: string, messageId: string): Promise<HallSourceMessage>;
  /** Up to `limit` people who reacted normally with one emoji (`HallReaction.key`). */
  fetchReactors(
    channelId: string,
    messageId: string,
    key: string,
    limit: number,
  ): Promise<Reactor[]>;
  /** The member's display name and server avatar, or undefined when they cannot be found. */
  profile(guildId: string, userId: string): Promise<HallProfile | undefined>;
  sendHall(channelId: string, post: HallPost): Promise<string>;
  editHall(channelId: string, messageId: string, post: HallPost): Promise<void>;
  deleteHall(channelId: string, messageId: string): Promise<void>;
  /** Up to 100 messages, newest first, older than `before` when given. */
  fetchRecent(channelId: string, before?: string): Promise<HallRecentMessage[]>;
  /** Downloads an image through the imaging allowlist; throws when it is not allowed or fails. */
  download(url: string): Promise<Buffer>;
}

export interface HallLogger {
  debug(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

import { MessageType } from 'discord.js';

/** What the decision needs to know about a channel; threads carry their parent's resolved facts. */
export interface ChannelFacts {
  id: string;
  /** The parent channel of a thread. */
  parentId?: string | undefined;
  /** The category of the channel (of the parent, for a thread). */
  categoryId?: string | undefined;
  isThread: boolean;
  isPrivateThread: boolean;
  /** Already resolved from the parent for a thread. */
  nsfw: boolean;
  /** Whether @everyone can view the channel; resolved from the parent for a thread. */
  everyoneCanView: boolean;
}

export interface AuthorFacts {
  bot: boolean;
  webhook: boolean;
}

export interface EligibilitySettings {
  channelId: string | undefined;
}

/** Why a message is not eligible. Closed, so every surface can explain every case. */
export type IneligibleReason =
  | 'hall-disabled'
  | 'hall-unavailable'
  | 'hall-channel'
  | 'honeypot'
  | 'exempt'
  | 'private-thread'
  | 'nsfw-to-sfw'
  | 'private-to-public'
  | 'bot-author'
  | 'webhook-author'
  | 'message-type';

export type Eligibility = { ok: true } | { ok: false; reason: IneligibleReason };

/** Only plain messages and replies are inducted (not joins, boosts, pins, commands...). */
const allowedMessageTypes: ReadonlySet<number> = new Set([MessageType.Default, MessageType.Reply]);

export function isInductableMessageType(type: number): boolean {
  return allowedMessageTypes.has(type);
}

const ok: Eligibility = { ok: true };
const no = (reason: IneligibleReason): Eligibility => ({ ok: false, reason });

/** Whether the channel, its parent (for a thread) or its category is in `exemptIds`. */
export function isExempt(channel: ChannelFacts, exemptIds: Iterable<string>): boolean {
  const exempt = exemptIds instanceof Set ? exemptIds : new Set(exemptIds);
  return (
    exempt.has(channel.id) ||
    (channel.parentId !== undefined && exempt.has(channel.parentId)) ||
    (channel.categoryId !== undefined && exempt.has(channel.categoryId))
  );
}

/**
 * The cheap checks that need only ids, so a reaction can be dropped before any fetch: hall
 * disabled, the source is the hall (or a thread in it) or the honeypot (or a thread in it), or it
 * is exempt.
 */
export function channelEligibility(
  settings: EligibilitySettings,
  exemptIds: Iterable<string>,
  honeypotChannelId: string | undefined,
  source: ChannelFacts,
): Eligibility {
  const hallId = settings.channelId;
  if (hallId === undefined) return no('hall-disabled');
  if (source.id === hallId || source.parentId === hallId) return no('hall-channel');
  if (
    honeypotChannelId !== undefined &&
    (source.id === honeypotChannelId || source.parentId === honeypotChannelId)
  ) {
    return no('honeypot');
  }
  if (isExempt(source, exemptIds)) return no('exempt');
  return ok;
}

/**
 * Whether a message may be inducted. Never lets private content reach a public hall (a private
 * thread, or a channel @everyone cannot view, into a hall @everyone can), and never lets NSFW
 * content reach a hall that is not NSFW.
 */
export function eligibility(
  settings: EligibilitySettings,
  exemptIds: Iterable<string>,
  honeypotChannelId: string | undefined,
  source: ChannelFacts,
  /** The hall channel's facts, or undefined when it cannot be resolved (deleted, not cached). */
  hall: ChannelFacts | undefined,
  author: AuthorFacts,
  messageType: number,
): Eligibility {
  const channel = channelEligibility(settings, exemptIds, honeypotChannelId, source);
  if (!channel.ok) return channel;
  if (source.isPrivateThread) return no('private-thread');
  // Without the hall's facts nothing can be proven safe, so refuse.
  if (!hall) return no('hall-unavailable');
  if (source.nsfw && !hall.nsfw) return no('nsfw-to-sfw');
  if (!source.everyoneCanView && hall.everyoneCanView) return no('private-to-public');
  if (author.bot) return no('bot-author');
  if (author.webhook) return no('webhook-author');
  if (!isInductableMessageType(messageType)) return no('message-type');
  return ok;
}

export interface GuardNote {
  reason: IneligibleReason;
  /** Short name for a list. */
  title: string;
  /** What happens and why, in a sentence staff can read. */
  text: string;
}

/**
 * Every guard in plain words, in the order they are checked, for `/help`, the docs and the settings
 * card, so the silent skips are explained in one place.
 */
export const guardNotes: readonly GuardNote[] = [
  {
    reason: 'hall-disabled',
    title: 'No hall channel',
    text: 'Nothing is inducted until staff pick a hall channel.',
  },
  {
    reason: 'hall-unavailable',
    title: 'Missing hall channel',
    text: 'Nothing is inducted while the bot cannot see the hall channel.',
  },
  {
    reason: 'hall-channel',
    title: 'The hall itself',
    text: 'Messages in the hall channel (and its threads) are never inducted again.',
  },
  {
    reason: 'honeypot',
    title: 'The honeypot',
    text: 'The honeypot channel is never inducted.',
  },
  {
    reason: 'exempt',
    title: 'Exempt channels',
    text: 'Messages in an exempt channel, a thread of one, or a channel in an exempt category are skipped.',
  },
  {
    reason: 'private-thread',
    title: 'Private threads',
    text: 'Messages in private threads are never inducted, since the hall cannot tell who was invited.',
  },
  {
    reason: 'nsfw-to-sfw',
    title: 'Age-restricted channels',
    text: 'Messages from an age-restricted channel are skipped unless the hall channel is age-restricted too.',
  },
  {
    reason: 'private-to-public',
    title: 'Private channels',
    text: 'Messages from a channel @everyone cannot see are skipped when @everyone can see the hall channel, so private talk never becomes public.',
  },
  {
    reason: 'bot-author',
    title: 'Bots',
    text: 'Messages written by bots are never inducted.',
  },
  {
    reason: 'webhook-author',
    title: 'Webhooks',
    text: 'Messages sent through webhooks are never inducted.',
  },
  {
    reason: 'message-type',
    title: 'System messages',
    text: 'Only normal messages and replies count, not joins, boosts, pins or command results.',
  },
];

const noteByReason = new Map(guardNotes.map((note) => [note.reason, note]));

export function guardNote(reason: IneligibleReason): GuardNote {
  const note = noteByReason.get(reason);
  if (!note) throw new Error(`no guard note for ${reason}`);
  return note;
}

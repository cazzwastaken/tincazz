import { MessageType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  type ChannelFacts,
  channelEligibility,
  eligibility,
  guardNote,
  guardNotes,
  type IneligibleReason,
  isExempt,
} from '../src/features/halloffame/index.js';

const channel = (over: Partial<ChannelFacts> = {}): ChannelFacts => ({
  id: 'src',
  isThread: false,
  isPrivateThread: false,
  nsfw: false,
  everyoneCanView: true,
  ...over,
});
const hall = channel({ id: 'hall' });
const human = { bot: false, webhook: false };
const settings = { channelId: 'hall' };

const check = (
  source: ChannelFacts,
  over: {
    exempt?: string[];
    honeypot?: string;
    hall?: ChannelFacts | undefined;
    author?: { bot: boolean; webhook: boolean };
    type?: number;
    settings?: { channelId: string | undefined };
  } = {},
) =>
  eligibility(
    over.settings ?? settings,
    over.exempt ?? [],
    over.honeypot,
    source,
    'hall' in over ? over.hall : hall,
    over.author ?? human,
    over.type ?? MessageType.Default,
  );

describe('hall of fame eligibility', () => {
  it('accepts a plain message in a public channel', () => {
    expect(check(channel())).toEqual({ ok: true });
    expect(check(channel(), { type: MessageType.Reply })).toEqual({ ok: true });
  });

  it('refuses when no hall is set or its channel cannot be resolved', () => {
    expect(check(channel(), { settings: { channelId: undefined } })).toEqual({
      ok: false,
      reason: 'hall-disabled',
    });
    expect(check(channel(), { hall: undefined })).toEqual({
      ok: false,
      reason: 'hall-unavailable',
    });
  });

  it('refuses the hall channel, its threads and the honeypot', () => {
    expect(check(channel({ id: 'hall' }))).toEqual({ ok: false, reason: 'hall-channel' });
    expect(check(channel({ id: 't', parentId: 'hall', isThread: true }))).toEqual({
      ok: false,
      reason: 'hall-channel',
    });
    expect(check(channel({ id: 'pot' }), { honeypot: 'pot' })).toEqual({
      ok: false,
      reason: 'honeypot',
    });
    expect(
      check(channel({ id: 't', parentId: 'pot', isThread: true }), { honeypot: 'pot' }),
    ).toEqual({ ok: false, reason: 'honeypot' });
  });

  it('matches exemptions on the channel, its parent and its category', () => {
    expect(isExempt(channel(), ['src'])).toBe(true);
    expect(isExempt(channel({ parentId: 'p', isThread: true }), ['p'])).toBe(true);
    expect(isExempt(channel({ categoryId: 'cat' }), new Set(['cat']))).toBe(true);
    expect(isExempt(channel({ categoryId: 'cat' }), ['other'])).toBe(false);
    expect(check(channel({ categoryId: 'cat' }), { exempt: ['cat'] })).toEqual({
      ok: false,
      reason: 'exempt',
    });
  });

  it('never inducts a private thread, even in a public parent', () => {
    expect(
      check(channel({ id: 't', parentId: 'p', isThread: true, isPrivateThread: true })),
    ).toEqual({ ok: false, reason: 'private-thread' });
  });

  it('never moves NSFW into a hall that is not NSFW', () => {
    expect(check(channel({ nsfw: true }))).toEqual({ ok: false, reason: 'nsfw-to-sfw' });
    expect(check(channel({ nsfw: true }), { hall: channel({ id: 'hall', nsfw: true }) })).toEqual({
      ok: true,
    });
    expect(check(channel({ nsfw: false }), { hall: channel({ id: 'hall', nsfw: true }) })).toEqual({
      ok: true,
    });
  });

  it('never leaks a private channel into a public hall', () => {
    expect(check(channel({ everyoneCanView: false }))).toEqual({
      ok: false,
      reason: 'private-to-public',
    });
    const privateHall = channel({ id: 'hall', everyoneCanView: false });
    expect(check(channel({ everyoneCanView: false }), { hall: privateHall })).toEqual({ ok: true });
    expect(check(channel(), { hall: privateHall })).toEqual({ ok: true });
  });

  it('refuses bots, webhooks and non message types', () => {
    expect(check(channel(), { author: { bot: true, webhook: false } })).toEqual({
      ok: false,
      reason: 'bot-author',
    });
    expect(check(channel(), { author: { bot: false, webhook: true } })).toEqual({
      ok: false,
      reason: 'webhook-author',
    });
    for (const type of [
      MessageType.UserJoin,
      MessageType.ChannelPinnedMessage,
      MessageType.ChatInputCommand,
      MessageType.ThreadStarterMessage,
    ]) {
      expect(check(channel(), { type })).toEqual({ ok: false, reason: 'message-type' });
    }
  });

  it('checks the cheap channel rules on their own', () => {
    expect(channelEligibility(settings, [], undefined, channel())).toEqual({ ok: true });
    expect(channelEligibility({ channelId: undefined }, [], undefined, channel())).toEqual({
      ok: false,
      reason: 'hall-disabled',
    });
  });

  it('explains every guard', () => {
    const reasons: IneligibleReason[] = [
      'hall-disabled',
      'hall-unavailable',
      'hall-channel',
      'honeypot',
      'exempt',
      'private-thread',
      'nsfw-to-sfw',
      'private-to-public',
      'bot-author',
      'webhook-author',
      'message-type',
    ];
    expect(guardNotes.map((n) => n.reason).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      expect(guardNote(reason).text.length).toBeGreaterThan(10);
    }
  });
});

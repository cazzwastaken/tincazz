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
  audience: ['everyone'],
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
    const staff = channel({ audience: ['staff'] });
    expect(check(staff)).toEqual({ ok: false, reason: 'audience-mismatch' });
    const privateHall = channel({ id: 'hall', audience: ['staff'] });
    expect(check(staff, { hall: privateHall })).toEqual({ ok: true });
    // A public channel lists every role that inherits the view from @everyone, staff included.
    const open = channel({ audience: ['everyone', 'member', 'staff'] });
    expect(check(open, { hall: privateHall })).toEqual({ ok: true });
  });

  it('compares roles, so a staff channel never reaches a hall only members can see', () => {
    // @everyone is locked out everywhere: a staff channel and a members-only hall both look
    // "not public", but members can see the hall and cannot see the staff channel.
    const staff = channel({ audience: ['staff'] });
    const membersHall = channel({ id: 'hall', audience: ['member'] });
    expect(check(staff, { hall: membersHall })).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
    expect(check(channel({ audience: ['member', 'staff'] }), { hall: membersHall })).toEqual({
      ok: true,
    });
    // Anyone who can see the hall must be able to see the source.
    const wide = channel({ id: 'hall', audience: ['member', 'staff', 'guest'] });
    expect(check(channel({ audience: ['member', 'staff'] }), { hall: wide })).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
  });

  it('counts a member who can see the hall but not the source', () => {
    const hallForOne = channel({ id: 'hall', audience: ['staff', 'user:5'] });
    expect(check(channel({ audience: ['staff'] }), { hall: hallForOne })).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
  });

  it('fails closed when an audience is unknown', () => {
    const blind = { audience: undefined };
    expect(check(channel(blind))).toEqual({ ok: false, reason: 'audience-mismatch' });
    expect(check(channel(), { hall: channel({ id: 'hall', ...blind }) })).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
    // Even two unknowns, and even a hall nobody can see.
    expect(check(channel(blind), { hall: channel({ id: 'hall', ...blind }) })).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
    expect(check(channel(blind), { hall: channel({ id: 'hall', audience: [] }) })).toEqual({
      ok: false,
      reason: 'audience-mismatch',
    });
    expect(
      check(channel({ audience: [] }), { hall: channel({ id: 'hall', audience: [] }) }),
    ).toEqual({
      ok: true,
    });
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
      'audience-mismatch',
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

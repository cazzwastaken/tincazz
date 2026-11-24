import { container } from '@sapphire/framework';
import { Events, PermissionFlagsBits, Routes } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, type Db, openDatabase } from '../src/db/index.js';
import { polls } from '../src/db/schema.js';
import { optionEmojis } from '../src/features/poll/config.js';
import { castVote, getPoll, tallyPoll } from '../src/features/poll/store.js';
import { testEnv } from './support/env.js';
import { openPoll } from './support/polls.js';

const hour = 3_600_000;
const [one, two, three] = optionEmojis;

describe('poll events', () => {
  let client: ReturnType<typeof createClient>;
  let db: Db;
  let del: ReturnType<typeof vi.fn>;
  const now = Date.now();

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    container.db = db;
    del = vi.fn(async () => undefined);
    vi.spyOn(client.rest, 'delete').mockImplementation(del as never);
    vi.spyOn(client.guilds.cache, 'get').mockReturnValue({
      members: { me: { id: '9' } },
      channels: {
        cache: new Map([
          [
            '20',
            {
              permissionsFor: () => ({
                has: (bit: bigint) => bit === PermissionFlagsBits.ManageMessages && canManage,
              }),
            },
          ],
        ]),
      },
    } as never);
    canManage = true;
  });

  let canManage = true;

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
  });

  const save = () => openPoll(db, { options: ['A', 'B', 'C'], endsAt: now + hour, now });
  const votes = (id = 1) => tallyPoll(db, { guildId: '10', id, options: ['A', 'B', 'C'] });

  const emit = (t: string, d: Record<string, unknown>) =>
    client.emit(Events.Raw, { t, d } as never);
  const reaction = (t: string, emoji: string, extra: Record<string, unknown> = {}) =>
    emit(t, {
      guild_id: '10',
      channel_id: '20',
      message_id: '30',
      user_id: '5',
      emoji: { id: null, name: emoji },
      ...extra,
    });

  it('records a vote and ignores bots, custom and unrelated emoji', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string);
    reaction('MESSAGE_REACTION_ADD', two as string, {
      user_id: '6',
      member: { user: { bot: true } },
    });
    reaction('MESSAGE_REACTION_ADD', '🔥', { user_id: '7' });
    reaction('MESSAGE_REACTION_ADD', 'x', { user_id: '8', emoji: { id: '99', name: one } });
    reaction('MESSAGE_REACTION_ADD', '4️⃣', { user_id: '9' });
    expect(votes()).toEqual([1, 0, 0]);
  });

  it('ignores super (burst) reactions, added or removed', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string, { burst: true });
    expect(votes()).toEqual([0, 0, 0]);
    reaction('MESSAGE_REACTION_ADD', one as string, { burst: false });
    reaction('MESSAGE_REACTION_REMOVE', one as string, { burst: true });
    expect(votes()).toEqual([1, 0, 0]);
    reaction('MESSAGE_REACTION_REMOVE', one as string, { burst: false });
    expect(votes()).toEqual([0, 0, 0]);
  });

  it('ignores reactions on messages that are not polls and DM events', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string, { message_id: '31' });
    reaction('MESSAGE_REACTION_ADD', one as string, { guild_id: undefined });
    expect(votes()).toEqual([0, 0, 0]);
  });

  it('accepts keycaps without the variation selector', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', (two as string).replace(/️/g, ''));
    expect(votes()).toEqual([0, 1, 0]);
  });

  it('moves a vote and removes the old reaction when the bot can manage messages', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string);
    expect(del).not.toHaveBeenCalled();
    reaction('MESSAGE_REACTION_ADD', two as string);
    expect(votes()).toEqual([0, 1, 0]);
    expect(del).toHaveBeenCalledWith(
      Routes.channelMessageUserReaction('20', '30', encodeURIComponent(one as string), '5'),
    );
  });

  it('keeps the new vote when the bot-removed old reaction event arrives', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string);
    reaction('MESSAGE_REACTION_ADD', two as string);
    reaction('MESSAGE_REACTION_REMOVE', one as string);
    expect(votes()).toEqual([0, 1, 0]);
    reaction('MESSAGE_REACTION_REMOVE', two as string);
    expect(votes()).toEqual([0, 0, 0]);
  });

  it('does not remove reactions without Manage Messages, or when the removal fails', () => {
    save();
    canManage = false;
    reaction('MESSAGE_REACTION_ADD', one as string);
    reaction('MESSAGE_REACTION_ADD', two as string);
    expect(del).not.toHaveBeenCalled();
    expect(votes()).toEqual([0, 1, 0]);

    canManage = true;
    del.mockRejectedValueOnce(new Error('Missing Permissions'));
    reaction('MESSAGE_REACTION_ADD', three as string);
    expect(votes()).toEqual([0, 0, 1]);
  });

  it('a repeat reaction on the same option does not remove anything', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string);
    reaction('MESSAGE_REACTION_ADD', one as string);
    expect(del).not.toHaveBeenCalled();
    expect(votes()).toEqual([1, 0, 0]);
  });

  it('clears one option on remove-emoji and everything on remove-all', () => {
    save();
    for (const [user, emoji] of [
      ['5', one],
      ['6', one],
      ['7', two],
    ] as const) {
      reaction('MESSAGE_REACTION_ADD', emoji, { user_id: user });
    }
    emit('MESSAGE_REACTION_REMOVE_EMOJI', {
      guild_id: '10',
      channel_id: '20',
      message_id: '30',
      emoji: { id: null, name: one },
    });
    expect(votes()).toEqual([0, 1, 0]);
    emit('MESSAGE_REACTION_REMOVE_ALL', { guild_id: '10', channel_id: '20', message_id: '30' });
    expect(votes()).toEqual([0, 0, 0]);
  });

  it('marks the poll deleted when its message is deleted, singly or in bulk', () => {
    save();
    emit('MESSAGE_DELETE', { guild_id: '10', channel_id: '20', id: '30' });
    expect(getPoll(db, '10', 1)?.status).toBe('deleted');

    openPoll(db, { options: ['A', 'B'], endsAt: now + hour, now, messageId: '31' });
    emit('MESSAGE_DELETE_BULK', { guild_id: '10', channel_id: '20', ids: ['31', '99'] });
    expect(getPoll(db, '10', 2)?.status).toBe('deleted');
  });

  it('marks polls deleted when their channel or thread is deleted', () => {
    save();
    openPoll(db, {
      options: ['A', 'B'],
      endsAt: now + hour,
      now,
      messageId: '31',
      channelId: '21',
      hostId: '3',
    });
    emit('CHANNEL_DELETE', { guild_id: '10', id: '20' });
    emit('THREAD_DELETE', { guild_id: '10', id: '21' });
    expect(
      db
        .select()
        .from(polls)
        .all()
        .map((row) => row.status),
    ).toEqual(['deleted', 'deleted']);
  });

  it('ignores closed polls and other guilds', () => {
    save();
    reaction('MESSAGE_REACTION_ADD', one as string, { guild_id: '11' });
    expect(votes()).toEqual([0, 0, 0]);
    expect(castVote(db, '10', '30', '5', 0, now + 2 * hour)).toBeUndefined();
  });
});

import { container } from '@sapphire/framework';
import { type APIEmbed, Events, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import {
  banRequestFailed,
  handleHoneypotMessage,
  honeypot,
  honeypotConfig,
  resetCardSync,
  resetGuard,
  setHoneypot,
  type TriggerDeps,
} from '../src/features/honeypot/index.js';
import type { ModEvent } from '../src/features/logs/index.js';
import { testEnv } from './support/env.js';

const plain = {
  joinedTimestamp: 2_000_000,
  permissions: new PermissionsBitField(0n),
  roles: { highest: { position: 1 } },
};

const author = { id: '5', bot: false, createdTimestamp: 1_000_000 };

interface MessageOverrides {
  author?: typeof author;
  member?: typeof plain | null;
  guildOwner?: string;
  me?: typeof plain | null;
  guildId?: string | null;
  guild?: null;
  channelId?: string;
  webhookId?: string | null;
  system?: boolean;
  // Test-only extra fields (a thread's channel, chat-reward stub fields).
  [extra: string]: unknown;
}

function makeMessage(overrides: MessageOverrides = {}) {
  const { guildOwner, me, member, guild, author: authorOverride, ...rest } = overrides;
  const theGuild = {
    id: '2',
    name: 'Cazz',
    ownerId: guildOwner ?? '0',
    members: {
      me:
        me === undefined
          ? {
              joinedTimestamp: 0,
              permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers),
              roles: { highest: { position: 8 } },
            }
          : me,
      fetch: vi.fn(async (_userId: string): Promise<typeof plain> => plain),
    },
    bans: {
      create: vi.fn(
        async (_userId: string, _options: { deleteMessageSeconds: number; reason: string }) =>
          ({}) as unknown,
      ),
      remove: vi.fn(async (_userId: string, _reason: string) => null as unknown),
    },
  };
  return {
    guildId: '2' as string | null,
    channelId: '70',
    webhookId: null as string | null,
    system: false,
    author: {
      ...(authorOverride ?? author),
      send: vi.fn(async (_options: { embeds: APIEmbed[] }): Promise<unknown> => ({})),
    },
    member: member === undefined ? plain : member,
    delete: vi.fn(async (): Promise<unknown> => ({})),
    react: vi.fn(async (_emoji: string): Promise<unknown> => ({})),
    ...rest,
    // `guild` is typed non-null so tests can reach the mocks; the null case is cast.
    guild: guild === null ? (null as unknown as typeof theGuild) : theGuild,
  };
}

let clock: number;
let deps: TriggerDeps & {
  log: Mock<(guildId: string, event: ModEvent) => void>;
  refreshCard: Mock<(guildId: string) => void>;
};

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as never;
  resetGuard();
  setHoneypot(container.db, '2', '70', 'card-1', 1);
  clock = 10_000_000;
  deps = {
    db: container.db,
    botUserId: 'bot',
    now: () => clock,
    log: vi.fn<(guildId: string, event: ModEvent) => void>(),
    refreshCard: vi.fn<(guildId: string) => void>(),
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleHoneypotMessage', () => {
  it('softbans with a one hour wipe, unbans, counts and logs', async () => {
    const m = makeMessage();
    expect(await handleHoneypotMessage(m, deps)).toBe('softbanned');
    expect(m.author.send).toHaveBeenCalledExactlyOnceWith({
      embeds: [
        expect.objectContaining({
          title: 'Honeypot Triggered',
          description: expect.stringContaining('**softbanned** from **Cazz**'),
        }),
      ],
    });
    expect(m.react).not.toHaveBeenCalled();
    expect(m.guild.bans.create).toHaveBeenCalledWith('5', {
      deleteMessageSeconds: 3600,
      reason: honeypotConfig.banReason,
    });
    expect(m.author.send.mock.invocationCallOrder[0]).toBeLessThan(
      m.guild.bans.create.mock.invocationCallOrder[0] as number,
    );
    expect(m.guild.bans.remove).toHaveBeenCalledWith('5', honeypotConfig.unbanReason);
    expect(honeypot(container.db, '2').kicks).toBe(1);
    expect(deps.refreshCard).toHaveBeenCalledWith('2');
    expect(deps.log).toHaveBeenCalledWith('2', {
      type: 'honeypot_kick',
      userId: '5',
      channelId: '70',
      createdAt: 1_000_000,
      joinedAt: 2_000_000,
      dmSent: true,
      unbanFailed: false,
    });
    expect(m.delete).not.toHaveBeenCalled();
  });

  it('handles a burst from one account once', async () => {
    const messages = Array.from({ length: 5 }, () => makeMessage());
    const outcomes = await Promise.all(messages.map((m) => handleHoneypotMessage(m, deps)));
    expect(outcomes.sort()).toEqual(['busy', 'busy', 'busy', 'busy', 'softbanned']);
    const creates = messages.reduce((n, m) => n + m.guild.bans.create.mock.calls.length, 0);
    expect(creates).toBe(1);
    expect(honeypot(container.db, '2').kicks).toBe(1);
    expect(deps.log).toHaveBeenCalledTimes(1);
  });

  it('ignores the same account for 60 s after the softban', async () => {
    expect(await handleHoneypotMessage(makeMessage(), deps)).toBe('softbanned');
    const finishedAt = clock;
    clock = finishedAt + 59_999;
    expect(await handleHoneypotMessage(makeMessage(), deps)).toBe('busy');
    clock = finishedAt + 60_000;
    expect(await handleHoneypotMessage(makeMessage(), deps)).toBe('softbanned');
    expect(honeypot(container.db, '2').kicks).toBe(2);
  });

  it('ignores messages outside the honeypot, in its threads, in DMs and without a honeypot', async () => {
    const cases = [
      makeMessage({ channelId: '71' }),
      makeMessage({ channelId: 'thread-1', channel: { isThread: () => true, parentId: '70' } }),
      makeMessage({ guildId: null, guild: null }),
      makeMessage({ guildId: '3' }),
    ];
    for (const m of cases) {
      expect(await handleHoneypotMessage(m, deps)).toBe('ignored');
      if (m.guild) expect(m.guild.bans.create).not.toHaveBeenCalled();
      expect(m.delete).not.toHaveBeenCalled();
      expect(m.author.send).not.toHaveBeenCalled();
    }
  });

  it.each<[string, MessageOverrides]>([
    ['a bot', { author: { ...author, bot: true } }],
    ['a webhook', { webhookId: 'w' }],
    ['a system message', { system: true }],
    ['the bot itself', { author: { ...author, id: 'bot' } }],
  ])('ignores %s without sending a DM', async (_name, overrides) => {
    const m = makeMessage(overrides);
    expect(await handleHoneypotMessage(m, deps)).toBe('ignored');
    expect(m.delete).not.toHaveBeenCalled();
    expect(m.author.send).not.toHaveBeenCalled();
    expect(m.react).not.toHaveBeenCalled();
    expect(m.guild.bans.create).not.toHaveBeenCalled();
  });

  it.each<[string, MessageOverrides]>([
    [
      'staff',
      {
        member: {
          ...plain,
          permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages),
        },
      },
    ],
    [
      'an admin',
      {
        member: {
          ...plain,
          permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
        },
      },
    ],
    ['the owner', { guildOwner: '5' }],
  ])('notifies %s without kicking them', async (_name, overrides) => {
    const m = makeMessage(overrides);
    expect(await handleHoneypotMessage(m, deps)).toBe('ignored');
    expect(m.delete).not.toHaveBeenCalled();
    expect(m.author.send).toHaveBeenCalledExactlyOnceWith({
      embeds: [
        expect.objectContaining({
          title: 'Honeypot Triggered',
          description: expect.stringContaining(
            "**weren't kicked** because of your server permissions",
          ),
        }),
      ],
    });
    expect(m.react).toHaveBeenCalledExactlyOnceWith(honeypotConfig.emoji);
    expect(m.guild.bans.create).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
    expect(honeypot(container.db, '2').kicks).toBe(0);
  });

  it('still notifies an exempt member when Discord refuses the reaction', async () => {
    const m = makeMessage({ guildOwner: '5' });
    m.react.mockRejectedValue(new Error('Missing Permissions'));
    expect(await handleHoneypotMessage(m, deps)).toBe('ignored');
    expect(m.author.send).toHaveBeenCalledOnce();
    expect(m.delete).not.toHaveBeenCalled();
    expect(m.guild.bans.create).not.toHaveBeenCalled();
  });

  it('fetches an uncached member before deciding', async () => {
    const staff = makeMessage({ member: null });
    staff.guild.members.fetch.mockResolvedValue({
      ...plain,
      permissions: new PermissionsBitField(PermissionFlagsBits.ManageMessages),
    });
    expect(await handleHoneypotMessage(staff, deps)).toBe('ignored');
    expect(staff.guild.members.fetch).toHaveBeenCalledWith('5');

    const m = makeMessage({ member: null });
    expect(await handleHoneypotMessage(m, deps)).toBe('softbanned');
    expect(m.guild.members.fetch).toHaveBeenCalledWith('5');
    expect(deps.log).toHaveBeenCalledWith('2', expect.objectContaining({ joinedAt: 2_000_000 }));
  });

  it('softbans a member who already left by user ID', async () => {
    const m = makeMessage({ member: null });
    m.guild.members.fetch.mockRejectedValue(new Error('Unknown Member'));
    expect(await handleHoneypotMessage(m, deps)).toBe('softbanned');
    expect(m.guild.bans.create).toHaveBeenCalledWith('5', {
      deleteMessageSeconds: 3600,
      reason: honeypotConfig.banReason,
    });
    const event = deps.log.mock.calls[0]?.[1] as { joinedAt?: number };
    expect(event.joinedAt).toBeUndefined();
  });

  it('deletes the message and logs when the member is above the bot', async () => {
    const m = makeMessage({ member: { ...plain, roles: { highest: { position: 8 } } } });
    expect(await handleHoneypotMessage(m, deps)).toBe('failed');
    expect(m.delete).toHaveBeenCalled();
    expect(m.guild.bans.create).not.toHaveBeenCalled();
    expect(m.author.send).not.toHaveBeenCalled();
    expect(honeypot(container.db, '2').kicks).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('2', {
      type: 'honeypot_failed',
      userId: '5',
      channelId: '70',
      reason: 'their highest role is at or above mine',
      messageDeleted: true,
    });
  });

  it('reports a missing Ban Members', async () => {
    const m = makeMessage({
      me: {
        ...plain,
        permissions: new PermissionsBitField(0n),
        roles: { highest: { position: 8 } },
      },
    });
    expect(await handleHoneypotMessage(m, deps)).toBe('failed');
    expect(deps.log).toHaveBeenCalledWith(
      '2',
      expect.objectContaining({ type: 'honeypot_failed', reason: 'I lack Ban Members' }),
    );
  });

  it('notes an undeletable message', async () => {
    const m = makeMessage({ member: { ...plain, roles: { highest: { position: 8 } } } });
    m.delete.mockRejectedValue(new Error('Missing Permissions'));
    expect(await handleHoneypotMessage(m, deps)).toBe('failed');
    expect(deps.log).toHaveBeenCalledWith(
      '2',
      expect.objectContaining({ type: 'honeypot_failed', messageDeleted: false }),
    );
  });

  it('deletes later messages from an account it could not ban without logging again', async () => {
    const high = { ...plain, roles: { highest: { position: 8 } } };
    expect(await handleHoneypotMessage(makeMessage({ member: high }), deps)).toBe('failed');
    const second = makeMessage({ member: high });
    expect(await handleHoneypotMessage(second, deps)).toBe('busy');
    expect(second.delete).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
  });

  it('deletes every message of a concurrent burst it cannot ban, logging once', async () => {
    const high = { ...plain, roles: { highest: { position: 8 } } };
    const messages = Array.from({ length: 5 }, () => makeMessage({ member: high }));
    const outcomes = await Promise.all(messages.map((m) => handleHoneypotMessage(m, deps)));
    expect(outcomes.sort()).toEqual(['busy', 'busy', 'busy', 'busy', 'failed']);
    for (const m of messages) {
      expect(m.delete).toHaveBeenCalled();
      expect(m.guild.bans.create).not.toHaveBeenCalled();
    }
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith(
      '2',
      expect.objectContaining({ type: 'honeypot_failed' }),
    );
    expect(honeypot(container.db, '2').kicks).toBe(0);
  });

  it('deletes a message from a softbanned account that rejoins within the cooldown', async () => {
    expect(await handleHoneypotMessage(makeMessage(), deps)).toBe('softbanned');
    clock += 30_000;
    const again = makeMessage();
    expect(await handleHoneypotMessage(again, deps)).toBe('busy');
    expect(again.delete).toHaveBeenCalled();
    expect(again.guild.bans.create).not.toHaveBeenCalled();
    expect(again.author.send).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(honeypot(container.db, '2').kicks).toBe(1);
  });

  it('still bans when the DM fails', async () => {
    const m = makeMessage();
    m.author.send.mockRejectedValue(new Error('Cannot send messages to this user'));
    expect(await handleHoneypotMessage(m, deps)).toBe('softbanned');
    expect(m.guild.bans.create).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('2', expect.objectContaining({ dmSent: false }));
  });

  it('still bans when the DM hangs, without leaking a timer', async () => {
    vi.useFakeTimers();
    const m = makeMessage();
    m.author.send.mockReturnValue(new Promise(() => {}));
    const p = handleHoneypotMessage(m, deps);
    await vi.advanceTimersByTimeAsync(honeypotConfig.dmTimeoutMs);
    expect(await p).toBe('softbanned');
    expect(vi.getTimerCount()).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('2', expect.objectContaining({ dmSent: false }));
    vi.useRealTimers();
  });

  it('clears the DM timer on the happy path', async () => {
    vi.useFakeTimers();
    const m = makeMessage();
    expect(await handleHoneypotMessage(m, deps)).toBe('softbanned');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('logs a failed ban and deletes the message', async () => {
    const m = makeMessage();
    m.guild.bans.create.mockRejectedValue(new Error('Missing Permissions'));
    expect(await handleHoneypotMessage(m, deps)).toBe('failed');
    expect(m.delete).toHaveBeenCalled();
    expect(m.guild.bans.remove).not.toHaveBeenCalled();
    expect(honeypot(container.db, '2').kicks).toBe(0);
    expect(deps.refreshCard).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('2', {
      type: 'honeypot_failed',
      userId: '5',
      channelId: '70',
      reason: banRequestFailed,
      messageDeleted: true,
    });
  });

  it('flags a failed unban', async () => {
    const m = makeMessage();
    m.guild.bans.remove.mockRejectedValue(new Error('boom'));
    expect(await handleHoneypotMessage(m, deps)).toBe('softbanned');
    expect(deps.log).toHaveBeenCalledWith('2', expect.objectContaining({ unbanFailed: true }));
    expect(honeypot(container.db, '2').kicks).toBe(1);
  });

  it('never throws', async () => {
    const m = makeMessage({ member: null, me: null });
    m.guild.members.fetch.mockRejectedValue(new Error('x'));
    m.author.send.mockRejectedValue(new Error('x'));
    m.guild.bans.create.mockRejectedValue(new Error('x'));
    m.guild.bans.remove.mockRejectedValue(new Error('x'));
    m.delete.mockRejectedValue(new Error('x'));
    await expect(handleHoneypotMessage(m, deps)).resolves.toBe('failed');

    // Even a throwing dependency (the database) is contained.
    resetGuard();
    const broken = {
      ...deps,
      db: {
        select: () => {
          throw new Error('db gone');
        },
      } as never,
    };
    await expect(handleHoneypotMessage(makeMessage(), broken)).resolves.toBe('failed');
    expect(container.logger.warn).toHaveBeenCalled();
  });

  it('finishes the guard when counting the kick throws after the ban', async () => {
    const db = container.db;
    // Reads work (the channel check), writes fail: incrementKicks throws after a good ban.
    const writesFail = {
      ...deps,
      db: new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'insert') {
            return () => {
              throw new Error('disk full');
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    };
    const first = makeMessage();
    await expect(handleHoneypotMessage(first, writesFail)).resolves.toBe('failed');
    expect(first.guild.bans.create).toHaveBeenCalled();
    expect(honeypot(db, '2').kicks).toBe(0);
    expect(container.logger.warn).toHaveBeenCalled();

    clock += honeypotConfig.cooldownMs - 1;
    const again = makeMessage();
    expect(await handleHoneypotMessage(again, deps)).toBe('busy');
    expect(again.delete).toHaveBeenCalled();
    expect(again.guild.bans.create).not.toHaveBeenCalled();

    // Finished, not stuck in flight: the cooldown ends and the account is handled again.
    clock += 1;
    expect(await handleHoneypotMessage(makeMessage(), deps)).toBe('softbanned');
  });
});

describe('honeypot listener', () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  afterEach(() => {
    resetCardSync();
  });

  it('softbans through the messageCreate listener even without a mod log', async () => {
    const stub = makeMessage({
      content: 'hi',
      createdTimestamp: 1000,
      client,
      channel: {
        id: '70',
        type: 0,
        isDMBased: () => false,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
      },
      reply: vi.fn(async () => ({ createdTimestamp: 1042, edit: vi.fn() })),
    });
    client.emit(Events.MessageCreate, stub as never);
    await vi.waitFor(() =>
      expect(stub.guild.bans.create).toHaveBeenCalledWith('5', {
        deleteMessageSeconds: 3600,
        reason: honeypotConfig.banReason,
      }),
    );
    await vi.waitFor(() => expect(honeypot(container.db, '2').kicks).toBe(1));
  });
});

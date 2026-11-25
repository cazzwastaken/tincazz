import { container } from '@sapphire/framework';
import { MessageFlags } from 'discord.js';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import {
  type EconomyEvent,
  economyLogCard,
  logEconomy,
  logMod,
  type ModEvent,
  modLogCard,
} from '../src/features/logs/index.js';
import { setLogChannel } from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';

// Sapphire keeps global state; share one client across the tests in this file.
let client: ReturnType<typeof createClient>;
let send: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  send = vi.fn(async () => ({}));
  warn = vi.fn();
  container.logger = { warn } as unknown as typeof container.logger;
  client.channels.cache.set('50', { id: '50', isSendable: () => true, send } as never);
});

const json = (card: unknown) => JSON.stringify(card);

it('renders a card for every event type', () => {
  const economy: [EconomyEvent, string[]][] = [
    [
      {
        type: 'admin_adjust',
        actorId: '9',
        userId: '1',
        action: 'give',
        amount: 500,
        reason: 'r',
        balance: 700,
      },
      ['<@1>', '500'],
    ],
    [
      { type: 'jackpot', userId: '1', bet: 10, payout: 1234, potWon: 1000, roleAssigned: true },
      ['<@1>', '1,234'],
    ],
    [{ type: 'member_departed', userId: '1', balance: 300, purgeAt: 5000 }, ['<@1>', '300']],
    [{ type: 'member_restored', userId: '1', balance: 300 }, ['<@1>', '300']],
    [
      { type: 'reconcile_summary', departed: 1, restored: 2, purged: ['3'], coinsRemoved: 999 },
      ['<@3>', '999'],
    ],
  ];
  for (const [event, needles] of economy) {
    const out = json(economyLogCard(event, 1000));
    for (const needle of needles) expect(out, event.type).toContain(needle);
    expect(out).toContain('<t:1:f>');
  }

  const mod: [ModEvent, string[]][] = [
    [{ type: 'autorole_added', actorId: '9', roleId: '77', target: 'member' }, ['<@9>', '<@&77>']],
    [{ type: 'autorole_removed', actorId: '9', roleId: '77', target: 'bot' }, ['<@&77>']],
    [
      {
        type: 'log_channel_set',
        actorId: '9',
        kind: 'mod',
        fromChannelId: '40',
        toChannelId: '50',
      },
      ['<#40>', '<#50>'],
    ],
    [{ type: 'log_channel_cleared', actorId: '9', kind: 'mod', fromChannelId: '40' }, ['<#40>']],
    [
      { type: 'setting_auto_cleared', setting: 'autorole', id: '77', detail: 'role deleted' },
      ['role deleted'],
    ],
    [
      {
        type: 'honeypot_kick',
        userId: '1',
        channelId: '70',
        createdAt: 1_000_000,
        joinedAt: 2_000_000,
        dmSent: false,
        unbanFailed: true,
      },
      [
        '<@1> was kicked for triggering the honeypot in <#70>',
        'User ID: 1 · Created: <t:1000:R> · Joined: <t:2000:R>',
        'DM not delivered',
        '⚠️ still banned, unban failed',
      ],
    ],
    [
      {
        type: 'honeypot_failed',
        userId: '1',
        channelId: '70',
        reason: 'their highest role is at or above mine',
        messageDeleted: true,
      },
      ['<@1>', '<#70>', 'their highest role is at or above mine', 'Their message was deleted'],
    ],
    [
      { type: 'honeypot_set', actorId: '9', fromChannelId: '69', toChannelId: '70' },
      ['<@9> set the honeypot to <#70>', 'Previously <#69>'],
    ],
    [
      { type: 'honeypot_cleared', actorId: '9', fromChannelId: '70' },
      ['<@9> cleared the honeypot (was <#70>)'],
    ],
    [
      {
        type: 'setting_auto_cleared',
        setting: 'honeypot',
        id: '70',
        detail: 'honeypot channel was deleted',
      },
      ['Honeypot channel <#70> was removed', 'honeypot channel was deleted'],
    ],
    [
      { type: 'autorole_failed', userId: '1', failures: [{ roleId: '77', reason: 'hierarchy' }] },
      ['<@1>', '<@&77>', 'hierarchy'],
    ],
    [
      {
        type: 'hall_set',
        actorId: '9',
        fromChannelId: '69',
        toChannelId: '70',
        threshold: 7,
      },
      ['<@9> set the Hall of Fame to <#70> (7 people)', 'Previously <#69>'],
    ],
    [
      { type: 'hall_set', actorId: '9', toChannelId: '70', threshold: 5 },
      ['<@9> set the Hall of Fame to <#70> (5 people)'],
    ],
    [
      { type: 'hall_cleared', actorId: '9', fromChannelId: '70' },
      ['<@9> cleared the Hall of Fame (was <#70>)', 'Existing posts stay'],
    ],
    [
      { type: 'hall_threshold', actorId: '9', from: 5, to: 8 },
      ['<@9> changed the threshold from 5 to 8 people'],
    ],
    [
      { type: 'hall_exempt_added', actorId: '9', channelId: '71' },
      ['Hall of Fame exemption added', '<@9> exempted <#71> from the Hall of Fame'],
    ],
    [
      { type: 'hall_exempt_removed', actorId: '9', channelId: '71' },
      ['Hall of Fame exemption removed', '<@9> stopped exempting <#71>'],
    ],
    [
      {
        type: 'setting_auto_cleared',
        setting: 'hall_of_fame',
        id: '70',
        detail: 'hall channel was deleted',
      },
      ['Hall of Fame channel <#70> was removed', 'hall channel was deleted'],
    ],
    [
      {
        type: 'setting_auto_cleared',
        setting: 'hall_exempt',
        id: '71',
        detail: 'exempt channel was deleted',
      },
      ['Hall of Fame exempt channel <#71> was removed'],
    ],
  ];
  for (const [event, needles] of mod) {
    const out = json(modLogCard(event, 1000));
    for (const needle of needles) expect(out, event.type).toContain(needle);
  }

  const purged = Array.from({ length: 25 }, (_, i) => String(i + 100));
  const big = json(
    economyLogCard(
      { type: 'reconcile_summary', departed: 0, restored: 0, purged, coinsRemoved: 5 },
      1000,
    ),
  );
  expect(big).toContain('25');
  expect(big).not.toContain('<@');
});

const event: EconomyEvent = { type: 'member_restored', userId: '1', balance: 3 };

it('posts economy events to the economy channel', async () => {
  setLogChannel(container.db, '2', 'economy', '50', 1);
  await logEconomy('2', event);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).toMatchObject({ flags: MessageFlags.IsComponentsV2 });
});

it('posts mod events to the mod channel only', async () => {
  setLogChannel(container.db, '2', 'economy', '50', 1);
  await logMod('2', { type: 'log_channel_cleared', actorId: '9', kind: 'mod', fromChannelId: '4' });
  expect(send).not.toHaveBeenCalled();
});

it('does nothing when no channel is set', async () => {
  await logEconomy('2', event);
  expect(send).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

it('warns when the channel is gone or sending throws', async () => {
  setLogChannel(container.db, '2', 'economy', '404', 1);
  vi.spyOn(client.channels, 'fetch').mockRejectedValueOnce(new Error('unknown'));
  await expect(logEconomy('2', event)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);

  setLogChannel(container.db, '2', 'economy', '50', 2);
  send.mockRejectedValueOnce(new Error('missing access'));
  await expect(logEconomy('2', event)).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(2);
});

it('never lets user text ping', async () => {
  setLogChannel(container.db, '2', 'economy', '50', 1);
  await logEconomy('2', {
    type: 'admin_adjust',
    actorId: '9',
    userId: '1',
    action: 'take',
    amount: 5,
    reason: '@everyone <@3>',
    balance: 0,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[0]).not.toHaveProperty('allowedMentions');
});

it('keeps a clean honeypot kick card short', () => {
  const out = json(
    modLogCard(
      {
        type: 'honeypot_kick',
        userId: '1',
        channelId: '70',
        createdAt: 1_000_000,
        dmSent: true,
        unbanFailed: false,
      },
      1000,
    ),
  );
  for (const absent of ['Joined', 'DM not delivered', 'still banned']) {
    expect(out).not.toContain(absent);
  }
});

it('says when a honeypot message could not be deleted', () => {
  const out = json(
    modLogCard(
      {
        type: 'honeypot_failed',
        userId: '1',
        channelId: '70',
        reason: 'missing permissions',
        messageDeleted: false,
      },
      1000,
    ),
  );
  expect(out).toContain('Their message could not be deleted');
});

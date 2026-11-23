import { container } from '@sapphire/framework';
import {
  ChannelType,
  Events,
  GatewayDispatchEvents,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { giveaways } from '../src/db/schema.js';
import { giveawayList } from '../src/features/giveaways/cards.js';
import { giveaway } from '../src/features/giveaways/config.js';
import { queueGiveaway, updateGiveaway } from '../src/features/giveaways/store.js';
import { testEnv } from './support/env.js';
import { openGiveaway } from './support/giveaways.js';
import { type ChatInputOptions, makeChatInput } from './support/interaction.js';

const client = createClient(testEnv);

beforeAll(() => client.stores.load());
beforeEach(() => {
  container.db = openDatabase(':memory:');
});
afterAll(() => client.destroy());
afterEach(() => closeDatabase(container.db));

function interaction({
  guildPermissions = PermissionFlagsBits.ManageMessages,
  ...options
}: Partial<ChatInputOptions> & { guildPermissions?: bigint } = {}) {
  const input = makeChatInput(client, {
    commandName: 'giveaway',
    subcommand: 'create',
    userId: '42',
    permissions: PermissionFlagsBits.ManageMessages,
    options: { prize: 'Nitro 1 month', duration: '12 hours' },
    ...options,
  });
  return {
    ...input,
    member: { ...input.member, permissions: new PermissionsBitField(guildPermissions) },
    id: '100',
    appPermissions: new PermissionsBitField(PermissionsBitField.All),
    deferReply: vi.fn(),
    channel: { id: '3', type: ChannelType.GuildText, send: vi.fn() },
  };
}

function run(input: ReturnType<typeof interaction>) {
  client.emit(Events.InteractionCreate, input as never);
}

function add(guildId: string, channelId: string, messageId: string, prize: string) {
  const now = Date.now();
  return openGiveaway(container.db, guildId, channelId, messageId, prize, '81', now + 60_000, now);
}

describe('/giveaway', () => {
  it('only lets staff cancel a pending giveaway in its own channel', async () => {
    const visible = add('2', '3', '30', 'Visible');
    const other = add('2', '4', '31', 'Other');
    for (const [id, guildPermissions, permissions, expected] of [
      [visible.id, 0n, PermissionFlagsBits.ManageMessages, 'Only server staff'],
      [visible.id, PermissionFlagsBits.ManageMessages, 0n, 'You need Manage Messages'],
      [
        other.id,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageMessages,
        'No pending giveaway',
      ],
      [
        visible.id,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageMessages,
        '#1 cancelled',
      ],
    ] as const) {
      const input = interaction({
        subcommand: 'cancel',
        options: { id },
        guildPermissions,
        permissions,
      });
      run(input);
      await vi.waitFor(() =>
        expect(input.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining(expected) }),
        ),
      );
    }
  });
  it.each([PermissionFlagsBits.ManageMessages, PermissionFlagsBits.Administrator])(
    'persists the creation request for staff with permission %s',
    async (permission) => {
      const input = interaction({ guildPermissions: permission, permissions: permission });
      run(input);
      await vi.waitFor(() =>
        expect(input.editReply).toHaveBeenCalledWith(
          'Giveaway #1 queued. It will open in this channel.',
        ),
      );
      expect(input.deferReply).toHaveBeenCalled();
      expect(input.channel.send).not.toHaveBeenCalled();

      const [row] = container.db.select().from(giveaways).all();
      expect(row).toMatchObject({
        id: 1,
        guildId: '2',
        channelId: '3',
        messageId: null,
        creationId: '100',
        hostId: '42',
        prize: 'Nitro 1 month',
        status: 'publishing',
        endsAt: null,
        durationMs: 12 * 3_600_000,
      });
    },
  );

  it.each([0n, PermissionFlagsBits.ManageMessages])(
    'denies a non-staff member with channel permission %s',
    async (permissions) => {
      const input = interaction({ guildPermissions: 0n, permissions });
      run(input);
      await vi.waitFor(() =>
        expect(input.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining('Only server staff') }),
        ),
      );
      expect(input.deferReply).not.toHaveBeenCalled();
      expect(container.db.select().from(giveaways).all()).toEqual([]);
    },
  );

  it('rejects invalid durations and distinguishes member from bot permissions', async () => {
    const invalid = interaction({ options: { prize: 'Nitro', duration: '0 days' } });
    const member = interaction({ permissions: 0n });
    const bot = { ...interaction(), appPermissions: new PermissionsBitField(0n) };
    for (const [input, text] of [
      [invalid, '1 minute to 30 days'],
      [member, 'You need Manage Messages'],
      [bot, 'I need View Channel'],
    ] as const) {
      run(input);
      await vi.waitFor(() =>
        expect(input.reply).toHaveBeenCalledWith(
          expect.objectContaining({ content: expect.stringContaining(text) }),
        ),
      );
      expect(input.channel.send).not.toHaveBeenCalled();
    }
  });

  it('lists guild-scoped IDs and filters out private channels and ended giveaways', async () => {
    const shown = add('2', '3', '30', 'Visible prize');
    const hidden = add('2', '4', '31', 'Private prize');
    updateGiveaway(container.db, hidden, { accessFailures: 1 });
    const other = add('9', '9', '90', 'Other guild prize');
    const ended = add('2', '3', '32', 'Old prize');
    expect([shown.id, hidden.id, other.id, ended.id]).toEqual([1, 2, 1, 3]);
    updateGiveaway(container.db, shown, { entryCount: 24, accessFailures: 1 });
    updateGiveaway(container.db, ended, { status: 'ended', nextSyncAt: null });

    const input = interaction({
      subcommand: 'list',
      guildPermissions: 0n,
      permissions: 0n,
      guild: {
        channels: {
          cache: new Map([
            ['3', { permissionsFor: () => new PermissionsBitField(PermissionsBitField.All) }],
            ['4', { permissionsFor: () => new PermissionsBitField(0n) }],
          ]),
        },
      },
    });
    run(input);
    await vi.waitFor(() => expect(input.reply).toHaveBeenCalledTimes(1));
    const output = JSON.stringify(input.reply.mock.calls);
    expect(output).toContain('#1 · Visible prize');
    expect(output).toContain('Hosted by <@81> · 24 entries');
    expect(output).toContain('Bot access blocked');
    expect(output).toContain('https://discord.com/channels/2/3/30');
    expect(output).not.toMatch(/Private prize|Other guild prize|Old prize/);
  });

  it('deduplicates creation requests and pages visible giveaways', () => {
    const first = add('2', '3', '30', 'Original prize');
    const duplicate = queueGiveaway(
      container.db,
      {
        guildId: '2',
        channelId: '3',
        creationId: '30',
        hostId: '81',
        prize: 'Duplicate prize',
        durationMs: 60_000,
      },
      Date.now(),
    );
    expect(duplicate).toEqual(first);
    const rows = [
      first,
      ...Array.from({ length: 8 }, (_, index) =>
        add('2', '3', String(31 + index), `Prize ${index + 2}`),
      ),
    ];

    const page = giveawayList(rows, 2, Math.max(...rows.map((row) => row.endsAt ?? 0))).toJSON();
    expect(page.footer?.text).toBe('Page 2 of 2');
    expect(page.fields).toEqual([
      expect.objectContaining({
        name: '#9 · Prize 9',
        value: expect.stringContaining('Draw pending'),
      }),
    ]);
  });

  it('handles reaction packets for uncached messages and ignores other guilds and emojis', () => {
    const row = add('2', '3', '30', 'Nitro');
    const nextSyncAt = Date.now() + 50_000;
    updateGiveaway(container.db, row, { nextSyncAt });
    const emit = (
      guildId: string,
      name: string,
      event = GatewayDispatchEvents.MessageReactionRemove,
    ) =>
      client.emit(
        Events.Raw,
        {
          t: event,
          d: { guild_id: guildId, message_id: row.messageId, emoji: { id: null, name } },
        },
        0,
      );
    const scheduledAt = () => container.db.select().from(giveaways).get()?.nextSyncAt;
    emit('2', '👍');
    emit('9', giveaway.emoji);
    expect(scheduledAt()).toBe(nextSyncAt);
    emit('2', giveaway.emoji);
    expect(scheduledAt()).toBeLessThan(nextSyncAt);
    client.emit(
      Events.Raw,
      {
        t: GatewayDispatchEvents.MessageDeleteBulk,
        d: { guild_id: '2', ids: [row.messageId] },
      },
      0,
    );
    expect(container.db.select().from(giveaways).get()).toMatchObject({
      status: 'deleted',
      nextSyncAt: null,
    });
  });
});

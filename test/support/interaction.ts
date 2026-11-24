import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { vi } from 'vitest';
import type { createClient } from '../../src/client.js';

export interface ChatInputOptions {
  commandName: string;
  userId: string;
  guildId?: string;
  options?: Record<string, unknown>;
  subcommand?: string;
  /** The invoking member's permission bits in the channel (default: all). */
  permissions?: bigint;
  subcommandGroup?: string;
  /** User option IDs that are not guild members (`getMember` returns null for them). */
  absentMembers?: string[];
  /** The guild stub (default: an empty guild with a `me` member). */
  guild?: unknown;
}

/** The bot's own guild member stub. */
export function makeMe() {
  return {
    id: 'me',
    roles: { highest: { position: 8 } },
    permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
  };
}

export function makeUser(id: string, bot = false) {
  return {
    id,
    bot,
    toString: () => `<@${id}>`,
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
  };
}

/** An interaction stub for slash commands, in the style of the `/ping` test. */
export function makeChatInput(
  client: ReturnType<typeof createClient>,
  {
    commandName,
    userId,
    guildId = '2',
    options = {},
    subcommand,
    permissions = PermissionsBitField.All,
    subcommandGroup,
    absentMembers = [],
    guild = {
      id: guildId,
      ownerId: '0',
      channels: { cache: new Map() },
      roles: { cache: new Map() },
      members: { me: makeMe(), cache: new Map(), fetch: async () => null },
    },
  }: ChatInputOptions,
) {
  const announce = vi.fn(async () => ({}));
  return {
    announce,
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
    commandName,
    commandId: '1',
    createdTimestamp: 1000,
    client,
    guildId,
    channelId: '3',
    user: makeUser(userId),
    memberPermissions: new PermissionsBitField(permissions),
    replied: false,
    deferred: false,
    options: {
      getUser: (name: string) => (options[name] as never) ?? null,
      getInteger: (name: string) => (options[name] as number | undefined) ?? null,
      getString: (name: string) => (options[name] as string | undefined) ?? null,
      getBoolean: (name: string) => (options[name] as boolean | undefined) ?? null,
      getSubcommand: () => subcommand ?? null,
      getSubcommandGroup: () => subcommandGroup ?? null,
      getChannel: (name: string) => (options[name] as never) ?? null,
      getRole: (name: string) => (options[name] as never) ?? null,
      getMember: (name: string) => {
        const user = options[name] as { id: string } | undefined;
        if (!user || absentMembers.includes(user.id)) return null;
        return { id: user.id } as never;
      },
    },
    guild,
    inCachedGuild: () => true,
    member: { roles: { add: vi.fn(async () => undefined) } },
    id: '42',
    reply: vi.fn(async () => ({ resource: { message: { id: 'card-1', reply: announce } } })),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(),
  };
}

export interface ButtonOptions {
  customId: string;
  userId: string;
  guildId?: string;
  /** The ID of the message the button is on (default: `m1`). */
  messageId?: string;
}

/** An interaction stub for a message component button click. */
export function makeButton(
  client: ReturnType<typeof createClient>,
  { customId, userId, guildId = '2', messageId = 'm1' }: ButtonOptions,
) {
  const announce = vi.fn(async (_options: unknown) => ({}));
  return {
    announce,
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isMessageComponent: () => true,
    isButton: () => true,
    isRepliable: () => true,
    id: '42',
    customId,
    client,
    guildId,
    channelId: '3',
    user: makeUser(userId),
    replied: false,
    deferred: false,
    inCachedGuild: () => true,
    member: { roles: { add: vi.fn(async () => undefined) } },
    message: { id: messageId, reply: announce, edit: vi.fn(async (_options: unknown) => ({})) },
    reply: vi.fn(async (_options: unknown) => undefined),
    update: vi.fn(async (_options: unknown) => undefined),
    editReply: vi.fn(async (_options: unknown) => undefined),
    followUp: vi.fn(async (_options: unknown) => undefined),
  };
}

export interface SelectOptions extends ButtonOptions {
  values: string[];
}

/** An interaction stub for a string select menu choice. */
export function makeSelect(
  client: ReturnType<typeof createClient>,
  { values, ...options }: SelectOptions,
) {
  return {
    ...makeButton(client, options),
    isButton: () => false,
    isStringSelectMenu: () => true,
    isAnySelectMenu: () => true,
    values,
  };
}

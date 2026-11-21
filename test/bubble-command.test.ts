import {
  Collection,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { bubbleUsage, messages } from '../src/features/imaging/index.js';
import { errorReply } from '../src/features/ui/index.js';
import { testEnv } from './support/env.js';
import { makeGif } from './support/images.js';
import { makeChatInput, makeMe } from './support/interaction.js';

// Sapphire keeps global state, so a second client in the same process loses its built-in
// preconditions. Share one client across the tests in this file.
let client: ReturnType<typeof createClient>;
let gif: Buffer;

const tenor = 'https://media.tenor.com/abc/cat.gif';

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
  // Registration normally runs on ready and maps the context menu name to the command.
  const commands = client.stores.get('commands');
  const bubble = commands.get('bubble');
  if (!bubble?.registerApplicationCommands) throw new Error('bubble command not loaded');
  await bubble.registerApplicationCommands(bubble.applicationCommandRegistry);
  for (const name of bubble.applicationCommandRegistry.contextMenuCommands) {
    commands.aliases.set(name, bubble);
  }
  gif = await makeGif({ width: 64, height: 48, frames: 3, delay: 100, loop: 0 });
});

beforeEach(() => {
  // The runIn precondition fetches the channel over REST, which needs a token.
  vi.spyOn(client.channels, 'fetch').mockResolvedValue({
    type: 0,
    isDMBased: () => false,
    isThread: () => false,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(
    async () => new Response(new Uint8Array(gif), { headers: { 'content-type': 'image/gif' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A slash interaction with the extra option and reply stubs the image commands use. */
function slash(userId: string, options: Record<string, unknown> = {}) {
  const base = makeChatInput(client, { commandName: 'bubble', userId, options });
  const interaction = Object.assign(base, {
    options: { ...base.options, getAttachment: () => null },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deleteReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  });
  return interaction;
}

function prefixMessage(
  content: string,
  userId: string,
  {
    attachment = false,
    canAttach = true,
    replyTo = null,
    unfetchableReply = false,
  }: {
    attachment?: boolean;
    canAttach?: boolean;
    replyTo?: unknown;
    /** a reply to a message that cannot be fetched (deleted) */
    unfetchableReply?: boolean;
  } = {},
) {
  const attachments = new Collection<string, unknown>();
  if (attachment) {
    attachments.set('1', {
      url: 'https://cdn.discordapp.com/attachments/1/2/cat.gif',
      contentType: 'image/gif',
    });
  }
  return {
    id: 'm1',
    content,
    createdTimestamp: 1000,
    author: { bot: false, id: userId, toString: () => `<@${userId}>` },
    webhookId: null,
    system: false,
    attachments,
    reference:
      replyTo || unfetchableReply
        ? { messageId: 'target', channelId: '3', guildId: '2', type: 0 }
        : null,
    fetchReference: vi.fn(async () => replyTo),
    channelId: '3',
    guild: {
      id: '2',
      members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) },
    },
    guildId: '2',
    channel: {
      id: '3',
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
      isSendable: () => true,
      sendTyping: vi.fn(async () => undefined),
      // Sapphire needs View Channel and Send Messages to run a command at all.
      permissionsFor: () => ({
        has: (bit: bigint) => bit !== PermissionFlagsBits.AttachFiles || canAttach,
      }),
    },
    client,
    reply: vi.fn(async (_options: unknown) => ({})),
  };
}

const runPrefix = async (message: ReturnType<typeof prefixMessage>) => {
  client.emit(Events.MessageCreate, message as never);
  await vi.waitFor(() => expect(message.reply).toHaveBeenCalled(), { timeout: 10000 });
};

const runSlash = async (interaction: ReturnType<typeof slash>) => {
  client.emit(Events.InteractionCreate, interaction as never);
  await vi.waitFor(
    () =>
      expect(
        interaction.editReply.mock.calls.length + interaction.followUp.mock.calls.length,
      ).toBeGreaterThan(0),
    { timeout: 10000 },
  );
};

describe('/bubble', () => {
  it('defers publicly then edits in one bubble.gif', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('u1', { url: tenor });
    await runSlash(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [options] = interaction.editReply.mock.calls[0] as unknown as [
      { files: { name: string }[] },
    ];
    expect(options.files).toHaveLength(1);
    expect(options.files[0]?.name).toBe('bubble.gif');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('refuses a link that is not on the allowlist', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('u2', { url: 'https://evil.com/a.gif' });
    await runSlash(interaction);

    expect(interaction.deleteReply).toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.notAllowed));
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the public deferred reply when something unexpected throws', async () => {
    stubFetch();
    const interaction = slash('u8', { url: tenor });
    // Sapphire loads the command in its own module graph, so a spy on the shared job queue would
    // not reach it. Make gathering the inputs throw instead: anything that is not an ImagingError.
    interaction.options.getString = () => {
      throw new TypeError('boom');
    };
    await runSlash(interaction);

    expect(interaction.deleteReply).toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: 'Something went wrong running that. It has been logged.',
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it('shows the usage when nothing was given', async () => {
    stubFetch();
    const interaction = slash('u3');
    await runSlash(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(
      errorReply('Give me an image: attach one, paste a link, or pick a user.'),
    );
    expect(interaction.editReply).not.toHaveBeenCalled();
  });
});

describe('?bubble', () => {
  it('replies with a file for an attached image', async () => {
    stubFetch();
    const message = prefixMessage('?bubble white', 'u4', { attachment: true });
    await runPrefix(message);

    const [options] = message.reply.mock.calls[0] as unknown as [{ files: { name: string }[] }];
    expect(options.files).toHaveLength(1);
    expect(options.files[0]?.name).toBe('bubble.gif');
    expect(message.channel.sendTyping).toHaveBeenCalled();
  });

  it('replies with the usage for an unknown word', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?bubble banana', 'u5', { attachment: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(bubbleUsage('?'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for Attach Files when the bot lacks it', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?bubble', 'u6', { attachment: true, canAttach: false });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.noAttachFiles);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a second use within the cooldown with the cooldown message', async () => {
    stubFetch();
    const first = prefixMessage('?bubble', 'u7', { attachment: true });
    await runPrefix(first);
    expect(first.reply.mock.calls[0]?.[0]).toHaveProperty('files');

    const second = prefixMessage('?bubble', 'u7', { attachment: true });
    await runPrefix(second);
    const [text] = second.reply.mock.calls[0] as unknown as [unknown];
    expect(text).toEqual(expect.stringMatching(/cooldown|wait|seconds?/i));
    expect(second.reply.mock.calls[0]?.[0]).not.toHaveProperty('files');
  });
});

const avatar = 'https://cdn.discordapp.com/avatars/40/abc.png';
const guildId = '200000000000000000';
const channelId = '300000000000000000';
const messageId = '400000000000000000';

/** A message in the channel of the prefix test messages. */
const inPrefixChannel = <T>(message: T) => ({ ...message, guildId: '2', channelId: '3' });

/** A message to bubble: by default text only, from a member with a role colour. */
function targetMessage({
  content = 'hello <@41> this is a message',
  image = false,
}: {
  content?: string;
  image?: boolean;
} = {}) {
  const attachments = new Collection<string, unknown>();
  if (image) {
    attachments.set('1', {
      url: 'https://cdn.discordapp.com/attachments/1/2/cat.gif',
      contentType: 'image/gif',
    });
  }
  const author = {
    id: '40',
    displayName: 'cazz',
    displayAvatarURL: () => avatar,
  };
  return {
    id: messageId,
    content,
    createdTimestamp: Date.UTC(2026, 10, 21, 14, 32),
    author,
    member: { displayName: 'Cazz', displayHexColor: '#e91e63', displayAvatarURL: () => avatar },
    webhookId: null,
    guildId,
    channelId,
    attachments,
    embeds: [],
    stickers: new Collection(),
    mentions: {
      users: new Collection([['41', { id: '41', globalName: 'Tin', username: 'tin' }]]),
      members: null,
      roles: new Collection(),
      channels: new Collection(),
    },
  };
}

const allPermissions = PermissionsBitField.All;
const readOnly = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;

/** A guild with one text channel holding `target`, and per-member permissions in it. */
function guildWith(
  target: unknown,
  { userPermissions = allPermissions, botPermissions = readOnly } = {},
) {
  const channel = {
    id: channelId,
    guildId,
    type: 0,
    isTextBased: () => true,
    permissionsFor: (member: { id: string }) =>
      new PermissionsBitField(member.id === 'me' ? botPermissions : userPermissions),
    messages: { fetch: vi.fn(async (id: string) => (id === messageId ? target : null)) },
  };
  const guild = {
    id: guildId,
    ownerId: '0',
    channels: {
      cache: new Collection([[channelId, channel]]),
      fetch: vi.fn(async () => {
        throw new Error('Unknown Channel');
      }),
    },
    roles: { cache: new Map() },
    members: {
      me: makeMe(),
      fetch: vi.fn(async (id: string) => ({ id })),
      fetchMe: vi.fn(async () => makeMe()),
    },
  };
  return { guild, channel };
}

function slashInGuild(userId: string, guild: unknown, options: Record<string, unknown>) {
  const base = makeChatInput(client, { commandName: 'bubble', userId, options, guildId, guild });
  const interaction = Object.assign(base, {
    channelId,
    options: { ...base.options, getAttachment: () => null },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deleteReply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  });
  return interaction;
}

const sentFile = (calls: unknown[][]) =>
  (calls[0]?.[0] as { files?: { name: string }[] } | undefined)?.files?.[0]?.name;

const link = (guild: string) => `https://discord.com/channels/${guild}/${channelId}/${messageId}`;

describe('bubbling a message', () => {
  it('?bubble as a reply to a text message bubbles a screenshot of it', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?bubble', 'u10', { replyTo: inPrefixChannel(targetMessage()) });
    await runPrefix(message);

    expect(sentFile(message.reply.mock.calls)).toBe('bubble.gif');
    // only the avatar is downloaded: the message has no image
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(avatar);
  });

  it('?bubble as a reply to a message that cannot be found says so, not the usage', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?bubble', 'u30', { unfetchableReply: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.messageNotFound);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('?bubble as a reply with an attached image still uses the attachment', async () => {
    stubFetch();
    const message = prefixMessage('?bubble', 'u31', { attachment: true, unfetchableReply: true });
    await runPrefix(message);
    expect(sentFile(message.reply.mock.calls)).toBe('bubble.gif');
  });

  it('?bubble as a reply to an image-only message bubbles the image itself', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?bubble', 'u11', {
      replyTo: inPrefixChannel(targetMessage({ content: '', image: true })),
    });
    await runPrefix(message);

    expect(sentFile(message.reply.mock.calls)).toBe('bubble.gif');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/attachments/');
  });

  it('?bubble prefers an attached image over the replied message', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?bubble', 'u12', {
      attachment: true,
      replyTo: inPrefixChannel(targetMessage()),
    });
    await runPrefix(message);

    expect(sentFile(message.reply.mock.calls)).toBe('bubble.gif');
    expect(message.fetchReference).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('/bubble message:<link> in the same guild bubbles it', async () => {
    const fetchMock = stubFetch();
    const target = targetMessage({ content: 'look', image: true });
    const { guild, channel } = guildWith(target);
    const interaction = slashInGuild('u13', guild, { message: link(guildId) });
    await runSlash(interaction);

    expect(sentFile(interaction.editReply.mock.calls)).toBe('bubble.gif');
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
    // the avatar and the image under the text
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('/bubble message:<id> looks in the current channel', async () => {
    stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = slashInGuild('u14', guild, { message: messageId });
    await runSlash(interaction);

    expect(sentFile(interaction.editReply.mock.calls)).toBe('bubble.gif');
    expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
  });

  it('refuses a link to another guild without looking it up', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = slashInGuild('u15', guild, { message: link('999999999999999999') });
    await runSlash(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a message in a channel the user cannot view', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage(), {
      userPermissions: PermissionFlagsBits.ReadMessageHistory,
    });
    const interaction = slashInGuild('u16', guild, { message: link(guildId) });
    await runSlash(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a message in a channel the bot cannot read the history of', async () => {
    stubFetch();
    const { guild, channel } = guildWith(targetMessage(), {
      botPermissions: PermissionFlagsBits.ViewChannel,
    });
    const interaction = slashInGuild('u17', guild, { message: link(guildId) });
    await runSlash(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });

  it('answers a missing message and an unknown channel the same way', async () => {
    stubFetch();
    const { guild } = guildWith(targetMessage());
    const missing = slashInGuild('u18', guild, {
      message: `https://discord.com/channels/${guildId}/${channelId}/500000000000000000`,
    });
    await runSlash(missing);
    const unknownChannel = slashInGuild('u19', guild, {
      message: `https://discord.com/channels/${guildId}/600000000000000000/${messageId}`,
    });
    await runSlash(unknownChannel);

    expect(missing.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
    expect(unknownChannel.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
  });

  it('the Bubble message context menu bubbles the target message', async () => {
    const fetchMock = stubFetch();
    const base = slash('u20');
    const interaction = Object.assign(base, {
      commandName: 'Bubble message',
      guildId: '2',
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      isMessageContextMenuCommand: () => true,
      isUserContextMenuCommand: () => false,
      targetMessage: { ...targetMessage(), guildId: '2' },
    });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(
      () =>
        expect(
          interaction.editReply.mock.calls.length + interaction.followUp.mock.calls.length,
        ).toBeGreaterThan(0),
      { timeout: 10000 },
    );

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(sentFile(interaction.editReply.mock.calls)).toBe('bubble.gif');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

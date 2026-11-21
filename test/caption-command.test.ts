import {
  Collection,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import {
  captionModalTextId,
  captionUsage,
  decodeCaptionModalId,
  messages,
} from '../src/features/imaging/index.js';
import { errorReply } from '../src/features/ui/index.js';
import { testEnv } from './support/env.js';
import { makeGif } from './support/images.js';
import { makeChatInput, makeMe, makeUser } from './support/interaction.js';

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
  const caption = commands.get('caption');
  if (!caption?.registerApplicationCommands) throw new Error('caption command not loaded');
  await caption.registerApplicationCommands(caption.applicationCommandRegistry);
  for (const name of caption.applicationCommandRegistry.contextMenuCommands) {
    commands.aliases.set(name, caption);
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
  const base = makeChatInput(client, { commandName: 'caption', userId, options });
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
    stickers: new Collection<string, unknown>(),
    embeds: [],
    mentions: {
      users: new Collection<string, unknown>([
        ['1', { id: '1', username: 'bob', globalName: null }],
      ]),
      members: null,
      roles: new Collection<string, unknown>(),
      channels: new Collection<string, unknown>(),
    },
    reference:
      replyTo || unfetchableReply
        ? { messageId: 'target', channelId: '3', guildId: '2', type: 0 }
        : null,
    fetchReference: vi.fn(async () => replyTo),
    channelId: '3',
    member: null,
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

/** For the cases answered by a direct reply, before any defer. */
const runSlashReply = async (interaction: ReturnType<typeof slash>) => {
  client.emit(Events.InteractionCreate, interaction as never);
  await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalled(), { timeout: 10000 });
};

describe('/caption', () => {
  it('defers publicly then edits in one caption.gif', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('m1', { text: 'do not run python', url: tenor });
    await runSlash(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [options] = interaction.editReply.mock.calls[0] as unknown as [
      { files: { name: string }[] },
    ];
    expect(options.files).toHaveLength(1);
    expect(options.files[0]?.name).toBe('caption.gif');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('replies ephemerally to an empty caption without deferring', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('m2', { text: '\u{200B}', url: tenor });
    await runSlashReply(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(errorReply(messages.emptyCaption));
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a caption over the limit without deferring', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('m3', { text: 'a'.repeat(201), url: tenor });
    await runSlashReply(interaction);

    expect(messages.captionTooLongChars).toBe('Keep the caption under 200 characters.');
    expect(interaction.reply).toHaveBeenCalledWith(errorReply(messages.captionTooLongChars));
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops the public deferred reply when something unexpected throws', async () => {
    stubFetch();
    const interaction = slash('m4', { text: 'hello', url: tenor });
    // Sapphire loads the command in its own module graph, so spying on the feature would not
    // reach it. Make gathering the inputs throw instead: anything that is not an ImagingError.
    interaction.options.getAttachment = () => {
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

  it('shows an ephemeral error when no image was given', async () => {
    stubFetch();
    const interaction = slash('m10', { text: 'hello' });
    await runSlash(interaction);

    expect(interaction.deleteReply).toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      errorReply('Give me an image: attach one, paste a link, or pick a user.'),
    );
  });
});

describe('?caption', () => {
  it('captions an attached image, resolving mentions', async () => {
    stubFetch();
    const message = prefixMessage('?caption <@1> when it works', 'm5', { attachment: true });
    await runPrefix(message);

    const [options] = message.reply.mock.calls[0] as unknown as [{ files: { name: string }[] }];
    expect(options.files).toHaveLength(1);
    expect(options.files[0]?.name).toBe('caption.gif');
    expect(message.channel.sendTyping).toHaveBeenCalled();
  });

  it('uses a leading link as the source', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption https://media.tenor.com/a.gif hello', 'm6');
    await runPrefix(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('media.tenor.com/a.gif');
    expect(message.reply.mock.calls[0]?.[0]).toHaveProperty('files');
  });

  it('replies with the usage when there is no text', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption', 'm7', { attachment: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(captionUsage('?'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a caption over the limit', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage(`?caption ${'a'.repeat(201)}`, 'm8', { attachment: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.captionTooLongChars);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for Attach Files when the bot lacks it', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption hi', 'm9', { attachment: true, canAttach: false });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.noAttachFiles);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const avatar = 'https://cdn.discordapp.com/avatars/40/abc.png';
const guildId = '200000000000000000';
const channelId = '300000000000000000';
const messageId = '400000000000000000';

/** A message in the channel of the prefix test messages. */
const inPrefixChannel = <T>(message: T) => ({ ...message, guildId: '2', channelId: '3' });

/** A message to caption: by default text only, from a member with a role colour. */
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
      cache: new Map(),
      fetch: vi.fn(async (id: string) => ({ id })),
      fetchMe: vi.fn(async () => makeMe()),
    },
  };
  return { guild, channel };
}

function slashInGuild(userId: string, guild: unknown, options: Record<string, unknown>) {
  const base = makeChatInput(client, { commandName: 'caption', userId, options, guildId, guild });
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

describe('captioning a message', () => {
  it('?caption as a reply to a text message captions a screenshot of it', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption hello', 'c1', {
      replyTo: inPrefixChannel(targetMessage()),
    });
    await runPrefix(message);

    expect(sentFile(message.reply.mock.calls)).toBe('caption.gif');
    // only the avatar is downloaded: the message has no image
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(avatar);
  });

  it('?caption as a reply to an image-only message captions the image itself', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption hello', 'c2', {
      replyTo: inPrefixChannel(targetMessage({ content: '', image: true })),
    });
    await runPrefix(message);

    expect(sentFile(message.reply.mock.calls)).toBe('caption.gif');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/attachments/');
  });

  it('?caption as a reply to a message that cannot be found says so, not the usage', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption hello', 'c3', { unfetchableReply: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.messageNotFound);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('?caption prefers an attached image over the replied message', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?caption hello', 'c4', {
      attachment: true,
      replyTo: inPrefixChannel(targetMessage()),
    });
    await runPrefix(message);

    expect(sentFile(message.reply.mock.calls)).toBe('caption.gif');
    expect(message.fetchReference).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/attachments/');
  });

  it('/caption message:<link> in the same guild captions it', async () => {
    const fetchMock = stubFetch();
    const target = targetMessage({ content: 'look', image: true });
    const { guild, channel } = guildWith(target);
    const interaction = slashInGuild('c5', guild, { text: 'hello', message: link(guildId) });
    await runSlash(interaction);

    expect(sentFile(interaction.editReply.mock.calls)).toBe('caption.gif');
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
    // the avatar and the image under the text
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('/caption message:<id> looks in the current channel', async () => {
    stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = slashInGuild('c6', guild, { text: 'hello', message: messageId });
    await runSlash(interaction);

    expect(sentFile(interaction.editReply.mock.calls)).toBe('caption.gif');
    expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
  });

  it('/caption prefers a link over the message option', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = slashInGuild('c12', guild, {
      text: 'hello',
      url: tenor,
      message: messageId,
    });
    await runSlash(interaction);

    expect(sentFile(interaction.editReply.mock.calls)).toBe('caption.gif');
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(tenor);
  });

  it('refuses a link to another guild without looking it up', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = slashInGuild('c7', guild, {
      text: 'hello',
      message: link('999999999999999999'),
    });
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
    const interaction = slashInGuild('c8', guild, { text: 'hello', message: link(guildId) });
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
    const interaction = slashInGuild('c9', guild, { text: 'hello', message: link(guildId) });
    await runSlash(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
    expect(channel.messages.fetch).not.toHaveBeenCalled();
  });
});

describe('the Caption message context menu', () => {
  it('asks for the caption in a modal that names the message, without deferring', async () => {
    const fetchMock = stubFetch();
    const base = slash('c10');
    const showModal = vi.fn(async (_modal: unknown) => undefined);
    const interaction = Object.assign(base, {
      commandName: 'Caption message',
      isChatInputCommand: () => false,
      isContextMenuCommand: () => true,
      isMessageContextMenuCommand: () => true,
      isUserContextMenuCommand: () => false,
      targetId: messageId,
      targetMessage: { ...targetMessage(), guildId: '2' },
      showModal,
    });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(showModal).toHaveBeenCalled(), { timeout: 10000 });

    const [modal] = showModal.mock.calls[0] as unknown as [
      { toJSON: () => { custom_id: string; components: unknown[] } },
    ];
    const json = modal.toJSON();
    expect(decodeCaptionModalId(json.custom_id)).toBe(messageId);
    expect(JSON.stringify(json.components)).toContain(`"custom_id":"${captionModalTextId}"`);
    expect(JSON.stringify(json.components)).toContain('"max_length":200');
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** A modal submit of the caption modal, in the channel of `guildWith`. */
function modalSubmit(userId: string, guild: unknown, customId: string, text: string) {
  const interaction = {
    isChatInputCommand: () => false,
    isContextMenuCommand: () => false,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isButton: () => false,
    isAnySelectMenu: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    isRepliable: () => true,
    customId,
    client,
    guild,
    guildId,
    channelId,
    user: makeUser(userId),
    replied: false,
    deferred: false,
    fields: {
      getTextInputValue: vi.fn((id: string) => {
        if (id !== captionModalTextId) throw new Error(`unknown field ${id}`);
        return text;
      }),
    },
    reply: vi.fn(async (_options: unknown) => undefined),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    deleteReply: vi.fn(async () => undefined),
    followUp: vi.fn(async (_options: unknown) => undefined),
    editReply: vi.fn(async (_options: unknown) => undefined),
  };
  return interaction;
}

const runModal = async (interaction: ReturnType<typeof modalSubmit>) => {
  client.emit(Events.InteractionCreate, interaction as never);
  await vi.waitFor(
    () =>
      expect(
        interaction.editReply.mock.calls.length +
          interaction.followUp.mock.calls.length +
          interaction.reply.mock.calls.length,
      ).toBeGreaterThan(0),
    { timeout: 10000 },
  );
};

describe('the caption modal', () => {
  it('captions the message named by the modal', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = modalSubmit('c20', guild, `cap:${messageId}`, 'when it works');
    await runModal(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(sentFile(interaction.editReply.mock.calls)).toBe('caption.gif');
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(channel.messages.fetch).toHaveBeenCalledWith(messageId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a custom ID it cannot decode', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = modalSubmit('c21', guild, 'cap:not-a-message', 'hello');
    client.emit(Events.InteractionCreate, interaction as never);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.fields.getTextInputValue).not.toHaveBeenCalled();
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a message in a channel the user cannot read', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage(), {
      userPermissions: PermissionFlagsBits.ViewChannel,
    });
    const interaction = modalSubmit('c22', guild, `cap:${messageId}`, 'hello');
    await runModal(interaction);

    expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.messageNotFound));
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a caption over the limit without deferring or fetching', async () => {
    const fetchMock = stubFetch();
    const { guild, channel } = guildWith(targetMessage());
    const interaction = modalSubmit('c23', guild, `cap:${messageId}`, 'a'.repeat(201));
    await runModal(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(errorReply(messages.captionTooLongChars));
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

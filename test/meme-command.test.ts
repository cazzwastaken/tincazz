import { Collection, Events, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { memeUsage, messages } from '../src/features/imaging/index.js';
import { errorReply } from '../src/features/ui/index.js';
import { testEnv } from './support/env.js';
import { makeGif } from './support/images.js';
import { makeChatInput } from './support/interaction.js';

// Sapphire keeps global state, so a second client in the same process loses its built-in
// preconditions. Share one client across the tests in this file.
let client: ReturnType<typeof createClient>;
let gif: Buffer;

const tenor = 'https://media.tenor.com/abc/cat.gif';

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
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
  const base = makeChatInput(client, { commandName: 'meme', userId, options });
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
  { attachment = false, canAttach = true }: { attachment?: boolean; canAttach?: boolean } = {},
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
    reference: null,
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

describe('/meme', () => {
  it('defers publicly then edits in one meme.gif', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('m1', { text: 'do not run python', url: tenor });
    await runSlash(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [options] = interaction.editReply.mock.calls[0] as unknown as [
      { files: { name: string }[] },
    ];
    expect(options.files).toHaveLength(1);
    expect(options.files[0]?.name).toBe('meme.gif');
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  it('replies ephemerally to an empty caption without deferring', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('m2', { text: '​', url: tenor });
    await runSlashReply(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(errorReply(messages.emptyCaption));
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a caption over the limit without deferring', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('m3', { text: 'a'.repeat(201), url: tenor });
    await runSlashReply(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(errorReply(messages.captionTooLong));
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

describe('?meme', () => {
  it('captions an attached image, resolving mentions', async () => {
    stubFetch();
    const message = prefixMessage('?meme <@1> when it works', 'm5', { attachment: true });
    await runPrefix(message);

    const [options] = message.reply.mock.calls[0] as unknown as [{ files: { name: string }[] }];
    expect(options.files).toHaveLength(1);
    expect(options.files[0]?.name).toBe('meme.gif');
    expect(message.channel.sendTyping).toHaveBeenCalled();
  });

  it('uses a leading link as the source', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?meme https://media.tenor.com/a.gif hello', 'm6');
    await runPrefix(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('media.tenor.com/a.gif');
    expect(message.reply.mock.calls[0]?.[0]).toHaveProperty('files');
  });

  it('replies with the usage when there is no text', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?meme', 'm7', { attachment: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(memeUsage('?'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a caption over the limit', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage(`?meme ${'a'.repeat(201)}`, 'm8', { attachment: true });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.captionTooLong);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for Attach Files when the bot lacks it', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?meme hi', 'm9', { attachment: true, canAttach: false });
    await runPrefix(message);

    expect(message.reply).toHaveBeenCalledWith(messages.noAttachFiles);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

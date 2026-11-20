import { Collection, Events, PermissionFlagsBits } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { bubbleUsage, messages } from '../src/features/imaging/index.js';
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
    expect(typeof text).toBe('string');
    expect((text as string).length).toBeGreaterThan(0);
    expect(second.reply.mock.calls[0]?.[0]).not.toHaveProperty('files');
  });
});

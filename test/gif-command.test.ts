import { type AttachmentBuilder, Collection, Events } from 'discord.js';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { gifUsage, messages } from '../src/features/imaging/index.js';
import { errorReply } from '../src/features/ui/index.js';
import { testEnv } from './support/env.js';
import { makeGif, makePng } from './support/images.js';
import { makeChatInput } from './support/interaction.js';

let client: ReturnType<typeof createClient>;
let png: Buffer;
const attachment = {
  url: 'https://cdn.discordapp.com/attachments/1/2/cat.png',
  contentType: 'image/png',
};

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
  png = await makePng({ width: 64, height: 48 });
});

beforeEach(() => {
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

function stubFetch(input = png) {
  const fetchMock = vi.fn(async (_url: URL) => new Response(new Uint8Array(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function slash(userId: string, options: { image?: typeof attachment; url?: string } = {}) {
  const base = makeChatInput(client, { commandName: 'gif', userId, options });
  return Object.assign(base, {
    options: { ...base.options, getAttachment: () => options.image ?? null },
    deferReply: vi.fn(async () => {
      base.deferred = true;
    }),
    deleteReply: vi.fn(async () => undefined),
    followUp: vi.fn(async (_options: unknown) => undefined),
  });
}

function prefixMessage(content: string, userId: string, source?: 'attachment' | 'reply') {
  return {
    id: 'm1',
    content,
    createdTimestamp: 1000,
    author: { bot: false, id: userId, toString: () => `<@${userId}>` },
    webhookId: null,
    system: false,
    attachments: new Collection(source === 'attachment' ? [['1', attachment]] : []),
    reference: source === 'reply' ? { messageId: 'target', channelId: '3', guildId: '2' } : null,
    fetchReference: vi.fn(async () => ({
      guildId: '2',
      content: '',
      attachments: new Collection([['1', { ...attachment, contentType: 'image/gif' }]]),
      embeds: [],
      stickers: new Collection(),
    })),
    channelId: '3',
    guildId: '2',
    guild: {
      id: '2',
      members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) },
    },
    channel: {
      id: '3',
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
      isSendable: () => true,
      permissionsFor: () => ({ has: () => true }),
    },
    client,
    reply: vi.fn(async (_options: unknown) => ({})),
  };
}

async function sentGif(options: unknown) {
  const { files } = options as { files: AttachmentBuilder[] };
  expect(files).toHaveLength(1);
  const [file] = files;
  expect(file?.name).toBe('image.gif');
  if (!Buffer.isBuffer(file?.attachment)) throw new Error('Expected GIF bytes');
  return sharp(file.attachment, { animated: true }).metadata();
}

describe('gif command', () => {
  it.each([
    ['attachment', { image: attachment }],
    ['URL', { url: attachment.url }],
  ] as const)('/gif preserves the small PNG dimensions from a %s', async (source, options) => {
    const fetchMock = stubFetch();
    const interaction = slash(source, options);
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(interaction.editReply).toHaveBeenCalled());
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(await sentGif(interaction.editReply.mock.calls[0]?.[0])).toMatchObject({
      format: 'gif',
      width: 64,
      height: 48,
      pages: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('/gif refuses URLs outside the image allowlist before fetching', async () => {
    const fetchMock = stubFetch();
    const interaction = slash('u2', { url: 'https://example.com/cat.png' });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() =>
      expect(interaction.followUp).toHaveBeenCalledWith(errorReply(messages.notAllowed)),
    );
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['?gif', 'attachment'],
    [`?gif <${attachment.url}>`, undefined],
  ] as const)('?gif accepts the source for %s', async (content, source) => {
    stubFetch();
    const message = prefixMessage(content, content, source);
    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(message.reply).toHaveBeenCalled());
    expect(await sentGif(message.reply.mock.calls[0]?.[0])).toHaveProperty('format', 'gif');
  });

  it('?gif can save a replied-to animation with its timing', async () => {
    const delay = [70, 120, 210];
    stubFetch(await makeGif({ width: 64, height: 48, frames: 3, delay, loop: 4 }));
    const message = prefixMessage('?gif', 'u3', 'reply');
    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(message.reply).toHaveBeenCalled());
    expect(await sentGif(message.reply.mock.calls[0]?.[0])).toMatchObject({
      format: 'gif',
      pages: 3,
      delay,
      loop: 4,
    });
  });

  it('?gif shows usage when no source is supplied', async () => {
    const fetchMock = stubFetch();
    const message = prefixMessage('?gif', 'u4');
    client.emit(Events.MessageCreate, message as never);
    await vi.waitFor(() => expect(message.reply).toHaveBeenCalledWith(gifUsage('?')));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

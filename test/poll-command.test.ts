import { container } from '@sapphire/framework';
import { Events, Routes } from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { polls } from '../src/db/schema.js';
import { optionEmojis } from '../src/features/poll/config.js';
import { pollUsage } from '../src/features/poll/index.js';
import { openPollsByHost } from '../src/features/poll/store.js';
import { testEnv } from './support/env.js';
import { makeChatInput } from './support/interaction.js';

const json = (value: unknown) => JSON.stringify(value);
let counter = 0;

describe('/poll and ?poll', () => {
  let client: ReturnType<typeof createClient>;
  let post: ReturnType<typeof vi.fn>;
  let put: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    client = createClient(testEnv);
    await client.stores.load();
  });

  beforeEach(() => {
    container.db = openDatabase(':memory:');
    counter = 0;
    post = vi.fn(async () => ({ id: `90${++counter}` }));
    put = vi.fn(async () => undefined);
    vi.spyOn(client.rest, 'post').mockImplementation(post as never);
    vi.spyOn(client.rest, 'put').mockImplementation(put as never);
    vi.spyOn(client.channels, 'fetch').mockResolvedValue({
      type: 0,
      isDMBased: () => false,
      isThread: () => false,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(container.db);
  });

  async function slash(options: Record<string, unknown>, id = '42') {
    const interaction = makeChatInput(client, { commandName: 'poll', userId: '1', options });
    Object.assign(interaction, { id });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(
      () =>
        expect(interaction.reply.mock.calls.length + interaction.editReply.mock.calls.length).toBe(
          1,
        ),
      { timeout: 2000 },
    );
    return interaction;
  }

  function makeMessage(content: string, id = '500') {
    return {
      id,
      content,
      createdTimestamp: 1000,
      author: { bot: false, id: '1', toString: () => '<@1>' },
      webhookId: null,
      system: false,
      guild: { id: '2', members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) } },
      guildId: '2',
      channelId: '3',
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

  async function prefix(content: string, id?: string, expectReply = true) {
    const message = makeMessage(content, id);
    client.emit(Events.MessageCreate, message as never);
    if (expectReply) {
      await vi.waitFor(() => expect(message.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    } else {
      await vi.waitFor(() => expect(post).toHaveBeenCalled(), { timeout: 2000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return message;
  }

  const rows = () => container.db.select().from(polls).all();

  it('/poll posts a yes/no poll, seeds thumbs and points the host to it', async () => {
    const interaction = await slash({ question: 'Pizza?' });
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(json(interaction.editReply.mock.calls[0])).toContain(
      'https://discord.com/channels/2/3/901',
    );
    const [route, init] = post.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(route).toBe(Routes.channelMessages('3'));
    expect(init.body.allowed_mentions).toEqual({ parse: [] });
    expect(json(init.body.components)).toContain('Pizza?');
    const reactions = put.mock.calls.map(([path]) => path);
    expect(reactions).toEqual(
      ['👍', '👎'].map((emoji) =>
        Routes.channelMessageOwnReaction('3', '901', encodeURIComponent(emoji)),
      ),
    );
    const [row] = rows();
    expect(row).toMatchObject({ status: 'open', hostId: '1', yesNo: true, creationId: '42' });
  });

  it('/poll with options, duration and anonymous stores them', async () => {
    await slash({
      question: 'Food?',
      options: 'Tacos | Pizza | Sushi',
      duration: '2h',
      anonymous: true,
    });
    const [row] = rows();
    expect(row?.options).toEqual(['Tacos', 'Pizza', 'Sushi']);
    expect(row?.anonymous).toBe(true);
    expect(row && row.endsAt - Date.now()).toBeGreaterThan(2 * 3_600_000 - 5000);
    expect(put).toHaveBeenCalledTimes(3);
    expect(put.mock.calls[0]?.[0]).toBe(
      Routes.channelMessageOwnReaction('3', '901', encodeURIComponent(optionEmojis[0])),
    );
  });

  it('/poll rejects bad input ephemerally and posts nothing', async () => {
    const interaction = await slash({ question: 'Q?', options: 'only one' });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(json(interaction.reply.mock.calls[0])).toContain('options');
    expect(post).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('/poll refuses at the cap with links and the earliest expiry', async () => {
    for (let i = 0; i < 3; i++) await slash({ question: `Q${i}?` }, `id-${i}`);
    expect(openPollsByHost(container.db, '2', '1')).toHaveLength(3);
    const interaction = await slash({ question: 'One more?' }, 'id-4');
    const text = json(interaction.editReply.mock.calls[0]);
    expect(text).toContain('3 open polls');
    expect(text).toContain('Close poll');
    expect(text).toContain('https://discord.com/channels/2/3/901');
    expect(rows()).toHaveLength(3);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('/poll gives the slot back when posting fails', async () => {
    post.mockRejectedValueOnce(new Error('Missing Access'));
    const interaction = await slash({ question: 'Q?' });
    expect(json(interaction.editReply.mock.calls[0])).toContain('could not post the poll');
    expect(rows().map((row) => row.status)).toEqual(['deleted']);
    expect(openPollsByHost(container.db, '2', '1')).toHaveLength(0);
  });

  it('/poll gives the slot back when seeding a reaction fails', async () => {
    put.mockRejectedValueOnce(new Error('Missing Permissions'));
    const interaction = await slash({ question: 'Q?' });
    expect(json(interaction.editReply.mock.calls[0])).toContain('could not post the poll');
    expect(rows().map((row) => row.status)).toEqual(['deleted']);
  });

  it('a repeated interaction does not create a second poll', async () => {
    await slash({ question: 'Q?' }, 'same');
    await slash({ question: 'Q?' }, 'same').catch(() => undefined);
    expect(rows().length).toBe(1);
  });

  it('?poll posts a yes/no poll without replying', async () => {
    await prefix('?poll Is this fine?', '500', false);
    const [row] = rows();
    expect(row).toMatchObject({ question: 'Is this fine?', yesNo: true, creationId: '500' });
    expect(row?.status).toBe('open');
  });

  it('?poll with quotes, options and flags', async () => {
    await prefix('?poll "Dinner @everyone?" | Tacos | Pizza --anon --for 3h', '501', false);
    const [row] = rows();
    expect(row?.options).toEqual(['Tacos', 'Pizza']);
    expect(row?.anonymous).toBe(true);
    expect(row?.question).not.toContain('@everyone');
  });

  it('?poll with no question shows the usage', async () => {
    const message = await prefix('?poll');
    expect(message.reply).toHaveBeenCalledWith(pollUsage);
    expect(post).not.toHaveBeenCalled();
  });

  it('?poll with a parse error shows the error and the usage', async () => {
    const message = await prefix('?poll "Q?" | one --for 5x');
    const text = message.reply.mock.calls[0]?.[0] as string;
    expect(text).toContain(pollUsage);
    expect(rows()).toHaveLength(0);
  });

  it('?poll refuses at the cap', async () => {
    for (let i = 0; i < 3; i++) await prefix(`?poll Q${i}?`, `60${i}`, false);
    const message = await prefix('?poll Another?', '609');
    expect(message.reply.mock.calls[0]?.[0] as string).toContain('3 open polls');
    expect(rows()).toHaveLength(3);
  });

  it('?poll reports a post failure and frees the slot', async () => {
    post.mockRejectedValueOnce(new Error('Missing Access'));
    const message = await prefix('?poll Q?');
    expect(message.reply.mock.calls[0]?.[0] as string).toContain('could not post the poll');
    expect(rows().map((row) => row.status)).toEqual(['deleted']);
  });
});

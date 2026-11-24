import {
  ContainerBuilder,
  DiscordAPIError,
  MessageFlags,
  RESTJSONErrorCodes,
  TextDisplayBuilder,
} from 'discord.js';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyHallError,
  collectLinks,
  createHallDiscord,
  HallDiscordError,
} from '../src/features/halloffame/index.js';

const apiError = (status: number, code: number) =>
  new DiscordAPIError({ message: 'x', code }, code, status, 'GET', '/x', {});

function fakeClient() {
  const rest = {
    get: vi.fn(),
    post: vi.fn(async () => ({ id: '777' })),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    cdn: {
      avatar: (id: string, hash: string) => `https://cdn.discordapp.com/avatars/${id}/${hash}.png`,
      defaultAvatar: (index: number) => `https://cdn.discordapp.com/embed/avatars/${index}.png`,
    },
  };
  const guild = { emojis: { cache: new Map([['55', {}]]) } };
  const client = {
    user: { id: '900' },
    rest,
    guilds: { cache: new Map([['10', guild]]) },
    channels: {
      cache: new Map([['20', { isDMBased: () => false, guild, isThread: () => false }]]),
    },
  };
  return { client: client as never, rest };
}

const card = () =>
  new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('hi'));

describe('hall of fame discord adapter', () => {
  it('classifies discord errors', () => {
    expect(classifyHallError(apiError(404, RESTJSONErrorCodes.UnknownMessage))).toBe(
      'unknown-message',
    );
    expect(classifyHallError(apiError(404, RESTJSONErrorCodes.UnknownChannel))).toBe(
      'unknown-channel',
    );
    expect(classifyHallError(apiError(403, RESTJSONErrorCodes.MissingPermissions))).toBe(
      'forbidden',
    );
    // Other 404s are not proof that a message or channel is gone.
    expect(classifyHallError(apiError(404, RESTJSONErrorCodes.UnknownUser))).toBe('other');
    expect(classifyHallError(apiError(404, 0))).toBe('other');
    expect(classifyHallError(apiError(500, 0))).toBe('other');
    expect(classifyHallError(new Error('network'))).toBe('other');
  });

  it('maps a message with reactions, a reply and a forward', async () => {
    const { client, rest } = fakeClient();
    rest.get.mockResolvedValue({
      id: '100',
      channel_id: '20',
      timestamp: '2026-11-24T00:00:00.000Z',
      type: 19,
      content: 'hello',
      author: { id: '1', username: 'cazz', global_name: 'Cazz', avatar: 'abc', bot: false },
      attachments: [
        {
          id: '9',
          filename: 'a.png',
          url: 'https://cdn.discordapp.com/a.png',
          size: 5,
          content_type: 'image/png',
        },
      ],
      embeds: [],
      sticker_items: [{ id: '8', name: 'wave', format_type: 1 }],
      referenced_message: {
        author: { id: '2', username: 'other', global_name: null },
        content: 'question?',
        attachments: [],
        embeds: [],
      },
      message_snapshots: [{ message: { content: 'fwd', attachments: [], embeds: [] } }],
      poll: { question: { text: 'Tea?' } },
      reactions: [
        { count: 3, count_details: { normal: 2, burst: 1 }, emoji: { id: null, name: '⭐' } },
        {
          count: 1,
          count_details: { normal: 1, burst: 0 },
          emoji: { id: '55', name: 'cat', animated: true },
        },
        { count: 4, count_details: { normal: 4, burst: 0 }, emoji: { id: '66', name: 'foreign' } },
      ],
    });
    const message = await createHallDiscord(client).fetchMessage('10', '20', '100');
    expect(message.author).toMatchObject({
      id: '1',
      displayName: 'Cazz',
      bot: false,
      webhook: false,
      avatarUrl: 'https://cdn.discordapp.com/avatars/1/abc.png',
    });
    expect(message.reply).toEqual({ authorName: 'other', content: 'question?', hasMedia: false });
    expect(message.facts.snapshots[0]?.content).toBe('fwd');
    expect(message.facts.pollQuestion).toBe('Tea?');
    expect(message.facts.stickers).toEqual([{ id: '8', name: 'wave', format: 1 }]);
    expect(message.reactions).toEqual([
      { emoji: '⭐', key: '⭐', normal: 2 },
      { emoji: '<a:cat:55>', key: 'cat:55', normal: 1 },
      // A guild without the emoji shows it as plain text the card will not print.
      { emoji: 'foreign:66', key: 'foreign:66', normal: 4 },
    ]);
  });

  it('turns discord errors into tagged ones', async () => {
    const { client, rest } = fakeClient();
    rest.get.mockRejectedValue(apiError(404, RESTJSONErrorCodes.UnknownMessage));
    const error = await createHallDiscord(client)
      .fetchMessage('10', '20', '1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HallDiscordError);
    expect((error as HallDiscordError).kind).toBe('unknown-message');
  });

  it('fetches normal reactors only, for one emoji', async () => {
    const { client, rest } = fakeClient();
    rest.get.mockResolvedValue([{ id: '1', bot: true }, { id: '2' }]);
    const users = await createHallDiscord(client).fetchReactors('20', '100', 'cat:55', 100);
    expect(users).toEqual([
      { id: '1', bot: true },
      { id: '2', bot: false },
    ]);
    const [route, options] = rest.get.mock.calls[0] as unknown as [
      string,
      { query: URLSearchParams },
    ];
    expect(route).toContain('/reactions/cat%3A55');
    expect(options.query.get('type')).toBe('0');
    expect(options.query.get('limit')).toBe('100');
  });

  it('sends with a nonce and lists exactly the uploaded files, in a sends and in edits', async () => {
    const { client, rest } = fakeClient();
    const discord = createHallDiscord(client);
    const files = [{ name: 'hall-0.png', data: Buffer.from('x') }];
    expect(await discord.sendHall('30', { card: card(), files, nonce: '100' })).toBe('777');
    const sent = rest.post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; files: unknown[] },
    ];
    expect(sent[1].body).toMatchObject({
      nonce: '100',
      enforce_nonce: true,
      flags: MessageFlags.IsComponentsV2,
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: 'hall-0.png' }],
    });
    expect(sent[1].files).toEqual([{ name: 'hall-0.png', data: files[0]?.data }]);

    await discord.editHall('30', '777', { card: card(), files: [] });
    const edited = rest.patch.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(edited[1].body.attachments).toEqual([]);
  });

  it('downloads only allowlisted image hosts', async () => {
    const { client } = fakeClient();
    await expect(
      createHallDiscord(client).download('https://evil.example/a.png'),
    ).rejects.toThrow();
    await expect(
      createHallDiscord(client).download('http://cdn.discordapp.com/a.png'),
    ).rejects.toThrow();
  });

  it('collects every link of a component tree', () => {
    const tree = [
      {
        type: 17,
        components: [
          {
            type: 1,
            components: [
              { type: 2, url: 'https://a/1' },
              { type: 2, url: 'https://a/2' },
            ],
          },
        ],
      },
    ];
    expect(collectLinks(tree)).toEqual(['https://a/1', 'https://a/2']);
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => collectLinks(value)).not.toThrow();
      }),
    );
    fc.assert(
      fc.property(fc.array(fc.webUrl(), { maxLength: 6 }), (urls) => {
        const nested = urls.reduce<unknown>((inner, url) => ({ components: [inner, { url }] }), {});
        expect(collectLinks(nested).sort()).toEqual([...urls].sort());
      }),
    );
  });
});

import { AttachmentBuilder, Collection, PermissionFlagsBits, StickerFormatType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  attachmentData,
  avatarUrl,
  canAttachFiles,
  commandPrefix,
  type Fetcher,
  ImageJobs,
  interactionMentionNames,
  messageInputs,
  messageMentionNames,
  messages,
  pickSource,
  produceImage,
  replyData,
  replyWithImage,
  slashUsage,
} from '../src/features/imaging/index.js';
import { errorReply } from '../src/features/ui/index.js';
import { makePng } from './support/images.js';

type Stub = Record<string, unknown>;
const cast = <T>(value: Stub) => value as unknown as T;
type Msg = Parameters<typeof replyData>[0];

const col = <V>(entries: [string, V][]) => new Map(entries);

function replyMessage(): Msg {
  return cast<Msg>({
    attachments: col([]),
    embeds: [
      {
        url: 'https://tenor.com/view/x-1',
        provider: { name: 'Tenor' },
        image: null,
        thumbnail: { url: 'https://media.tenor.com/t.png' },
        video: { url: 'https://media.tenor.com/v.mp4' },
      },
    ],
    stickers: col([
      [
        '1',
        { url: 'https://cdn.discordapp.com/stickers/1.json', format: StickerFormatType.Lottie },
      ],
    ]),
    content: 'hi',
  });
}

describe('replyData', () => {
  it('maps embeds, stickers and content', () => {
    const data = replyData(replyMessage());
    expect(data.embeds).toEqual([
      {
        url: 'https://tenor.com/view/x-1',
        provider: 'Tenor',
        imageUrl: null,
        imageProxyUrl: null,
        thumbnailUrl: 'https://media.tenor.com/t.png',
        thumbnailProxyUrl: null,
        hasVideo: true,
      },
    ]);
    expect(data.stickers).toEqual([
      { url: 'https://cdn.discordapp.com/stickers/1.json', format: 'lottie' },
    ]);
    expect(data.content).toBe('hi');
  });

  it('keeps the discord proxy urls of an embed image and thumbnail', () => {
    const proxy = 'https://images-ext-1.discordapp.net/external/abc/https/i.imgur.com/a.gif';
    const data = replyData(
      cast<Msg>({
        attachments: col([]),
        embeds: [
          {
            url: 'https://imgur.com/a',
            provider: { name: 'Imgur' },
            image: { url: 'https://i.imgur.com/a.gif', proxyURL: proxy },
            thumbnail: { url: 'https://i.imgur.com/t.gif', proxyURL: `${proxy}?t` },
            video: null,
          },
        ],
        stickers: col([]),
        content: '',
      }),
    );
    expect(data.embeds[0]).toMatchObject({
      imageUrl: 'https://i.imgur.com/a.gif',
      imageProxyUrl: proxy,
      thumbnailUrl: 'https://i.imgur.com/t.gif',
      thumbnailProxyUrl: `${proxy}?t`,
    });
    expect(pickSource({ reply: data })).toMatchObject({ ok: true, check: { url: new URL(proxy) } });
  });
});

describe('avatarUrl', () => {
  const user = { displayAvatarURL: vi.fn(() => 'user-avatar') };
  it('prefers the guild member avatar', () => {
    const member = { displayAvatarURL: vi.fn(() => 'guild-avatar') };
    expect(avatarUrl(cast(user), cast(member))).toBe('guild-avatar');
    expect(member.displayAvatarURL).toHaveBeenCalledWith({
      size: 512,
      extension: 'png',
      forceStatic: false,
    });
  });
  it('falls back to the user for no member or a raw member', () => {
    expect(avatarUrl(cast(user), null)).toBe('user-avatar');
    expect(avatarUrl(cast(user), cast({ roles: [] }))).toBe('user-avatar');
  });
});

describe('messageInputs', () => {
  const base = (extra: Stub) =>
    cast<Msg>({
      attachments: new Collection(),
      guild: null,
      client: { users: { fetch: vi.fn(async () => null) } },
      ...extra,
    });

  it('fetches the referenced message only when there is a reference', async () => {
    const fetchReference = vi.fn(async () => replyMessage());
    const withRef = await messageInputs(
      base({ reference: { messageId: '9' }, fetchReference }),
      {},
    );
    expect(fetchReference).toHaveBeenCalledOnce();
    expect(withRef.reply?.content).toBe('hi');

    const none = vi.fn();
    const without = await messageInputs(base({ reference: null, fetchReference: none }), {});
    expect(none).not.toHaveBeenCalled();
    expect(without.reply).toBeUndefined();
  });

  it('drops the reply when the reference cannot be fetched', async () => {
    const fetchReference = vi.fn(async () => {
      throw new Error('gone');
    });
    const inputs = await messageInputs(base({ reference: { messageId: '9' }, fetchReference }), {});
    expect(inputs.reply).toBeUndefined();
  });

  it('resolves a user id through the guild, then the client, else no avatar', async () => {
    const member = { user: {}, displayAvatarURL: () => 'guild-avatar' };
    const viaGuild = await messageInputs(
      base({ guild: { members: { fetch: async () => member } } }),
      { userId: '1' },
    );
    expect(viaGuild.avatarUrl).toBe('guild-avatar');

    const viaClient = await messageInputs(
      base({
        guild: {
          members: {
            fetch: async () => {
              throw new Error('unknown member');
            },
          },
        },
        client: { users: { fetch: async () => ({ displayAvatarURL: () => 'user-avatar' }) } },
      }),
      { userId: '1' },
    );
    expect(viaClient.avatarUrl).toBe('user-avatar');

    const missing = await messageInputs(base({}), { userId: '1' });
    expect(missing.avatarUrl).toBeUndefined();
  });
  it('uses the first image attachment, not a file before it', async () => {
    const text = {
      url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt',
      contentType: 'text/plain',
      spoiler: false,
    };
    const image = {
      url: 'https://cdn.discordapp.com/attachments/1/2/cat.png',
      contentType: 'image/png',
      spoiler: false,
    };
    const unknown = {
      url: 'https://cdn.discordapp.com/attachments/1/2/x',
      contentType: null,
      spoiler: false,
    };
    const inputs = (entries: [string, object][]) =>
      messageInputs(base({ attachments: new Collection(entries) }), {});
    expect(
      (
        await inputs([
          ['1', text],
          ['2', image],
        ])
      ).attachment,
    ).toEqual(image);
    expect(
      (
        await inputs([
          ['1', text],
          ['2', unknown],
          ['3', image],
        ])
      ).attachment,
    ).toEqual(unknown);
    // with no image, the first attachment still gives its own error (video, not an image)
    expect((await inputs([['1', text]])).attachment).toEqual(text);
  });
});

describe('attachmentData', () => {
  it('carries the spoiler flag', () => {
    const url = 'https://cdn.discordapp.com/attachments/1/2/SPOILER_a.png';
    expect(attachmentData({ url, contentType: 'image/png', spoiler: true }).spoiler).toBe(true);
    expect(attachmentData({ url, contentType: 'image/png' }).spoiler).toBe(false);
  });
});

describe('mention names', () => {
  const viewer = (visible: string[]) =>
    cast<Parameters<typeof messageMentionNames>[1]>({ id: 'v', visible });
  /** A channel in guild `g`; the stub `permissionsFor` reads `visible` off the viewer. */
  const channel = (id: string, name: string, guildId = 'g') => ({
    id,
    name,
    guildId,
    permissionsFor: (member: { visible: string[] }) => ({
      has: (bit: bigint) => bit === PermissionFlagsBits.ViewChannel && member.visible.includes(id),
    }),
  });
  const mentioning = (channels: ReturnType<typeof channel>[]) =>
    cast<Parameters<typeof messageMentionNames>[0]>({
      guildId: 'g',
      mentions: {
        users: col([['1', { id: '1', globalName: 'Global', username: 'user' }]]),
        members: col([['1', { id: '1', displayName: 'Nick' }]]),
        roles: col([['2', { id: '2', name: 'Mods' }]]),
        channels: col(channels.map((c) => [c.id, c])),
      },
    });

  it('prefers member display names for a message', () => {
    const names = messageMentionNames(mentioning([channel('3', 'general')]), viewer(['3']));
    expect(names.users.get('1')).toBe('Nick');
    expect(names.roles.get('2')).toBe('Mods');
    expect(names.channels.get('3')).toBe('general');
  });

  it('only names channels the invoker can see', () => {
    const message = mentioning([channel('3', 'general'), channel('4', 'staff-only')]);
    expect([...messageMentionNames(message, viewer(['3'])).channels]).toEqual([['3', 'general']]);
    expect(messageMentionNames(message, viewer([])).channels.size).toBe(0);
    expect(messageMentionNames(message, null).channels.size).toBe(0);
  });

  it('never names a channel of another guild', () => {
    const message = mentioning([channel('3', 'elsewhere', 'other')]);
    expect(messageMentionNames(message, viewer(['3'])).channels.size).toBe(0);
  });

  it('looks up only the ids in the slash text', () => {
    const interaction = cast<Parameters<typeof interactionMentionNames>[0]>({
      guildId: 'g',
      user: { id: 'v' },
      guild: {
        members: {
          cache: col([
            ['1', { displayName: 'Nick' }],
            ['v', { id: 'v', visible: ['3'] }],
          ]),
        },
        roles: { cache: col([['2', { name: 'Mods' }]]) },
        channels: {
          cache: col([
            ['3', channel('3', 'general')],
            ['6', channel('6', 'staff-only')],
          ]),
        },
      },
      client: { users: { cache: col([['4', { globalName: null, username: 'plain' }]]) } },
    });
    const names = interactionMentionNames(interaction, '<@1> <@!4> <@&2> <#3> <#6> <@5>');
    expect([...names.users]).toEqual([
      ['1', 'Nick'],
      ['4', 'plain'],
    ]);
    expect(names.roles.get('2')).toBe('Mods');
    expect([...names.channels]).toEqual([['3', 'general']]);
  });
});

describe('produceImage', () => {
  const op = { kind: 'bubble', style: 'white', tail: 'left' } as const;
  const url = 'https://cdn.discordapp.com/attachments/1/2/a.png';

  it('downloads, renders and names the attachment', async () => {
    const png = await makePng({ width: 40, height: 30 });
    const fetcher = vi.fn<Fetcher>(async () => new Response(Buffer.from(png)));
    const result = await produceImage({ url }, op, 'u1', { fetch: fetcher, jobs: new ImageJobs() });
    expect('file' in result && result.file.name).toBe('bubble.gif');
    expect(fetcher).toHaveBeenCalled();
  });

  it('names a caption caption.gif', async () => {
    const png = await makePng({ width: 40, height: 30 });
    const fetcher = vi.fn<Fetcher>(async () => new Response(Buffer.from(png)));
    const result = await produceImage({ url }, { kind: 'caption', text: 'hi' }, 'u1', {
      fetch: fetcher,
      jobs: new ImageJobs(),
    });
    expect('file' in result && result.file.name).toBe('caption.gif');
  });

  it('returns the message for a disallowed url without fetching', async () => {
    const fetcher = vi.fn<Fetcher>();
    const result = await produceImage({ url: 'https://evil.example/a.png' }, op, 'u1', {
      fetch: fetcher,
    });
    expect(result).toEqual({ error: messages.notAllowed });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a null error when nothing was given', async () => {
    expect(await produceImage({}, op, 'u1')).toEqual({ error: null });
  });

  it('returns queue ImagingErrors as messages', async () => {
    const jobs = new ImageJobs({ timeoutMs: 50 });
    const fetcher = vi.fn<Fetcher>(() => new Promise<Response>(() => {}));
    produceImage({ url }, op, 'u1', { fetch: fetcher, jobs }).catch(() => {});
    expect(await produceImage({ url }, op, 'u1', { fetch: fetcher, jobs })).toEqual({
      error: messages.busyUser,
    });
  });

  it('rethrows unexpected errors', async () => {
    const jobs = { run: () => Promise.reject(new TypeError('boom')) } as unknown as ImageJobs;
    await expect(produceImage({ url }, op, 'u1', { jobs })).rejects.toThrow(TypeError);
  });
});

describe('replyWithImage', () => {
  type Interaction = Parameters<typeof replyWithImage>[0];
  const stub = () => {
    const calls = {
      deleteReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    };
    return { calls, interaction: cast<Interaction>(calls) };
  };

  it('edits the deferred reply with the file', async () => {
    const { calls, interaction } = stub();
    const file = new AttachmentBuilder(Buffer.from('x'), { name: 'a.gif' });
    await replyWithImage(interaction, async () => ({ file }));
    expect(calls.editReply).toHaveBeenCalledWith({ files: [file] });
    expect(calls.deleteReply).not.toHaveBeenCalled();
    expect(calls.followUp).not.toHaveBeenCalled();
  });

  it('drops the deferred reply and follows up ephemerally with the error', async () => {
    const { calls, interaction } = stub();
    await replyWithImage(interaction, async () => ({ error: 'nope' }));
    expect(calls.deleteReply).toHaveBeenCalled();
    expect(calls.followUp).toHaveBeenCalledWith(errorReply('nope'));
    expect(calls.editReply).not.toHaveBeenCalled();
  });

  it('falls back to the shared usage when there is no message', async () => {
    const { calls, interaction } = stub();
    await replyWithImage(interaction, async () => ({ error: null }));
    expect(calls.followUp).toHaveBeenCalledWith(errorReply(slashUsage));
  });

  it('survives a failing deleteReply', async () => {
    const { calls, interaction } = stub();
    calls.deleteReply.mockRejectedValue(new Error('gone'));
    await replyWithImage(interaction, async () => ({ error: 'nope' }));
    expect(calls.followUp).toHaveBeenCalled();
  });

  it('deletes the deferred reply and rethrows an unexpected error', async () => {
    const { calls, interaction } = stub();
    await expect(
      replyWithImage(interaction, async () => {
        throw new TypeError('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls.deleteReply).toHaveBeenCalled();
    expect(calls.followUp).not.toHaveBeenCalled();
    expect(calls.editReply).not.toHaveBeenCalled();
  });
});

describe('canAttachFiles', () => {
  type M = Parameters<typeof canAttachFiles>[0];
  const message = (over: { me?: unknown; sendable?: boolean; can?: boolean; guild?: boolean }) =>
    cast<M>({
      guild:
        over.guild === false
          ? null
          : { members: { me: over.me ?? null, fetchMe: async () => ({ id: 'fetched' }) } },
      channel: {
        isSendable: () => over.sendable ?? true,
        permissionsFor: () => ({
          has: (bit: bigint) => bit === PermissionFlagsBits.AttachFiles && (over.can ?? true),
        }),
      },
    });

  it('is true with the permission, fetching the member when uncached', async () => {
    expect(await canAttachFiles(message({ me: { id: '9' } }))).toBe(true);
    expect(await canAttachFiles(message({}))).toBe(true);
  });

  it('is false without the permission, a guild or a sendable channel', async () => {
    expect(await canAttachFiles(message({ me: { id: '9' }, can: false }))).toBe(false);
    expect(await canAttachFiles(message({ me: { id: '9' }, sendable: false }))).toBe(false);
    expect(await canAttachFiles(message({ guild: false }))).toBe(false);
  });
});

describe('commandPrefix', () => {
  type C = Parameters<typeof commandPrefix>[0];
  const client = (defaultPrefix: unknown) => cast<C>({ options: { defaultPrefix } });

  it('uses a string, the first of an array, or falls back to ?', () => {
    expect(commandPrefix(client('!'))).toBe('!');
    expect(commandPrefix(client(['$', '!']))).toBe('$');
    expect(commandPrefix(client(undefined))).toBe('?');
  });
});

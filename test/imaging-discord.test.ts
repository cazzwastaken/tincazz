import { StickerFormatType } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  avatarUrl,
  type Fetcher,
  ImageJobs,
  interactionMentionNames,
  messageInputs,
  messageMentionNames,
  messages,
  produceImage,
  replyData,
} from '../src/features/imaging/index.js';
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
        thumbnailUrl: 'https://media.tenor.com/t.png',
        hasVideo: true,
      },
    ]);
    expect(data.stickers).toEqual([
      { url: 'https://cdn.discordapp.com/stickers/1.json', format: 'lottie' },
    ]);
    expect(data.content).toBe('hi');
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
      attachments: { first: () => undefined },
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
});

describe('mention names', () => {
  it('prefers member display names for a message', () => {
    const names = messageMentionNames(
      cast({
        mentions: {
          users: col([['1', { id: '1', globalName: 'Global', username: 'user' }]]),
          members: col([['1', { id: '1', displayName: 'Nick' }]]),
          roles: col([['2', { id: '2', name: 'Mods' }]]),
          channels: col([['3', { id: '3', name: 'general' }]]),
        },
      }),
    );
    expect(names.users.get('1')).toBe('Nick');
    expect(names.roles.get('2')).toBe('Mods');
    expect(names.channels.get('3')).toBe('general');
  });

  it('looks up only the ids in the slash text', () => {
    const interaction = cast<Parameters<typeof interactionMentionNames>[0]>({
      guild: {
        members: { cache: col([['1', { displayName: 'Nick' }]]) },
        roles: { cache: col([['2', { name: 'Mods' }]]) },
        channels: { cache: col([['3', { name: 'general' }]]) },
      },
      client: { users: { cache: col([['4', { globalName: null, username: 'plain' }]]) } },
    });
    const names = interactionMentionNames(interaction, '<@1> <@!4> <@&2> <#3> <@5>');
    expect([...names.users]).toEqual([
      ['1', 'Nick'],
      ['4', 'plain'],
    ]);
    expect(names.roles.get('2')).toBe('Mods');
    expect(names.channels.get('3')).toBe('general');
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

  it('names a meme meme.gif', async () => {
    const png = await makePng({ width: 40, height: 30 });
    const fetcher = vi.fn<Fetcher>(async () => new Response(Buffer.from(png)));
    const result = await produceImage({ url }, { kind: 'meme', text: 'hi' }, 'u1', {
      fetch: fetcher,
      jobs: new ImageJobs(),
    });
    expect('file' in result && result.file.name).toBe('meme.gif');
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

import { ChannelType, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import {
  canReadHistory,
  type Fetcher,
  ImageJobs,
  messageSnapshot,
  messages,
  noMentionNames,
  produceMessageImage,
  repliedMessage,
  sniffImage,
} from '../src/features/imaging/index.js';
import { makePng } from './support/images.js';

type Msg = Parameters<typeof messageSnapshot>[0];
type Channel = Parameters<typeof canReadHistory>[0];
type Member = Parameters<typeof canReadHistory>[1];

const avatar = 'https://cdn.discordapp.com/avatars/1/a.png';

function message(over: Record<string, unknown> = {}): Msg {
  return {
    content: 'hi <@5>',
    createdTimestamp: 1000,
    author: { id: '1', displayName: 'user', displayAvatarURL: () => avatar },
    member: null,
    webhookId: null,
    guildId: 'g',
    channelId: 'c',
    guild: { members: { fetch: vi.fn(async () => null) } },
    attachments: new Collection(),
    embeds: [],
    stickers: new Collection(),
    mentions: {
      users: new Collection([['5', { id: '5', globalName: 'Five', username: 'five' }]]),
      members: null,
      roles: new Collection(),
      channels: new Collection(),
    },
    ...over,
  } as unknown as Msg;
}

describe('messageSnapshot', () => {
  it('uses the member display name, colour and avatar', async () => {
    const options = vi.fn(() => avatar);
    const snapshot = await messageSnapshot(
      message({
        member: { displayName: 'Member', displayHexColor: '#e91e63', displayAvatarURL: options },
      }),
      null,
    );
    expect(snapshot.author).toEqual({ name: 'Member', color: '#e91e63', avatarUrl: avatar });
    expect(options).toHaveBeenCalledWith({ size: 128, extension: 'png', forceStatic: true });
    expect(snapshot.names.users.get('5')).toBe('Five');
    expect(snapshot.message.content).toBe('hi <@5>');
    expect(snapshot.createdTimestamp).toBe(1000);
  });

  it('falls back to the user when the member is gone', async () => {
    const snapshot = await messageSnapshot(message(), null);
    expect(snapshot.author).toEqual({ name: 'user', color: null, avatarUrl: avatar });
  });

  it('does not look a webhook author up as a member', async () => {
    const fetch = vi.fn(async () => null);
    await messageSnapshot(message({ webhookId: 'w', guild: { members: { fetch } } }), null);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('repliedMessage', () => {
  const target = { id: 't', guildId: 'g' };
  const prefix = (reference: unknown) =>
    ({
      guildId: 'g',
      channelId: 'c',
      reference,
      fetchReference: vi.fn(async () => target),
    }) as unknown as Msg & { fetchReference: ReturnType<typeof vi.fn> };

  it('fetches a plain reply in the same channel', async () => {
    const m = prefix({ messageId: 't', channelId: 'c', guildId: 'g', type: 0 });
    expect(await repliedMessage(m)).toBe(target);
  });

  it.each([
    ['no reference', null],
    ['a forward', { messageId: 't', channelId: 'c', guildId: 'g', type: 1 }],
    ['another channel', { messageId: 't', channelId: 'x', guildId: 'g', type: 0 }],
    ['another guild', { messageId: 't', channelId: 'c', guildId: 'x', type: 0 }],
  ])('ignores %s', async (_name, reference) => {
    const m = prefix(reference);
    expect(await repliedMessage(m)).toBeNull();
    expect(m.fetchReference).not.toHaveBeenCalled();
  });
});

describe('canReadHistory', () => {
  const read = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory;
  const member = { id: 'u' } as unknown as Member;
  const channel = (permissions: bigint, type = ChannelType.GuildText, inThread = false) =>
    ({
      type,
      permissionsFor: () => new PermissionsBitField(permissions),
      members: {
        fetch: vi.fn(async () => {
          if (!inThread) throw new Error('Unknown Member');
          return { id: 'u' };
        }),
      },
    }) as unknown as Channel;

  it('needs View Channel and Read Message History', async () => {
    expect(await canReadHistory(channel(read), member)).toBe(true);
    expect(await canReadHistory(channel(PermissionFlagsBits.ViewChannel), member)).toBe(false);
    expect(await canReadHistory(channel(PermissionFlagsBits.ReadMessageHistory), member)).toBe(
      false,
    );
  });

  it('needs membership of a private thread, unless they manage threads', async () => {
    const t = ChannelType.PrivateThread;
    expect(await canReadHistory(channel(read, t, false), member)).toBe(false);
    expect(await canReadHistory(channel(read, t, true), member)).toBe(true);
    expect(
      await canReadHistory(channel(read | PermissionFlagsBits.ManageThreads, t, false), member),
    ).toBe(true);
  });

  it('reads a public thread with the parent permissions', async () => {
    expect(await canReadHistory(channel(read, ChannelType.PublicThread), member)).toBe(true);
  });
});

describe('produceMessageImage', () => {
  const snapshot = (content: string) => ({
    author: { name: 'cazz', color: null, avatarUrl: avatar },
    createdTimestamp: 0,
    message: { attachments: [], embeds: [], stickers: [], content },
    names: noMentionNames,
  });

  it('renders a text message inside one job', async () => {
    const png = await makePng({ width: 128, height: 128 });
    const fetch = vi.fn(async () => new Response(new Uint8Array(png))) as unknown as Fetcher;
    const jobs = new ImageJobs();
    const run = vi.spyOn(jobs, 'run');
    const result = await produceMessageImage(
      snapshot('hello'),
      { kind: 'bubble', style: 'white', tail: 'right' },
      'u',
      { fetch, jobs },
    );
    if (!('file' in result)) throw new Error(String(result.error));
    expect(result.file.name).toBe('bubble.gif');
    expect(sniffImage(result.file.attachment as Buffer)).toBe('gif');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers an empty message without starting a job', async () => {
    const jobs = new ImageJobs();
    const run = vi.spyOn(jobs, 'run');
    const result = await produceMessageImage(
      snapshot('  '),
      { kind: 'bubble', style: 'white', tail: 'left' },
      'u',
      { jobs },
    );
    expect(result).toEqual({ error: messages.emptyMessage });
    expect(run).not.toHaveBeenCalled();
  });

  it('holds the per-user lock while the screenshot is drawn', async () => {
    const jobs = new ImageJobs();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      await blocked;
      return new Response('nope', { status: 404 });
    }) as unknown as Fetcher;
    const op = { kind: 'bubble', style: 'white', tail: 'left' } as const;
    const first = produceMessageImage(snapshot('one'), op, 'u', { fetch, jobs });
    const second = await produceMessageImage(snapshot('two'), op, 'u', { fetch, jobs });
    expect(second).toEqual({ error: messages.busyUser });
    release();
    expect(await first).toHaveProperty('file');
  });
});

import { container } from '@sapphire/framework';
import {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import {
  addHallExempt,
  hallChannelProblem,
  hallExemptChannels,
  hallOfFame,
  hallSettings,
  setHallChannel,
  setHallThreshold,
} from '../src/features/halloffame/index.js';
import { honeypotConflict, setHoneypot } from '../src/features/honeypot/index.js';
import { settingsNeedsManageServer } from '../src/features/settings/cards.js';
import { addGameChannel, setLogChannel } from '../src/features/settings/index.js';
import { testEnv } from './support/env.js';
import { installNativeHallRunner, stubHallRunner } from './support/hall-runner-stub.js';
import { makeChatInput, makeMe } from './support/interaction.js';

let client: ReturnType<typeof createClient>;
let runner: ReturnType<typeof stubHallRunner>;
let uninstall: () => void;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
  runner = stubHallRunner();
  uninstall = installNativeHallRunner(runner);
});

afterEach(() => uninstall());

const fullBits =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory;

function channel(
  id: string,
  overrides: { type?: ChannelType; bits?: bigint; send?: ReturnType<typeof vi.fn> } = {},
) {
  const { type = ChannelType.GuildText, bits = fullBits, send } = overrides;
  return {
    id,
    type,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(bits),
    send: send ?? vi.fn(async () => ({ id: `msg-${id}` })),
  };
}

function guild(channels = new Map<string, unknown>()) {
  return {
    id: '2',
    ownerId: '0',
    channels: { cache: channels },
    roles: { cache: new Map() },
    members: { me: makeMe() },
  };
}

function modLog() {
  setLogChannel(container.db, '2', 'mod', '60', 1);
  const log = channel('60');
  client.channels.cache.set('60', log as never);
  return log;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(
  sub: string,
  options: Record<string, unknown> = {},
  extras: { permissions?: bigint; guild?: unknown; group?: string | null } = {},
) {
  const { group = 'halloffame', ...rest } = extras;
  const interaction = makeChatInput(client, {
    commandName: 'settings',
    userId: '9',
    subcommand: sub,
    subcommandGroup: group ?? undefined,
    options,
    ...rest,
  });
  client.emit(Events.InteractionCreate, interaction as never);
  await wait(100);
  const [reply] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
  return { text: JSON.stringify(reply), flags: reply.flags };
}

const logged = (log: { send: ReturnType<typeof vi.fn> }) => JSON.stringify(log.send.mock.calls);

describe('/settings halloffame set', () => {
  it('posts the intro card, saves, forgets failures, logs and explains', async () => {
    const log = modLog();
    const hall = channel('70');
    const result = await run('set', { channel: hall, threshold: 8 });
    expect(result.text).toContain('Set the Hall of Fame to <#70>');
    expect(result.text).toContain('8 people');
    expect(result.text).toContain('not retroactive');
    expect(result.text).toContain('different people, not reactions');
    expect(hallSettings(container.db, '2')).toEqual({ channelId: '70', threshold: 8 });
    expect(hall.send).toHaveBeenCalledTimes(1);
    const intro = JSON.stringify(hall.send.mock.calls);
    expect(intro).toContain('<@9> made <#70> the Hall of Fame');
    expect(intro).toContain('**8** or more different people');
    expect(runner.forgetFailures).toHaveBeenCalledWith('70');
    await wait(50);
    expect(logged(log)).toContain('<@9> set the Hall of Fame to <#70> (8 people)');
    expect(result.flags & 64).toBe(64);
  });

  it('keeps the current threshold when none is given', async () => {
    setHallThreshold(container.db, '2', 12, 1);
    const hall = channel('70');
    await run('set', { channel: hall });
    expect(hallSettings(container.db, '2')).toEqual({ channelId: '70', threshold: 12 });
    expect(JSON.stringify(hall.send.mock.calls)).toContain('**12** or more');
  });

  it('defaults to the configured threshold', async () => {
    await run('set', { channel: channel('70') });
    expect(hallSettings(container.db, '2').threshold).toBe(hallOfFame.defaultThreshold);
  });

  it('moves the hall, says the old posts stay and logs where it was', async () => {
    const log = modLog();
    setHallChannel(container.db, '2', '69', 1);
    const result = await run('set', { channel: channel('70') });
    expect(result.text).toContain('Posts already in <#69> stay there.');
    expect(hallSettings(container.db, '2').channelId).toBe('70');
    await wait(50);
    expect(logged(log)).toContain('Previously <#69>');
  });

  it('rechecks the permissions when the channel and threshold are unchanged', async () => {
    setHallChannel(container.db, '2', '70', 1);
    const hall = channel('70');
    const result = await run('set', { channel: hall, threshold: hallOfFame.defaultThreshold });
    expect(result.text).toContain('Rechecked <#70>: permissions are fine, posting resumes.');
    expect(result.text).not.toContain('already');
    expect(result.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(hall.send).not.toHaveBeenCalled();
    // The failure memory is cleared, so the channel is tried right away.
    expect(runner.forgetFailures).toHaveBeenCalledWith('70');
    const bare = await run('set', { channel: hall });
    expect(bare.text).toContain('Rechecked <#70>');
  });

  it('reports what is still missing when the unchanged channel is rechecked', async () => {
    setHallChannel(container.db, '2', '70', 1);
    const hall = channel('70', { bits: fullBits & ~PermissionFlagsBits.AttachFiles });
    const result = await run('set', { channel: hall });
    expect(result.text).toContain("I'm missing Attach Files in <#70>");
    expect(result.text).not.toContain('Rechecked');
    expect(hall.send).not.toHaveBeenCalled();
  });

  it('only updates the threshold of the channel that is already set', async () => {
    const log = modLog();
    setHallChannel(container.db, '2', '70', 1);
    const hall = channel('70');
    const result = await run('set', { channel: hall, threshold: 9 });
    expect(result.text).toContain('threshold is now 9 people');
    expect(hall.send).not.toHaveBeenCalled();
    expect(hallSettings(container.db, '2')).toEqual({ channelId: '70', threshold: 9 });
    expect(runner.forgetFailures).toHaveBeenCalledWith('70');
    await wait(50);
    expect(logged(log)).toContain('changed the threshold from 5 to 9 people');
    expect(logged(log)).not.toContain('set the Hall of Fame');
  });

  it('refuses the honeypot channel', async () => {
    setHoneypot(container.db, '2', '70', 'card', 1);
    const hall = channel('70');
    const result = await run('set', { channel: hall });
    expect(result.text).toContain(
      "<#70> is the honeypot channel, so it can't be the Hall of Fame channel.",
    );
    expect(hall.send).not.toHaveBeenCalled();
    expect(hallSettings(container.db, '2').channelId).toBeUndefined();
  });

  it.each([
    ['a voice channel', { type: ChannelType.GuildVoice }, 'Pick a text or announcement channel.'],
    [
      'no View Channel',
      { bits: fullBits & ~PermissionFlagsBits.ViewChannel },
      "I'm missing View Channel in <#70>.",
    ],
    [
      'no Send Messages',
      { bits: fullBits & ~PermissionFlagsBits.SendMessages },
      "I'm missing Send Messages in <#70>.",
    ],
    [
      'no Attach Files',
      { bits: fullBits & ~PermissionFlagsBits.AttachFiles },
      "I'm missing Attach Files in <#70>.",
    ],
    [
      'no Read Message History',
      { bits: fullBits & ~PermissionFlagsBits.ReadMessageHistory },
      "I'm missing Read Message History in <#70>.",
    ],
    [
      'several permissions',
      { bits: PermissionFlagsBits.ViewChannel },
      "I'm missing Send Messages, Attach Files and Read Message History in <#70>.",
    ],
  ])('rejects %s', async (_name, overrides, message) => {
    const hall = channel('70', overrides);
    const result = await run('set', { channel: hall });
    expect(result.text).toContain(message);
    expect(hall.send).not.toHaveBeenCalled();
    expect(hallSettings(container.db, '2').channelId).toBeUndefined();
  });

  it('changes nothing when the intro card cannot be posted', async () => {
    const hall = channel('70', { send: vi.fn().mockRejectedValue(new Error('nope')) });
    const result = await run('set', { channel: hall, threshold: 7 });
    expect(result.text).toContain("I couldn't post in <#70>, so nothing changed.");
    expect(hallSettings(container.db, '2')).toEqual({
      channelId: undefined,
      threshold: hallOfFame.defaultThreshold,
    });
    expect(runner.forgetFailures).not.toHaveBeenCalled();
  });

  it.each([1, 51, 2.5])('rejects the threshold %s server-side', async (threshold) => {
    const hall = channel('70');
    const result = await run('set', { channel: hall, threshold });
    expect(result.text).toContain('The threshold must be a whole number from 2 to 50.');
    expect(hall.send).not.toHaveBeenCalled();
  });

  it('needs Manage Server', async () => {
    const hall = channel('70');
    const result = await run(
      'set',
      { channel: hall },
      { permissions: PermissionFlagsBits.SendMessages },
    );
    expect(result.text).toContain(settingsNeedsManageServer);
    expect(hall.send).not.toHaveBeenCalled();
  });
});

describe('/settings halloffame threshold', () => {
  it('changes the threshold, logs it and says it is not retroactive', async () => {
    const log = modLog();
    setHallChannel(container.db, '2', '70', 1);
    const result = await run('threshold', { count: 10 });
    expect(result.text).toContain('threshold is now 10 people');
    expect(result.text).toContain('not retroactive');
    expect(result.text).not.toContain('no Hall of Fame channel yet');
    expect(hallSettings(container.db, '2').threshold).toBe(10);
    await wait(50);
    expect(logged(log)).toContain('<@9> changed the threshold from 5 to 10 people');
  });

  it('can be set before a channel exists and says so', async () => {
    const result = await run('threshold', { count: 3 });
    expect(result.text).toContain('There is no Hall of Fame channel yet');
    expect(hallSettings(container.db, '2')).toEqual({ channelId: undefined, threshold: 3 });
  });

  it('refuses an unchanged threshold', async () => {
    const result = await run('threshold', { count: hallOfFame.defaultThreshold });
    expect(result.text).toContain(
      `The Hall of Fame threshold is already ${hallOfFame.defaultThreshold} people.`,
    );
  });

  it.each([0, 1, 51, 3.5])('rejects %s', async (count) => {
    const result = await run('threshold', { count });
    expect(result.text).toContain('The threshold must be a whole number from 2 to 50.');
    expect(hallSettings(container.db, '2').threshold).toBe(hallOfFame.defaultThreshold);
  });
});

describe('/settings halloffame clear', () => {
  it('stops inducting, keeps the threshold and logs it', async () => {
    const log = modLog();
    setHallChannel(container.db, '2', '70', 1);
    setHallThreshold(container.db, '2', 9, 1);
    const result = await run('clear');
    expect(result.text).toContain('Cleared the Hall of Fame');
    expect(result.text).toContain('Existing posts stay in <#70>');
    expect(hallSettings(container.db, '2')).toEqual({ channelId: undefined, threshold: 9 });
    await wait(50);
    expect(logged(log)).toContain('<@9> cleared the Hall of Fame (was <#70>)');
  });

  it('explains clearing an unset hall', async () => {
    const result = await run('clear');
    expect(result.text).toContain("The Hall of Fame isn't set.");
  });
});

describe('/settings halloffame exempt and unexempt', () => {
  it('exempts a channel, lists the exempt channels and logs it', async () => {
    const log = modLog();
    await run('exempt', { channel: channel('80') });
    const result = await run('exempt', {
      channel: channel('81', { type: ChannelType.GuildVoice }),
    });
    expect(result.text).toContain('<#81> is exempt');
    expect(result.text).toContain('Exempt (2/50): <#80>, <#81>.');
    expect(hallExemptChannels(container.db, '2')).toEqual(['80', '81']);
    await wait(50);
    expect(logged(log)).toContain('<@9> exempted <#81> from the Hall of Fame');
  });

  it('accepts a category and says its channels are covered', async () => {
    const result = await run('exempt', {
      channel: channel('90', { type: ChannelType.GuildCategory }),
    });
    expect(result.text).toContain('Its channels and their threads are skipped too.');
    expect(hallExemptChannels(container.db, '2')).toEqual(['90']);
  });

  it('registers every channel type that can hold messages, but not threads', async () => {
    const { hallExemptChannelTypes } = await import('../src/features/halloffame/index.js');
    expect(hallExemptChannelTypes).toEqual(
      expect.arrayContaining([
        ChannelType.GuildText,
        ChannelType.GuildAnnouncement,
        ChannelType.GuildVoice,
        ChannelType.GuildStageVoice,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
        ChannelType.GuildCategory,
      ]),
    );
    expect(hallExemptChannelTypes).not.toContain(ChannelType.PublicThread);
  });

  it('refuses a channel that is already exempt', async () => {
    addHallExempt(container.db, '2', '80', 1);
    const result = await run('exempt', { channel: channel('80') });
    expect(result.text).toContain('<#80> is already exempt.');
  });

  it('refuses beyond the cap', async () => {
    for (let i = 0; i < hallOfFame.maxExemptChannels; i++) {
      addHallExempt(container.db, '2', `c${i}`, i);
    }
    const result = await run('exempt', { channel: channel('80') });
    expect(result.text).toContain('You can exempt at most 50 channels.');
    expect(hallExemptChannels(container.db, '2')).not.toContain('80');
  });

  it('refuses the hall channel and the honeypot as always ignored anyway', async () => {
    setHallChannel(container.db, '2', '70', 1);
    setHoneypot(container.db, '2', '71', 'card', 1);
    const a = await run('exempt', { channel: channel('70') });
    expect(a.text).toContain(
      '<#70> is the Hall of Fame channel, which the Hall of Fame always ignores anyway.',
    );
    const b = await run('exempt', { channel: channel('71') });
    expect(b.text).toContain(
      '<#71> is the honeypot channel, which the Hall of Fame always ignores anyway.',
    );
    expect(hallExemptChannels(container.db, '2')).toEqual([]);
  });

  it('unexempts, lists what is left and logs it', async () => {
    const log = modLog();
    addHallExempt(container.db, '2', '80', 1);
    addHallExempt(container.db, '2', '81', 2);
    const result = await run('unexempt', { channel: channel('80') });
    expect(result.text).toContain('<#80> is no longer exempt.');
    expect(result.text).toContain('Exempt (1/50): <#81>.');
    const last = await run('unexempt', { channel: channel('81') });
    expect(last.text).toContain('No channels are exempt.');
    await wait(50);
    expect(logged(log)).toContain('<@9> stopped exempting <#80> for the Hall of Fame');
  });

  it('refuses to unexempt a channel that is not listed', async () => {
    const result = await run('unexempt', { channel: channel('80') });
    expect(result.text).toContain("<#80> isn't exempt.");
  });
});

describe('the honeypot conflict', () => {
  it('refuses the hall channel as the honeypot through /settings honeypot set', async () => {
    setHallChannel(container.db, '2', '70', 1);
    const target = channel('70');
    const result = await run('set', { channel: target }, { group: 'honeypot' });
    expect(result.text).toContain(
      "<#70> is the Hall of Fame channel, so it can't be the honeypot.",
    );
    expect(target.send).not.toHaveBeenCalled();
  });

  it('is reported by honeypotConflict and stops once the hall is cleared', () => {
    setHallChannel(container.db, '2', '70', 1);
    expect(honeypotConflict(container.db, '2', '70')).toBe(
      "<#70> is the Hall of Fame channel, so it can't be the honeypot.",
    );
    expect(honeypotConflict(container.db, '2', '71')).toBeUndefined();
    setHallChannel(container.db, '2', null, 2);
    expect(honeypotConflict(container.db, '2', '70')).toBeUndefined();
  });

  it('keeps the log and game channel conflicts', () => {
    setLogChannel(container.db, '2', 'economy', '70', 1);
    addGameChannel(container.db, '2', '71', 1);
    expect(honeypotConflict(container.db, '2', '70')).toContain('log channel');
    expect(honeypotConflict(container.db, '2', '71')).toContain('game channel');
  });
});

describe('hallChannelProblem', () => {
  it('accepts a channel with every permission', () => {
    expect(hallChannelProblem(channel('70'), makeMe() as never)).toBeUndefined();
    expect(
      hallChannelProblem(channel('70', { type: ChannelType.GuildAnnouncement }), makeMe() as never),
    ).toBeUndefined();
  });

  it('reports a channel the bot cannot see at all', () => {
    const hidden = { ...channel('70'), permissionsFor: () => null };
    expect(hallChannelProblem(hidden, makeMe() as never)).toContain(
      "I'm missing View Channel, Send Messages, Attach Files and Read Message History in <#70>.",
    );
  });
});

describe('/settings show', () => {
  it('shows the hall as not set with its threshold and the automatic skips', async () => {
    const result = await run('show', {}, { group: null, guild: guild() });
    expect(result.text).toContain('**Hall of Fame:** not set (threshold 5 people)');
    expect(result.text).toContain('**Hall of Fame exempt:** none');
    expect(result.text).toContain('private threads');
    expect(result.text).toContain('age-restricted channels');
    expect(result.text).toContain('errs on the side of refusing');
    expect(result.text).not.toContain('⚠️');
  });

  it('shows the channel, threshold and exempt channels', async () => {
    setHallChannel(container.db, '2', '70', 1);
    setHallThreshold(container.db, '2', 8, 1);
    addHallExempt(container.db, '2', '80', 1);
    addHallExempt(container.db, '2', '81', 2);
    const result = await run(
      'show',
      {},
      { group: null, guild: guild(new Map([['70', channel('70')]])) },
    );
    expect(result.text).toContain('**Hall of Fame:** <#70> · 8 people');
    expect(result.text).toContain('**Hall of Fame exempt:** <#80>, <#81>');
    expect(result.text).not.toContain('⚠️');
  });

  it('warns about a missing permission and a deleted channel', async () => {
    setHallChannel(container.db, '2', '70', 1);
    const noAttach = channel('70', { bits: fullBits & ~PermissionFlagsBits.AttachFiles });
    const a = await run('show', {}, { group: null, guild: guild(new Map([['70', noAttach]])) });
    expect(a.text).toContain("⚠️ I'm missing Attach Files in <#70>.");
    const b = await run('show', {}, { group: null, guild: guild() });
    expect(b.text).toContain('⚠️ channel no longer exists');
  });

  it('summarises a long exempt list', async () => {
    for (let i = 0; i < 20; i++) addHallExempt(container.db, '2', `${100 + i}`, i);
    const result = await run('show', {}, { group: null, guild: guild() });
    expect(result.text).toContain('and 5 more');
  });
});

import { container } from '@sapphire/framework';
import {
  ChannelType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { openDatabase } from '../src/db/index.js';
import { honeypot, incrementKicks, setHoneypot } from '../src/features/honeypot/index.js';
import { logChannelAlreadySet, settingsNeedsManageServer } from '../src/features/settings/cards.js';
import { addGameChannel, gameChannels } from '../src/features/settings/game-channels.js';
import {
  addAutoRole,
  autoRoles,
  logChannelId,
  setLogChannel,
} from '../src/features/settings/store.js';
import { testEnv } from './support/env.js';
import { makeChatInput, makeMe } from './support/interaction.js';

let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

beforeEach(() => {
  container.db = openDatabase(':memory:');
  container.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as never;
});

function fakeChannel(id: string, bits: bigint = PermissionsBitField.All) {
  return {
    id,
    type: ChannelType.GuildText,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(bits),
    send: vi.fn(async () => ({})),
  };
}

async function run(
  group: string | undefined,
  sub: string,
  options: Record<string, unknown> = {},
  extras: { permissions?: bigint; guild?: unknown; highest?: number } = {},
) {
  const { highest = 10, ...rest } = extras;
  const interaction = makeChatInput(client, {
    commandName: 'settings',
    userId: '9',
    subcommand: sub,
    subcommandGroup: group,
    options,
    ...rest,
  });
  (interaction as { member: unknown }).member = { roles: { highest: { position: highest } } };
  client.emit(Events.InteractionCreate, interaction as never);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [reply] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
  return { text: JSON.stringify(reply), flags: reply.flags };
}

describe('/settings logs', () => {
  it('refuses without Manage Server', async () => {
    const result = await run(
      'logs',
      'set',
      { type: 'economy', channel: fakeChannel('50') },
      { permissions: PermissionFlagsBits.SendMessages },
    );
    expect(result.text).toContain(settingsNeedsManageServer);
    expect(result.flags & MessageFlags.Ephemeral).toBeTruthy();
  });

  it('sets the economy log after posting a confirmation there', async () => {
    const channel = fakeChannel('50');
    const result = await run('logs', 'set', { type: 'economy', channel });
    expect(JSON.stringify(channel.send.mock.calls[0])).toContain(
      'This channel now receives economy logs',
    );
    expect(logChannelId(container.db, '2', 'economy')).toBe('50');
    expect(result.text).toContain('Set the economy log to <#50>.');
    expect(result.flags & MessageFlags.Ephemeral).toBeTruthy();
  });

  it('rejects a channel it cannot post in', async () => {
    const channel = fakeChannel('50', 0n);
    const result = await run('logs', 'set', { type: 'economy', channel });
    expect(result.text).toContain('I need View Channel and Send Messages');
    expect(logChannelId(container.db, '2', 'economy')).toBeUndefined();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('changes nothing when the confirmation fails', async () => {
    const channel = fakeChannel('50');
    channel.send.mockRejectedValue(new Error('nope'));
    const result = await run('logs', 'set', { type: 'economy', channel });
    expect(result.text).toContain("I couldn't post in <#50>, so nothing changed.");
    expect(logChannelId(container.db, '2', 'economy')).toBeUndefined();
  });

  it('says so when the channel is already set', async () => {
    setLogChannel(container.db, '2', 'economy', '50', 1);
    const channel = fakeChannel('50');
    const result = await run('logs', 'set', { type: 'economy', channel });
    expect(result.text).toContain(logChannelAlreadySet('economy', '50'));
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('tells the old mod log when the mod log moves', async () => {
    setLogChannel(container.db, '2', 'mod', '60', 1);
    const old = fakeChannel('60');
    client.channels.cache.set('60', old as never);
    const channel = fakeChannel('50');
    client.channels.cache.set('50', channel as never);
    await run('logs', 'set', { type: 'mod', channel });
    expect(logChannelId(container.db, '2', 'mod')).toBe('50');
    expect(old.send).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalled();
  });

  it('clears a log', async () => {
    setLogChannel(container.db, '2', 'economy', '50', 1);
    const result = await run('logs', 'clear', { type: 'economy' });
    expect(result.text).toContain('Cleared the economy log.');
    expect(logChannelId(container.db, '2', 'economy')).toBeUndefined();
  });

  it('explains clearing an unset log', async () => {
    const result = await run('logs', 'clear', { type: 'mod' });
    expect(result.text).toContain("The mod log isn't set.");
  });

  it('shows log settings with warnings', async () => {
    setLogChannel(container.db, '2', 'economy', '77', 1);
    const result = await run(undefined, 'show');
    expect(result.text).toContain('**Economy log:**');
    expect(result.text).toContain('⚠️ channel no longer exists');
    expect(result.text).toContain('**Mod log:** not set');
    expect(result.text).toContain('**Auto-roles (members):** none');
  });

  it('shows a healthy log channel without warning', async () => {
    setLogChannel(container.db, '2', 'mod', '50', 1);
    const guild = {
      id: '2',
      ownerId: '0',
      channels: { cache: new Map([['50', fakeChannel('50')]]) },
      roles: { cache: new Map() },
      members: { me: makeMe() },
    };
    const result = await run(undefined, 'show', {}, { guild });
    expect(result.text).toContain('**Mod log:** <#50>');
    expect(result.text).not.toContain('⚠️');
  });
});

function fakeRole(id: string, position = 3, extra: Record<string, unknown> = {}) {
  return {
    id,
    guild: { id: '2' },
    position,
    managed: false,
    permissions: { bitfield: 0n },
    ...extra,
  };
}

function guildWithBot(botHighest = 8, roleIds: string[] = []) {
  return {
    id: '2',
    ownerId: '0',
    channels: { cache: new Map() },
    roles: { cache: new Map(roleIds.map((id) => [id, fakeRole(id)])) },
    members: {
      me: {
        id: 'me',
        roles: { highest: { position: botHighest } },
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
      },
    },
  };
}

describe('/settings autorole', () => {
  it('adds a role and logs to the mod channel', async () => {
    const modChannel = fakeChannel('60');
    client.channels.cache.set('60', modChannel as never);
    setLogChannel(container.db, '2', 'mod', '60', 1);
    const result = await run('autorole', 'add', { role: fakeRole('5') }, { guild: guildWithBot() });
    expect(result.text).toContain('New members will get <@&5>.');
    expect(autoRoles(container.db, '2', 'member')).toEqual(['5']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(modChannel.send).toHaveBeenCalledTimes(1);
  });

  it('adds a bot role when target is bots', async () => {
    const result = await run(
      'autorole',
      'add',
      { role: fakeRole('5'), target: 'bot' },
      { guild: guildWithBot() },
    );
    expect(result.text).toContain('New bots will get <@&5>.');
    expect(autoRoles(container.db, '2', 'bot')).toEqual(['5']);
  });

  it.each([
    ['at or above the bot', fakeRole('5', 9), 'That role is at or above my highest role.'],
    ['at or above the invoker', fakeRole('5', 7), 'That role is at or above your highest role.'],
    ['managed', fakeRole('5', 3, { managed: true }), 'That role is managed by an integration.'],
    [
      'dangerous',
      fakeRole('5', 3, { permissions: { bitfield: PermissionFlagsBits.Administrator } }),
      "That role has moderator permissions, so it can't be an auto-role.",
    ],
  ])('rejects a role %s', async (_name, role, text) => {
    const result = await run('autorole', 'add', { role }, { guild: guildWithBot(), highest: 6 });
    expect(result.text).toContain(text);
    expect(autoRoles(container.db, '2', 'member')).toEqual([]);
  });

  it('says so when the role already exists', async () => {
    addAutoRole(container.db, '2', '5', 'member', 1);
    const result = await run('autorole', 'add', { role: fakeRole('5') }, { guild: guildWithBot() });
    expect(result.text).toContain('<@&5> is already an auto-role for members.');
  });

  it('refuses past ten roles', async () => {
    for (let i = 0; i < 10; i++) addAutoRole(container.db, '2', `r${i}`, 'bot', i);
    const result = await run(
      'autorole',
      'add',
      { role: fakeRole('5'), target: 'bot' },
      { guild: guildWithBot() },
    );
    expect(result.text).toContain('You can have at most 10 auto-roles for bots.');
  });

  it('removes a role', async () => {
    addAutoRole(container.db, '2', '5', 'member', 1);
    const result = await run('autorole', 'remove', { role: fakeRole('5') });
    expect(result.text).toContain('<@&5> is no longer given to new members.');
    expect(autoRoles(container.db, '2', 'member')).toEqual([]);
  });

  it('explains removing a role that is not listed', async () => {
    const result = await run('autorole', 'remove', { role: fakeRole('5'), target: 'bot' });
    expect(result.text).toContain("<@&5> isn't an auto-role for bots.");
  });

  it('shows auto-roles with problems', async () => {
    addAutoRole(container.db, '2', '5', 'member', 1);
    addAutoRole(container.db, '2', '6', 'bot', 1);
    const guild = guildWithBot(4, ['5']);
    guild.roles.cache.set('6', fakeRole('6', 9) as never);
    guild.roles.cache.set('5', fakeRole('5', 2) as never);
    const result = await run(undefined, 'show', {}, { guild });
    expect(result.text).toContain('<@&5>');
    expect(result.text).not.toContain('<@&5> ⚠️');
    expect(result.text).toContain('<@&6> ⚠️ That role is at or above my highest role.');
  });

  it('flags an auto-role that gained moderator permissions in show', async () => {
    addAutoRole(container.db, '2', '5', 'member', 1);
    const guild = guildWithBot(4);
    guild.roles.cache.set(
      '5',
      fakeRole('5', 2, { permissions: { bitfield: PermissionFlagsBits.Administrator } }) as never,
    );
    const result = await run(undefined, 'show', {}, { guild });
    expect(result.text).toContain(
      "<@&5> ⚠️ That role has moderator permissions, so it can't be an auto-role.",
    );
  });

  it('flags a deleted auto-role in show', async () => {
    addAutoRole(container.db, '2', '7', 'member', 1);
    const result = await run(undefined, 'show', {}, { guild: guildWithBot() });
    expect(result.text).toContain('<@&7> ⚠️ role no longer exists');
  });
});

describe('/settings games', () => {
  it('limits the games to a channel, lists it and lifts the limit again', async () => {
    const channel = fakeChannel('c1');
    const allow = await run('games', 'allow', { channel });
    expect(allow.text).toContain('limited to <#c1>');
    expect(gameChannels(container.db, '2')).toEqual(['c1']);

    const again = await run('games', 'allow', { channel });
    expect(again.text).toContain('already a game channel');

    const show = await run(undefined, 'show');
    expect(show.text).toContain('**Game channels:** <#c1>');

    const remove = await run('games', 'remove', { channel });
    expect(remove.text).toContain('every channel again');
    expect(gameChannels(container.db, '2')).toEqual([]);

    const missing = await run('games', 'remove', { channel });
    expect(missing.text).toContain("isn't a game channel");
  });

  it('resets the list and needs Manage Server', async () => {
    addGameChannel(container.db, '2', 'c1', 1);
    await run('games', 'reset');
    expect(gameChannels(container.db, '2')).toEqual([]);
    const denied = await run('games', 'allow', { channel: fakeChannel('c2') }, { permissions: 0n });
    expect(denied.text).toContain(settingsNeedsManageServer);
    expect(gameChannels(container.db, '2')).toEqual([]);
  });
});

describe('/settings honeypot', () => {
  function honeypotGuild(
    meBits: bigint = PermissionFlagsBits.BanMembers | PermissionFlagsBits.ManageRoles,
    channels = new Map<string, unknown>(),
  ) {
    return {
      id: '2',
      ownerId: '0',
      channels: { cache: channels },
      roles: { cache: new Map() },
      members: {
        me: {
          id: 'me',
          roles: { highest: { position: 8 } },
          permissions: new PermissionsBitField(meBits),
        },
      },
    };
  }

  function honeypotChannel(id: string) {
    const channel = {
      ...fakeChannel(id),
      send: vi.fn(async () => ({ id: `card-${id}` })),
      messages: { edit: vi.fn(async () => ({})), delete: vi.fn(async () => undefined) },
    };
    client.channels.cache.set(id, channel as never);
    return channel;
  }

  function modLog() {
    setLogChannel(container.db, '2', 'mod', '60', 1);
    const channel = fakeChannel('60');
    client.channels.cache.set('60', channel as never);
    return channel;
  }

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('sets the honeypot, posts the card and logs it', async () => {
    const log = modLog();
    const channel = honeypotChannel('70');
    const result = await run('honeypot', 'set', { channel }, { guild: honeypotGuild() });
    expect(result.text).toContain('Set the honeypot to <#70>.');
    expect(result.flags & MessageFlags.Ephemeral).toBeTruthy();
    const posted = JSON.stringify(channel.send.mock.calls[0]);
    expect(posted).toContain('DO NOT SEND MESSAGES IN THIS CHANNEL');
    expect(posted).toContain('🍯 Kicks: 0');
    expect(honeypot(container.db, '2')).toEqual({
      channelId: '70',
      messageId: 'card-70',
      kicks: 0,
    });
    await wait(50);
    expect(JSON.stringify(log.send.mock.calls)).toContain('<@9> set the honeypot to <#70>');
  });

  it('moves the honeypot, keeps the kicks and deletes the old card after storing the new one', async () => {
    const log = modLog();
    const old = honeypotChannel('69');
    setHoneypot(container.db, '2', '69', 'card-69', 1);
    for (let i = 0; i < 4; i++) incrementKicks(container.db, '2', 2);
    let storedAtDelete: string | undefined;
    old.messages.delete.mockImplementation(async () => {
      storedAtDelete = honeypot(container.db, '2').messageId;
      return undefined;
    });
    const channel = honeypotChannel('70');
    await run('honeypot', 'set', { channel }, { guild: honeypotGuild() });
    await wait(50);
    expect(old.messages.delete).toHaveBeenCalledWith('card-69');
    expect(storedAtDelete).toBe('card-70');
    expect(JSON.stringify(channel.send.mock.calls[0])).toContain('🍯 Kicks: 4');
    expect(JSON.stringify(log.send.mock.calls)).toContain('Previously <#69>');
  });

  it('says so when the channel is already the honeypot', async () => {
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    const channel = honeypotChannel('70');
    const result = await run('honeypot', 'set', { channel }, { guild: honeypotGuild() });
    expect(result.text).toContain('<#70> is already the honeypot.');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('reports a failed card check when set to the same channel', async () => {
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    const channel = honeypotChannel('70');
    channel.messages.edit.mockRejectedValue({ code: 50013 });
    const result = await run('honeypot', 'set', { channel }, { guild: honeypotGuild() });
    expect(result.text).toContain(
      "I couldn't check or re-post the honeypot card in <#70>. Make sure I can view, send and manage messages there.",
    );
    expect(result.text).not.toContain('is already the honeypot');
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('re-posts a missing card when set to the same channel', async () => {
    setHoneypot(container.db, '2', '70', 'card-old', 1);
    const channel = honeypotChannel('70');
    channel.messages.edit.mockRejectedValue({ code: 10008 });
    const result = await run('honeypot', 'set', { channel }, { guild: honeypotGuild() });
    expect(result.text).toContain('Re-posted the honeypot card in <#70>.');
    expect(honeypot(container.db, '2').messageId).toBe('card-70');
  });

  it.each([
    [
      'a voice channel',
      { type: ChannelType.GuildVoice },
      undefined,
      'Pick a text or announcement channel.',
    ],
    [
      'without Manage Messages',
      {
        permissionsFor: () =>
          new PermissionsBitField(
            PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
          ),
      },
      undefined,
      'I need View Channel, Send Messages and Manage Messages in <#70>.',
    ],
    [
      'without Ban Members',
      {},
      PermissionFlagsBits.ManageRoles,
      'I need the Ban Members permission.',
    ],
  ])('rejects %s', async (_name, overrides, meBits, message) => {
    const channel = { ...honeypotChannel('70'), ...overrides };
    const result = await run('honeypot', 'set', { channel }, { guild: honeypotGuild(meBits) });
    expect(result.text).toContain(message);
    expect(honeypot(container.db, '2').channelId).toBeUndefined();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('refuses a log channel or a game channel as the honeypot', async () => {
    setLogChannel(container.db, '2', 'economy', '70', 1);
    const a = await run(
      'honeypot',
      'set',
      { channel: honeypotChannel('70') },
      { guild: honeypotGuild() },
    );
    expect(a.text).toContain("<#70> is a log channel, so it can't be the honeypot.");
    addGameChannel(container.db, '2', '71', 1);
    const b = await run(
      'honeypot',
      'set',
      { channel: honeypotChannel('71') },
      { guild: honeypotGuild() },
    );
    expect(b.text).toContain("<#71> is a game channel, so it can't be the honeypot.");
    expect(honeypot(container.db, '2').channelId).toBeUndefined();
  });

  it('refuses the honeypot as a log channel or a game channel', async () => {
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    const a = await run('logs', 'set', { type: 'economy', channel: fakeChannel('70') });
    expect(a.text).toContain("<#70> is the honeypot channel, so it can't be a log channel.");
    expect(logChannelId(container.db, '2', 'economy')).toBeUndefined();
    const b = await run('games', 'allow', { channel: fakeChannel('70') });
    expect(b.text).toContain("<#70> is the honeypot channel, so it can't be a game channel.");
    expect(gameChannels(container.db, '2')).toEqual([]);
  });

  it('changes nothing when the card cannot be posted', async () => {
    const channel = honeypotChannel('70');
    channel.send.mockRejectedValue(new Error('nope'));
    const result = await run('honeypot', 'set', { channel }, { guild: honeypotGuild() });
    expect(result.text).toContain("I couldn't post in <#70>, so nothing changed.");
    expect(honeypot(container.db, '2').channelId).toBeUndefined();
  });

  it('clears the honeypot, keeps the kicks, deletes the card and logs it', async () => {
    const log = modLog();
    const channel = honeypotChannel('70');
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    for (let i = 0; i < 4; i++) incrementKicks(container.db, '2', 2);
    const result = await run('honeypot', 'clear', {}, { guild: honeypotGuild() });
    expect(result.text).toContain('Cleared the honeypot. The kick total is kept.');
    await wait(50);
    expect(channel.messages.delete).toHaveBeenCalledWith('card-70');
    expect(honeypot(container.db, '2')).toEqual({
      channelId: undefined,
      messageId: undefined,
      kicks: 4,
    });
    expect(JSON.stringify(log.send.mock.calls)).toContain('<@9> cleared the honeypot (was <#70>)');
  });

  it('explains clearing an unset honeypot', async () => {
    const result = await run('honeypot', 'clear', {}, { guild: honeypotGuild() });
    expect(result.text).toContain("The honeypot isn't set.");
  });

  it('needs Manage Server', async () => {
    const result = await run(
      'honeypot',
      'clear',
      {},
      { permissions: PermissionFlagsBits.SendMessages, guild: honeypotGuild() },
    );
    expect(result.text).toContain(settingsNeedsManageServer);
  });

  async function runWithFailingReply(sub: string, options: Record<string, unknown>) {
    const interaction = makeChatInput(client, {
      commandName: 'settings',
      userId: '9',
      subcommand: sub,
      subcommandGroup: 'honeypot',
      options,
      guild: honeypotGuild(),
    });
    interaction.reply.mockRejectedValue(new Error('Unknown interaction'));
    client.emit(Events.InteractionCreate, interaction as never);
    await wait(100);
  }

  it('still deletes the old card and logs the move when the reply fails', async () => {
    const log = modLog();
    const old = honeypotChannel('69');
    setHoneypot(container.db, '2', '69', 'card-69', 1);
    await runWithFailingReply('set', { channel: honeypotChannel('70') });
    expect(honeypot(container.db, '2').channelId).toBe('70');
    expect(old.messages.delete).toHaveBeenCalledWith('card-69');
    expect(JSON.stringify(log.send.mock.calls)).toContain('Previously <#69>');
  });

  it('still deletes the card and logs the clear when the reply fails', async () => {
    const log = modLog();
    const channel = honeypotChannel('70');
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    await runWithFailingReply('clear', {});
    expect(channel.messages.delete).toHaveBeenCalledWith('card-70');
    expect(JSON.stringify(log.send.mock.calls)).toContain('<@9> cleared the honeypot (was <#70>)');
  });

  it('deletes the card on clear only after the honeypot is cleared', async () => {
    const channel = honeypotChannel('70');
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    let channelAtDelete: string | undefined = 'unset-marker';
    channel.messages.delete.mockImplementation(async () => {
      channelAtDelete = honeypot(container.db, '2').channelId;
      return undefined;
    });
    await run('honeypot', 'clear', {}, { guild: honeypotGuild() });
    await wait(50);
    expect(channel.messages.delete).toHaveBeenCalled();
    expect(channelAtDelete).toBeUndefined();
  });

  it('shows the honeypot with its kicks and problems', async () => {
    const unset = await run(undefined, 'show', {}, { guild: honeypotGuild() });
    expect(unset.text).toContain('**Honeypot:** not set');

    setHoneypot(container.db, '2', '70', 'card-70', 1);
    for (let i = 0; i < 3; i++) incrementKicks(container.db, '2', 2);
    const cache = new Map<string, unknown>([['70', fakeChannel('70')]]);
    const ok = await run(undefined, 'show', {}, { guild: honeypotGuild(undefined, cache) });
    expect(ok.text).toContain('**Honeypot:** <#70> · 3 kicks');
    expect(ok.text).not.toContain('⚠️');

    const noBan = await run(
      undefined,
      'show',
      {},
      { guild: honeypotGuild(PermissionFlagsBits.ManageRoles, cache) },
    );
    expect(noBan.text).toContain('⚠️ I need the Ban Members permission.');

    const gone = await run(undefined, 'show', {}, { guild: honeypotGuild() });
    expect(gone.text).toContain('⚠️ channel no longer exists');
  });

  it.each([
    [1, '**Honeypot:** <#70> · 1 kick'],
    [1234, '**Honeypot:** <#70> · 1,234 kicks'],
  ])('formats a kick count of %i in show', async (kicks, line) => {
    setHoneypot(container.db, '2', '70', 'card-70', 1);
    for (let i = 0; i < kicks; i++) incrementKicks(container.db, '2', 2);
    const cache = new Map<string, unknown>([['70', fakeChannel('70')]]);
    const shown = await run(undefined, 'show', {}, { guild: honeypotGuild(undefined, cache) });
    expect(shown.text).toContain(line);
    expect(shown.text).not.toContain('1 kicks');
  });
});

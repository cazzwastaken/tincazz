import { ComponentType, Events, MessageFlags } from 'discord.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';
import { coinflip, wager as flipWager } from '../src/features/coinflip/config.js';
import { dice, wager as diceWager } from '../src/features/dice/config.js';
import { payoutBps as dicePayoutBps } from '../src/features/dice/rules.js';
import { bailout, cashback, chatReward, collect, daily } from '../src/features/economy/config.js';
import { payoutBps, pot, wager } from '../src/features/gamba/config.js';
import {
  helpPage,
  helpPages,
  parseTopic,
  topicInfo,
  topicPages,
} from '../src/features/help/index.js';
import { poll } from '../src/features/poll/config.js';
import { testEnv } from './support/env.js';
import { makeButton, makeChatInput, makeSelect } from './support/interaction.js';

// Sapphire keeps global state, so share one client across the tests in this file.
let client: ReturnType<typeof createClient>;

beforeAll(async () => {
  client = createClient(testEnv);
  await client.stores.load();
});

const json = (value: unknown) => JSON.stringify(value);
const page = (name: (typeof helpPages)[number], prefix = '?') =>
  json(helpPage(name, prefix, '1').toJSON());
const allPages = (prefix = '?') => helpPages.map((name) => page(name, prefix)).join('\n');
const n = (value: number) => value.toLocaleString('en-US');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Node {
  type: number;
  content?: string;
  components?: Node[];
  options?: { label: string; description?: string; default?: boolean; value: string }[];
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const child of node.components ?? []) walk(child, visit);
}

describe('help pages', () => {
  it('renders every page with the select menu, and a Home button off the home page', () => {
    for (const name of helpPages) {
      const text = page(name);
      expect(text).toContain('hp:menu:1');
      expect(text.includes('hp:home:1')).toBe(name !== 'home');
    }
  });

  it('marks the current topic as the default option, none on home', () => {
    for (const name of helpPages) {
      const defaults: string[] = [];
      walk(helpPage(name, '?', '1').toJSON() as unknown as Node, (node) => {
        for (const option of node.options ?? []) if (option.default) defaults.push(option.value);
      });
      expect(defaults).toEqual(name === 'home' ? [] : [name]);
    }
  });

  it('stays within Discord limits', () => {
    for (const name of helpPages) {
      let count = 0;
      let chars = 0;
      walk(helpPage(name, '?', '1').toJSON() as unknown as Node, (node) => {
        count++;
        chars += node.content?.length ?? 0;
        if (node.type === ComponentType.TextDisplay) {
          expect(node.content?.length).toBeLessThanOrEqual(4000);
        }
        for (const option of node.options ?? []) {
          expect(option.label.length).toBeLessThanOrEqual(100);
          expect((option.description ?? '').length).toBeLessThanOrEqual(100);
        }
      });
      expect(count, name).toBeLessThanOrEqual(40);
      expect(chars, name).toBeLessThanOrEqual(4000);
    }
  });

  it('uses the configured prefix', () => {
    const text = allPages('!');
    expect(text).toContain('!cf 100 tails');
    expect(text).toContain('!dice =12 50');
    expect(text).toContain('!bubble');
    expect(text).toContain('!caption');
    expect(text).toContain('!gif');
    expect(parseTopic('gif')).toBe('images');
    expect(text).not.toContain('?cf');
  });

  it('documents polls from the poll config', () => {
    const text = page('polls', '!');
    expect(text).toContain('!poll');
    expect(text).toContain('/poll');
    expect(text).toContain('--anon');
    expect(text).toContain('Close poll');
    expect(text).toContain(`${poll.maxOpenPerHost} open polls`);
    expect(text).toContain(`${poll.minOptions} to ${poll.maxOptions}`);
  });

  it('lists the games with aliases and examples', () => {
    const text = page('games');
    for (const entry of [
      '/gamba',
      '?gamba 50',
      '/coinflip',
      '?cf',
      '?flip',
      '/dice',
      '?roll',
      '?dice =12 50',
    ]) {
      expect(text).toContain(entry);
    }
    for (const limits of [wager, flipWager, diceWager]) {
      expect(text).toContain(`${n(limits.minBet)} to ${n(limits.maxBet)}`);
    }
  });

  it('describes the image commands', () => {
    const text = page('images');
    for (const entry of [
      '/bubble',
      '?bubble',
      '/caption',
      '?caption',
      'Bubble message',
      'Caption message',
      '/caption message:<link>',
      'avatar',
    ]) {
      expect(text).toContain(entry);
    }
  });

  it('builds the coin lines from the economy config', () => {
    const text = page('coins');
    expect(text).toContain(
      `${n(daily.base)} coins plus ${n(daily.perStreakDay)} per streak day (up to ${daily.streakCap} days)`,
    );
    expect(text).toContain(`${cashback.percent}% cashback`);
    expect(text).toContain(`up to ${n(cashback.max)}`);
    expect(text).toContain(`${n(collect.perHour)} coins per hour`);
    expect(text).toContain(`up to ${collect.maxHours} hours`);
    expect(text).toContain(`${n(chatReward.amount)} coins per message`);
    expect(text).toContain(`every ${bailout.cooldownMs / 60_000} minutes`);
    expect(text).toContain(`under ${n(bailout.belowBalance)} coins`);
  });

  it('builds the gamba table and pot rules from the config', () => {
    const text = page('gamba');
    for (const bps of Object.values(payoutBps)) {
      if (bps > 0) expect(text).toContain(`**${bps / 10_000}x**`);
    }
    expect(text).toContain(`${n(pot.seed)}`);
    expect(text).toContain(`${pot.contributionPercent}%`);
    expect(text).toContain(`${pot.maxWinPerBet.cppTriple}x your bet`);
    expect(text).toContain('Spin again');
    expect(text).toContain('Double');
    expect(text).toContain('`/gamba` results');
    expect(text).toContain('`?gamba` reply has no buttons');
    expect(text).toContain(`${n(wager.maxBet)}`);
  });

  it('builds the coinflip and dice rules from the config', () => {
    const text = page('flipdice');
    expect(text).toContain(`${coinflip.rakePercent}% rake`);
    expect(text).toContain(`${coinflip.expiryMs.open / 1000} seconds`);
    expect(text).toContain(`${coinflip.maxLiveChallenges} open challenges`);
    expect(text).toContain(`${dice.returnBps / 100}%`);
    for (const call of [
      { kind: 'high' },
      { kind: 'seven' },
      { kind: 'exact', target: 2 },
    ] as const) {
      expect(text).toContain(`**${Number((dicePayoutBps(call) / 10_000).toFixed(2))}x**`);
    }
    for (const control of ['Roll again', 'Double', 'Change call']) {
      expect(text).toContain(control);
    }
  });

  it('lists every command, so a new one cannot skip help', () => {
    const text = allPages();
    for (const command of client.stores.get('commands').values()) {
      expect(text, `/${command.name} is missing from /help`).toContain(`/${command.name}`);
    }
  });

  it('has a topic option and description for every topic page', () => {
    expect(topicPages.length).toBe(helpPages.length - 1);
    for (const value of topicPages) {
      expect(topicInfo[value].label.length).toBeGreaterThan(0);
    }
  });
});

describe('parseTopic', () => {
  it('is forgiving and falls back to home', () => {
    const cases: [string | undefined, string][] = [
      ['games', 'games'],
      ['Images', 'images'],
      ['  COINS ', 'coins'],
      ['gamba', 'gamba'],
      ['coinflip', 'flipdice'],
      ['dice', 'flipdice'],
      ['cf', 'flipdice'],
      ['poll', 'polls'],
      ['?polls', 'polls'],
      ['?gamba', 'gamba'],
      ['nope', 'home'],
      ['constructor', 'home'],
      ['__proto__', 'home'],
      [undefined, 'home'],
      ['', 'home'],
    ];
    for (const [input, expected] of cases) expect(parseTopic(input)).toBe(expected);
  });
});

describe('help command', () => {
  function message(content: string) {
    return {
      content,
      createdTimestamp: 1000,
      author: { bot: false, id: '1' },
      webhookId: null,
      system: false,
      guild: { id: '2', members: { me: { id: '9' }, fetchMe: async () => ({ id: '9' }) } },
      guildId: '2',
      channel: {
        id: '3',
        type: 0,
        isDMBased: () => false,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
      },
      client,
      reply: vi.fn(async () => ({})),
    };
  }

  async function prefixHelp(content: string) {
    const msg = message(content);
    client.emit(Events.MessageCreate, msg as never);
    await vi.waitFor(() => expect(msg.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    return msg.reply.mock.calls[0] as unknown as [{ flags: number }];
  }

  it('?help replies publicly with the home page', async () => {
    const [options] = await prefixHelp('?help');
    expect(json(options)).toContain('Tincazz help');
    expect(json(options)).toContain('hp:menu:1');
    expect(options.flags & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(options.flags & MessageFlags.Ephemeral).toBeFalsy();
  });

  it('?help gamba opens that page, an unknown topic opens home', async () => {
    const [gamba] = await prefixHelp('?help gamba');
    expect(json(gamba)).toContain('Payouts');
    const [unknown] = await prefixHelp('?help whatever');
    expect(json(unknown)).toContain('Tincazz help');
  });

  it('/help replies with home, ephemeral', async () => {
    const interaction = makeChatInput(client, { commandName: 'help', userId: '1' });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(json(options)).toContain('Tincazz help');
    expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
  });

  it('/help topic:dice-ish choice opens that page', async () => {
    const interaction = makeChatInput(client, {
      commandName: 'help',
      userId: '1',
      options: { topic: 'flipdice' },
    });
    client.emit(Events.InteractionCreate, interaction as never);
    await vi.waitFor(() => expect(interaction.reply).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(json(interaction.reply.mock.calls[0])).toContain('Coinflip & dice');
  });
});

describe('help components', () => {
  async function click(interaction: ReturnType<typeof makeButton | typeof makeSelect>) {
    client.emit(Events.InteractionCreate, interaction as never);
    await wait(100);
  }

  it('moves the owner to the chosen page in place', async () => {
    const interaction = makeSelect(client, {
      customId: 'hp:menu:1',
      userId: '1',
      values: ['gamba'],
    });
    await click(interaction);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(json(interaction.update.mock.calls[0])).toContain('Payouts');
  });

  it('returns the owner home with the button', async () => {
    const interaction = makeButton(client, { customId: 'hp:home:1', userId: '1' });
    await click(interaction);
    expect(json(interaction.update.mock.calls[0])).toContain('Tincazz help');
  });

  it('gives someone else the page as their own ephemeral card', async () => {
    const interaction = makeSelect(client, {
      customId: 'hp:menu:1',
      userId: '5',
      values: ['coins'],
    });
    await click(interaction);
    expect(interaction.update).not.toHaveBeenCalled();
    const [options] = interaction.reply.mock.calls[0] as unknown as [{ flags: number }];
    expect(json(options)).toContain('hp:menu:5');
    expect(json(options)).toContain('hp:home:5');
    expect(options.flags & MessageFlags.Ephemeral).toBeTruthy();
    expect(options.flags & MessageFlags.IsComponentsV2).toBeTruthy();
  });

  it('ignores undecodable and mismatched interactions', async () => {
    const ignored = [
      makeButton(client, { customId: 'hp:nope:1', userId: '1' }),
      makeButton(client, { customId: 'hp:home:abc', userId: '1' }),
      makeButton(client, { customId: 'hp:menu:1', userId: '1' }),
      makeSelect(client, { customId: 'hp:menu:1', userId: '1', values: ['nope'] }),
      makeSelect(client, { customId: 'hp:menu:1', userId: '1', values: ['home'] }),
      makeSelect(client, { customId: 'hp:home:1', userId: '1', values: ['gamba'] }),
    ];
    for (const interaction of ignored) {
      await click(interaction);
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(interaction.update).not.toHaveBeenCalled();
    }
  });
});

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { coinflip, wager as flipWager } from '../coinflip/config.js';
import { dice, wager as diceWager } from '../dice/config.js';
import { payoutBps as dicePayoutBps } from '../dice/rules.js';
import { bailout, cashback, chatReward, collect, daily } from '../economy/config.js';
import type { BetLimits } from '../gamba/bet.js';
import { payoutBps, pot, wager } from '../gamba/config.js';
import { threeOfAKindOdds } from '../gamba/index.js';
import { gambaJackpotRoleId, outcomeEmoji } from '../gamba/outcomes.js';
import { giveaway, giveawayDurationHint } from '../giveaways/config.js';
import { accents, coins } from '../ui/index.js';
import { encodeHelpMenuId, encodeHelpPageId } from './custom-ids.js';
import { type HelpPage, topicInfo, topicPages } from './topics.js';

const betRange = ({ minBet, maxBet, defaultBet }: BetLimits) =>
  `${coins(minBet)} to ${coins(maxBet)} (${coins(defaultBet)} if you leave it out)`;

/** A payout multiplier from basis points: 20,000 -> `2x`, 59,400 -> `5.94x`. */
const times = (bps: number) => `${Number((bps / 10_000).toFixed(2))}x`;

const minutes = (ms: number) => ms / 60_000;
const seconds = (ms: number) => ms / 1000;

const betNote = 'Bets can be a number, `all`, `half` or `2.5k`.';

interface Page {
  title: string;
  body: string[];
}

function home(prefix: string): Page {
  return {
    title: '# 📖 Tincazz help',
    body: [
      `Pick a topic below to dive in. Prefix commands use \`${prefix}\`, and every game also works as a slash command.`,
      ...topicPages.map(
        (page) =>
          `### ${topicInfo[page].emoji} ${topicInfo[page].label}\n${homeSummary(page, prefix)}`,
      ),
      `-# Also: \`/ping\`, \`/help\`. Admins: \`/settings\` (log channels, auto-roles, game channels, honeypot) and \`/eco\`.`,
    ],
  };
}

function homeSummary(page: Exclude<HelpPage, 'home'>, prefix: string): string {
  switch (page) {
    case 'games':
      return `\`/gamba\`, \`/coinflip\`, \`/dice\` and their \`${prefix}\` forms`;
    case 'images':
      return 'Add speech bubbles or captions, or convert images to GIF';
    case 'coins':
      return `Earn ${coins(daily.base)}+ a day, check your balance and the leaderboard`;
    case 'gamba':
      return `Three reels, a ${times(payoutBps.cppTriple)} jackpot and a pot of ${coins(pot.seed)}+`;
    case 'flipdice':
      return 'Flip against the bot or a member, or call the roll of two dice';
    case 'giveaways':
      return 'Find current prize draws in this server';
  }
}

function games(prefix: string): Page {
  return {
    title: '# 🎰 Games',
    body: [
      [
        `### 🍒 Gamba`,
        `\`/gamba [bet]\` or \`${prefix}gamba [bet]\`, e.g. \`${prefix}gamba 50\``,
        `Bet ${betRange(wager)}. Three reels, win on pairs and triples. See **Gamba** for the payouts.`,
      ].join('\n'),
      [
        '### 🪙 Coinflip',
        `\`/coinflip bot|challenge|open\` or \`${prefix}coinflip\` (aliases \`${prefix}cf\`, \`${prefix}flip\`), e.g. \`${prefix}cf 100 tails\``,
        `Bet ${betRange(flipWager)}. Against the bot, a member, or anyone.`,
      ].join('\n'),
      [
        '### 🎲 Dice',
        `\`/dice [bet] [on]\` or \`${prefix}dice\` (alias \`${prefix}roll\`), e.g. \`${prefix}dice =12 50\``,
        `Bet ${betRange(diceWager)}. Call high, low, seven, doubles or an exact total.`,
      ].join('\n'),
      `-# ${betNote} Games may be limited to certain channels by the admins.`,
    ],
  };
}

function images(prefix: string): Page {
  return {
    title: '# 🖼️ Images',
    body: [
      [
        '### 💬 Speech bubble',
        `\`/bubble\` or \`${prefix}bubble [style]\` puts a speech bubble on an image or GIF.`,
        `Attach one, paste a link, name a user to use their avatar, or **reply** to any message: text becomes a Discord-style screenshot. E.g. reply with \`${prefix}bubble white\`.`,
        'Or right-click a message, then **Apps**, then **Bubble message**, or use `/bubble message:<link>`.',
      ].join('\n'),
      [
        '### 🏷️ Caption',
        `\`/caption\` or \`${prefix}caption <text>\` adds a white caption bar above an image or GIF.`,
        `Same sources as the bubble, e.g. \`${prefix}caption when the build passes\`, or **reply** to a message with it: text becomes a screenshot under the caption.`,
        'Or right-click a message, then **Apps**, then **Caption message** (it asks for the text), or use `/caption message:<link>`.',
      ].join('\n'),
      [
        '### Convert to GIF',
        `Use \`/gif\` with an attachment or link, or \`${prefix}gif\` with an attachment, link or reply to an image. Save the returned \`image.gif\` attachment.`,
      ].join('\n'),
      '-# Links work from Discord, Tenor and Giphy. Large images may be resized and large animations may lose frames.',
    ],
  };
}

function coinsPage(prefix: string): Page {
  return {
    title: '# 🪙 Coins',
    body: [
      [
        '### Earn',
        `\`/daily\`: ${coins(daily.base)} coins plus ${coins(daily.perStreakDay)} per streak day (up to ${daily.streakCap} days)`,
        `Plus ${cashback.percent}% cashback on yesterday's gambling losses (up to ${coins(cashback.max)})`,
        `\`/collect\`: ${coins(collect.perHour)} coins per hour, stacking for up to ${collect.maxHours} hours`,
        `Chatting: ${coins(chatReward.amount)} coins per message, at most once every ${seconds(chatReward.cooldownMs)} seconds`,
      ].join('\n'),
      [
        '### Broke?',
        `\`/bailout\`: ${coins(bailout.base)} coins plus ${coins(bailout.perStreakDay)} per daily streak day when you hold under ${coins(bailout.belowBalance)} coins, every ${minutes(bailout.cooldownMs)} minutes`,
      ].join('\n'),
      [
        '### Where you stand',
        `\`/balance\` (or \`${prefix}bal\`, \`${prefix}balance\`): your coins`,
        '`/coins history`: privately see your latest 10 coin changes in this server',
        '`/stats`: your profile and recent plays',
        '`/leaderboard`: the richest players and more boards',
      ].join('\n'),
    ],
  };
}

function gambaPage(prefix: string): Page {
  const yt = outcomeEmoji('head');
  const python = outcomeEmoji('python');
  const cpp = outcomeEmoji('cpp');
  const jackpotOdds = threeOfAKindOdds(['cpp', 'cpp', 'cpp']);
  const pythonOdds = threeOfAKindOdds(['python', 'python', 'python']);
  const share = pot.shareBps.pythonTriple / 100;
  return {
    title: '# 🍒 Gamba',
    body: [
      `\`/gamba [bet]\` or \`${prefix}gamba [bet]\`. Bet ${betRange(wager)}.`,
      [
        '### Payouts (times your bet)',
        `${yt}${yt} any pair of the usual emotes: **${times(payoutBps.ytPair)}**`,
        `${python}${python} python pair: **${times(payoutBps.pythonPair)}**`,
        `${cpp}${cpp} cpp pair: **${times(payoutBps.cppPair)}**`,
        `${yt}${yt}${yt} any triple of the usual emotes: **${times(payoutBps.ytTriple)}**`,
        `${python}${python}${python} python triple (1 in ${coins(pythonOdds ?? 0)}): **${times(payoutBps.pythonTriple)}** + ${share}% of the pot above ${coins(pot.seed)}, up to ${pot.maxWinPerBet.pythonTriple}x your bet`,
        `${cpp}${cpp}${cpp} **JACKPOT** (1 in ${coins(jackpotOdds ?? 0)}): **${times(payoutBps.cppTriple)}** + the pot, up to ${pot.maxWinPerBet.cppTriple}x your bet, and the <@&${gambaJackpotRoleId}> role`,
      ].join('\n'),
      [
        '### The pot',
        `It starts at ${coins(pot.seed)}. Bets over ${coins(pot.contributionAbove)} add ${pot.contributionPercent}% to it, and coinflip and dice feed it too.`,
        `Bets under ${coins(pot.fullShareBet)} win a proportional share of it; the rest stays for the next player.`,
      ].join('\n'),
      `-# \`/gamba\` results have **Spin again**, which repeats your bet, and **Double**, which doubles it when you can afford twice the bet and it stays within ${coins(wager.maxBet)}. The \`?gamba\` reply has no buttons.`,
    ],
  };
}

/** `=2 or =12: 35.64x`-style lines: the exact totals grouped by what they pay. */
function exactLines(): string[] {
  const groups = new Map<number, number[]>();
  for (let total = 2; total <= 12; total++) {
    if (total === 7) continue;
    const bps = dicePayoutBps({ kind: 'exact', target: total });
    groups.set(bps, [...(groups.get(bps) ?? []), total]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(
      ([bps, totals]) => `\`${totals.map((total) => `=${total}`).join('` `')}\`: **${times(bps)}**`,
    );
}

function flipDice(prefix: string): Page {
  const hi = dicePayoutBps({ kind: 'high' });
  const seven = dicePayoutBps({ kind: 'seven' });
  const doubles = dicePayoutBps({ kind: 'doubles' });
  return {
    title: '# 🎲 Coinflip & dice',
    body: [
      [
        '### 🪙 Coinflip',
        `\`/coinflip\` or \`${prefix}cf [bet] [heads|tails]\`. Bet ${betRange(flipWager)}.`,
        `**bot**: flip against the bot, e.g. \`${prefix}cf 100 tails\``,
        `**challenge**: \`/coinflip challenge @member\` or \`${prefix}cf @member 100\`, open for ${seconds(coinflip.expiryMs.challenge)} seconds`,
        `**open**: \`${prefix}cf open 100\`, anyone can accept within ${seconds(coinflip.expiryMs.open)} seconds`,
        `The winner takes both stakes minus a ${coinflip.rakePercent}% rake that goes to the gamba pot (against the bot the rake comes off a win only). Challenge results have a **Rematch** button.`,
      ].join('\n'),
      [
        '### 🎲 Dice',
        `\`/dice\` or \`${prefix}dice [bet] [call]\`, e.g. \`${prefix}dice =12 50\`. Bet ${betRange(diceWager)}.`,
        `\`high\` (8-12) or \`low\` (2-6): **${times(hi)}**`,
        `\`seven\`: **${times(seven)}** · \`doubles\`: **${times(doubles)}**`,
        `Exact total (\`=2\` to \`=12\`, not 7): ${exactLines().join(' · ')}`,
        `Payouts return ${dice.returnBps / 100}% on average. The ${dice.edgePercent}% edge feeds the gamba pot.`,
        '**Roll again** repeats the roll, **Double** doubles the bet (up to the maximum) and **Change call** picks the call for the next roll (the card shows `Next:`). Only the player who rolled can use them.',
      ].join('\n'),
      `-# ${betNote}`,
    ],
  };
}

function giveawaysPage(): Page {
  return {
    title: '# 🎁 Giveaways',
    body: [
      'Staff can cancel a pending draw in its original channel with `/giveaway cancel`.',
      '`/giveaway list` shows active giveaways you can see in this server. Use the page option to see more.',
      `React with ${giveaway.emoji} on the giveaway post to enter. Remove your reaction to withdraw. Each person gets one entry. The host and bots are excluded.`,
      'Staff with Manage Messages at the server level and in the channel can run `/giveaway create` with a prize and a duration. ' +
        giveawayDurationHint,
      'The listed time is the earliest draw time. Tincazz reads entries when the draw runs and edits the post with the result.',
    ],
  };
}

const builders: Record<HelpPage, (prefix: string) => Page> = {
  home,
  games,
  images,
  coins: coinsPage,
  gamba: gambaPage,
  flipdice: flipDice,
  giveaways: giveawaysPage,
};

/**
 * One page of `/help`: a title and sections, a topic menu with the current page marked and, on
 * every page but home, a Home button. Every number comes from the feature configs.
 */
export function helpPage(page: HelpPage, prefix: string, ownerId: string): ContainerBuilder {
  const { title, body } = builders[page](prefix);
  const container = new ContainerBuilder()
    .setAccentColor(accents.brand)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );
  body.forEach((text, index) => {
    if (index > 0 && page === 'home' && index < body.length - 1) {
      container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small),
      );
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(encodeHelpMenuId(ownerId))
    .setPlaceholder('Jump to a topic')
    .addOptions(
      topicPages.map((value) => ({
        label: topicInfo[value].label,
        description: topicInfo[value].description,
        emoji: topicInfo[value].emoji,
        value,
        default: value === page,
      })),
    );
  container
    .addSeparatorComponents(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    )
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  if (page !== 'home') {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(encodeHelpPageId('home', ownerId))
          .setLabel('Home')
          .setEmoji('🏠')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return container;
}

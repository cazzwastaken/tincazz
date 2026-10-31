import type { ContainerBuilder } from 'discord.js';
import { wager as flipWager } from '../coinflip/config.js';
import { wager as diceWager } from '../dice/config.js';
import { bailout, cashback, chatReward, collect, daily } from '../economy/config.js';
import type { BetLimits } from '../gamba/bet.js';
import { wager } from '../gamba/config.js';
import { accents, card, coins } from '../ui/index.js';

function betRange({ minBet, maxBet, defaultBet }: BetLimits): string {
  return `${coins(minBet)} to ${coins(maxBet)}, ${coins(defaultBet)} when you leave the bet out`;
}

/**
 * The `/help` card. Every number comes from the feature configs so it cannot drift from the
 * rules; a test checks that each `misc` (game) command is listed.
 */
export function helpCard(prefix: string): ContainerBuilder {
  const bailoutMinutes = bailout.cooldownMs / 60_000;
  return card(
    accents.brand,
    '# Tincazz help',
    [
      '## Games',
      `\`/gamba\` & \`${prefix}gamba\`: spin the reels, e.g. \`${prefix}gamba 50\``,
      `\`/coinflip\` & \`${prefix}cf\`: flip against the bot or a member, e.g. \`${prefix}cf 100 tails\``,
      `\`/dice\` & \`${prefix}dice\`: call the roll of two dice, e.g. \`${prefix}dice =12 50\``,
    ].join('\n'),
    [
      '## Coins',
      `\`/daily\`: ${coins(daily.base)} coins plus ${coins(daily.perStreakDay)} per streak day (up to ${daily.streakCap} days), and ${cashback.percent}% cashback on yesterday's losses (up to ${coins(cashback.max)})`,
      `\`/collect\`: ${coins(collect.perHour)} coins per hour, stacking for up to ${collect.maxHours} hours`,
      `\`/bailout\`: ${coins(bailout.base)} coins plus ${coins(bailout.perStreakDay)} per daily streak day when you hold under ${coins(bailout.belowBalance)} coins, every ${bailoutMinutes} minutes`,
      `Chatting earns ${coins(chatReward.amount)} coins per message, at most once every ${chatReward.cooldownMs / 1000} seconds`,
      `\`/balance\` (or \`${prefix}bal\`), \`/stats\` and \`/leaderboard\` show where you stand`,
    ].join('\n'),
    [
      '## Bets',
      `Gamba: ${betRange(wager)}`,
      `Coinflip: ${betRange(flipWager)}`,
      `Dice: ${betRange(diceWager)}`,
      'Bets can be a number, all, half or 2.5k',
    ].join('\n'),
  );
}

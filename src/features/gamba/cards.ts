import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import { bailout } from '../economy/config.js';
import { InsufficientFundsError } from '../economy/errors.js';
import { accents, card, coins } from '../ui/index.js';
import { InvalidBetError } from './bet.js';
import { type PayoutTier, wager } from './config.js';
import { encodeSpinId } from './custom-ids.js';
import { type Spin, threeOfAKindOdds, type WagerSpin } from './index.js';
import { outcomeEmoji } from './outcomes.js';

export const tierLabels: Record<PayoutTier, string> = {
  none: 'No match',
  ytPair: 'Pair',
  pythonPair: 'Python pair',
  cppPair: 'C++ pair',
  ytTriple: 'Triple!',
  pythonTriple: 'Python x3!',
  cppTriple: 'JACKPOT',
};

export const notYourSpin = "This isn't your spin. Use `/gamba` to get your own.";

export const expiredSpin = 'This spin is old. Use the buttons on your latest `/gamba` card.';

const reelsHeading = (spin: Spin) => `# ${spin.reels.map(outcomeEmoji).join(' ')}`;

function button(label: string, customId: string, style: ButtonStyle): ButtonBuilder {
  return new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style);
}

export function wagerCard(userId: string, spin: WagerSpin): ContainerBuilder {
  const { tier, payoutBps } = spin.evaluation;
  const accent = spin.potWon > 0 ? accents.gold : spin.payout > 0 ? accents.win : accents.loss;
  const outcome =
    tier === 'none'
      ? `**${tierLabels[tier]}**`
      : `**${tierLabels[tier]}** · ${payoutBps / 10_000}x`;
  const net = spin.payout - spin.bet;
  const sign = net >= 0 ? '+' : '-';
  const texts = [
    reelsHeading(spin),
    outcome,
    `Bet ${coins(spin.bet)} → ${coins(spin.payout)} (${sign}${coins(Math.abs(net))})`,
  ];
  if (spin.potWon > 0) {
    texts.push(`+${coins(spin.potWon)} from the pot`);
  }
  texts.push(`-# <@${userId}> · balance ${coins(spin.balance)} · pot ${coins(spin.pot)}`);

  const buttons = [
    button(
      'Spin again',
      encodeSpinId({ action: 'again', userId, bet: spin.bet }),
      ButtonStyle.Primary,
    ),
  ];
  const doubled = spin.bet * 2;
  if (doubled <= wager.maxBet && doubled <= spin.balance) {
    buttons.push(
      button(
        `Double (${coins(doubled)})`,
        encodeSpinId({ action: 'double', userId, bet: doubled }),
        ButtonStyle.Success,
      ),
    );
  }
  return card(accent, ...texts).addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons),
  );
}

export function announcementCard(
  userId: string,
  spin: Spin,
  roleAssigned?: boolean,
  jackpotRoleId?: string,
): ContainerBuilder {
  const emoji = outcomeEmoji(spin.reels[0]);
  const texts = [`## <@${userId}> hit ${emoji} x3!`];
  texts.push(`Won ${coins(spin.payout)} on a ${coins(spin.bet)} bet`);
  if (spin.potWon > 0) {
    texts.push(`+${coins(spin.potWon)} from the pot`);
  }
  if (spin.evaluation.result === 'jackpot' && jackpotRoleId !== undefined) {
    const note = roleAssigned === false ? " (couldn't assign the role, tell a mod)" : '';
    texts.push(`You are a pro! You just won <@&${jackpotRoleId}>${note}`);
  }
  const odds = threeOfAKindOdds(spin.reels);
  if (odds !== undefined) {
    texts.push(`-# Odds: 1 in ${coins(odds)}`);
  }
  return card(accents.gold, ...texts);
}

/**
 * Up to 20 characters of what the user typed, safe to echo inside a code span: one line, no
 * backticks, no control or invisible (zero-width, bidi) characters, and no split surrogate pairs.
 */
export function echoBetInput(input: string): string {
  const text = input
    .replace(/\s+/gu, ' ')
    .replace(/[\p{C}`]/gu, '')
    .trim();
  return [...text].slice(0, 20).join('').trim();
}

export function spinErrorText(error: unknown): string | undefined {
  if (error instanceof InvalidBetError) {
    const { minBet, maxBet } = error.limits;
    if (error.kind === 'range') {
      return `Bets go from ${coins(minBet)} to ${coins(maxBet)}.`;
    }
    const shown = echoBetInput(error.input);
    const subject = shown === '' ? 'That' : `\`${shown}\``;
    return `${subject} isn't a bet. Use a number from ${coins(minBet)} to ${coins(maxBet)}, \`all\`, \`half\` or \`2.5k\`.`;
  }
  if (error instanceof InsufficientFundsError) {
    const hint =
      error.balance < bailout.belowBalance ? '`/bailout` is available.' : 'Try a smaller bet.';
    return `You have ${coins(error.balance)} coins. ${hint}`;
  }
  return undefined;
}

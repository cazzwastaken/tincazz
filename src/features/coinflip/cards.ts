import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import type { FlipSide, pendingCoinflipChallenges } from '../../db/schema.js';
import { spinErrorText } from '../gamba/index.js';
import { accents, card, coins, discordTime } from '../ui/index.js';
import { type FlipStage, flipAnimation } from './config.js';
import {
  type ChallengeAction,
  type ChallengeId,
  encodeChallengeId,
  encodeFlipAgainId,
  encodeRematchId,
} from './custom-ids.js';
import { ChallengeTakenError, ShortStakeError } from './errors.js';
import { otherSide } from './flip.js';
import type { BotFlip, SettledChallenge } from './play.js';

export type ChallengeView = Omit<ChallengeId, 'kind' | 'action'>;

export const notYourFlip = "This isn't your flip. Use `/coinflip bot` to flip your own.";
export const notYourChallenge = "This challenge isn't for you.";
export const challengeTaken = 'Someone already took this challenge.';
export const cannotChallengeSelf = "You can't challenge yourself.";
export const cannotChallengeBot = "Bots don't flip coins. Use `/coinflip bot`.";
export const memberNotFound = "I can't find that member here.";
export const rematchTaken = 'A rematch is already on.';

const sideLabel = (side: FlipSide) => (side === 'heads' ? 'Heads' : 'Tails');

function button(label: string, customId: string, style: ButtonStyle): ButtonBuilder {
  return new ButtonBuilder().setLabel(label).setCustomId(customId).setStyle(style);
}

export function botFlipCard(userId: string, flip: BotFlip): ContainerBuilder {
  const net = flip.won ? flip.credited - flip.bet : -flip.bet;
  return card(
    flip.won ? accents.win : accents.loss,
    `# 🪙 ${sideLabel(flip.result)}`,
    `Called **${sideLabel(flip.side)}** · ${net >= 0 ? '+' : '-'}${coins(Math.abs(net))}`,
    `-# <@${userId}> · balance ${coins(flip.balance)} · pot ${coins(flip.pot)}`,
  ).addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(
        'Flip again',
        encodeFlipAgainId({ userId, bet: flip.bet, side: flip.side }),
        ButtonStyle.Primary,
      ),
    ),
  );
}

const spinGlyphs = ['◐', '◓', '◑', '◒'] as const;

/**
 * One cosmetic frame of a coin in the air: no buttons. The edge frame shows the side that loses
 * the wobble, so the result card never contradicts it, and claims nothing about the outcome.
 */
export function flipFrame(stage: FlipStage, caption: string, result: FlipSide): ContainerBuilder {
  switch (stage) {
    case 'toss':
      return card(accents.brand, '# 🪙 ⤴', caption, '-# tossed');
    case 'spin': {
      const glyph = spinGlyphs[Math.floor(Math.random() * spinGlyphs.length)];
      return card(accents.brand, `# ${glyph}`, caption, '-# spinning');
    }
    case 'fall':
      return card(accents.brand, '# 🪙 ⤵', caption, '-# falling');
    case 'edge':
      return card(
        accents.gold,
        `# 🪙 ${sideLabel(otherSide(result))}…?`,
        caption,
        '-# teetering on its edge',
      );
  }
}

function flippingFrames(caption: string, result: FlipSide): ContainerBuilder[] {
  return flipAnimation.stages.map((stage) => flipFrame(stage, caption, result));
}

export function botFlipFrames(userId: string, flip: Pick<BotFlip, 'bet' | 'side' | 'result'>) {
  return flippingFrames(
    `<@${userId}> called **${sideLabel(flip.side)}** · ${coins(flip.bet)}`,
    flip.result,
  );
}

export function challengeFlipFrames(view: ChallengeView, acceptorId: string, result: FlipSide) {
  return flippingFrames(
    `<@${view.challengerId}> vs <@${acceptorId}> · ${coins(view.bet)} each`,
    result,
  );
}

export function challengeCard(view: ChallengeView): ContainerBuilder {
  const { challengerId, opponentId, bet, side, expiresAt } = view;
  const who =
    opponentId === undefined
      ? `Anyone with ${coins(bet)} coins can accept.`
      : `<@${opponentId}> can accept.`;
  const id = (action: ChallengeAction) => encodeChallengeId({ ...view, action });
  const buttons = [button('Accept', id('accept'), ButtonStyle.Success)];
  if (opponentId !== undefined) {
    buttons.push(button('Decline', id('decline'), ButtonStyle.Danger));
  }
  buttons.push(button('Cancel', id('cancel'), ButtonStyle.Secondary));
  return card(
    accents.brand,
    '## Coinflip challenge',
    `<@${challengerId}> bets **${coins(bet)}** on ${sideLabel(side).toLowerCase()}`,
    who,
    `Expires ${discordTime(expiresAt)}`,
  ).addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons));
}

export function challengeResultCard(
  view: ChallengeView,
  settled: SettledChallenge,
): ContainerBuilder {
  // An open challenge has no opponent in the view, so the acceptor comes from the settled flip.
  const acceptorId = settled.winnerId === view.challengerId ? settled.loserId : settled.winnerId;
  const rematch = encodeRematchId({
    challengerId: view.challengerId,
    acceptorId,
    bet: view.bet,
    challengerSide: view.side,
  });
  return card(
    accents.gold,
    `# 🪙 ${sideLabel(settled.result)}`,
    `<@${settled.winnerId}> wins **${coins(settled.credited)}**`,
    `-# rake ${coins(settled.rake)} to the pot · pot ${coins(settled.pot)}`,
  ).addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button('Rematch', rematch, ButtonStyle.Secondary),
    ),
  );
}

export type ChallengeClosedReason = NonNullable<
  (typeof pendingCoinflipChallenges.$inferSelect)['closedReason']
>;

export function challengeClosedCard(
  view: ChallengeView,
  reason: ChallengeClosedReason,
): ContainerBuilder {
  const texts: Record<ChallengeClosedReason, string> = {
    expired: 'Challenge expired.',
    declined: `<@${view.opponentId}> declined.`,
    cancelled: `<@${view.challengerId}> cancelled.`,
    'challenger-short': `<@${view.challengerId}> can't cover the bet anymore.`,
  };
  return card(accents.loss, texts[reason]);
}

export function flipErrorText(error: unknown): string | undefined {
  if (error instanceof ShortStakeError) {
    return `You need ${coins(error.needed)} coins to accept. You have ${coins(error.balance)}.`;
  }
  if (error instanceof ChallengeTakenError) {
    return challengeTaken;
  }
  return spinErrorText(error);
}

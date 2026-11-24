import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { type ButtonInteraction, ComponentType, type Message } from 'discord.js';
import { end, play, stillRolling, tryBegin, updateDisplay } from '../features/animation/index.js';
import {
  assertChallengeCapacity,
  botFlipCard,
  botFlipFrames,
  type ChallengeId,
  type ChallengeRequest,
  ChallengeTakenError,
  type ChallengeView,
  type CoinflipId,
  challengeCard,
  challengeFlipFrames,
  challengeResultCard,
  challengeTaken,
  closeChallengeCard,
  coinflip,
  decodeCoinflipId,
  type FlipAgainId,
  flipErrorText,
  forgetChallengeCard,
  isChallengeCardClosed,
  isChallengeSettled,
  notYourChallenge,
  notYourFlip,
  otherSide,
  type RematchId,
  rematchTaken,
  reopen,
  ShortStakeError,
  settleBotFlip,
  settleChallenge,
  trackChallengeCard,
  tryClose,
} from '../features/coinflip/index.js';
import { gameChannelDenied } from '../features/settings/index.js';
import { cardReply, errorReply, withoutActionRows } from '../features/ui/index.js';

export class CoinflipButtonsHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: ButtonInteraction) {
    const id = decodeCoinflipId(interaction.customId);
    return id ? this.some(id) : this.none();
  }

  public override async run(interaction: ButtonInteraction, id: CoinflipId) {
    const denied = gameChannelDenied(
      this.container.db,
      interaction.guildId as string,
      interaction.channelId,
      interaction.channel,
    );
    if (denied) return interaction.reply(errorReply(denied));
    // Errors keep the card as it was: a stale button only gets a private explanation.
    try {
      if (id.kind === 'again') {
        return await this.flipAgain(interaction, id);
      }
      if (id.kind === 'rematch') {
        return await this.rematch(interaction, id);
      }
      return await this.answer(interaction, id);
    } catch (error) {
      const text = flipErrorText(error);
      if (text === undefined) {
        throw error;
      }
      return interaction.reply(errorReply(text));
    }
  }

  private async flipAgain(interaction: ButtonInteraction, id: FlipAgainId) {
    const userId = interaction.user.id;
    if (userId !== id.userId) {
      return interaction.reply(errorReply(notYourFlip));
    }
    if (!tryBegin(userId)) {
      return interaction.reply(errorReply(stillRolling));
    }
    try {
      const flip = settleBotFlip(
        this.container.db,
        { guildId: interaction.guildId as string, userId, bet: String(id.bet), side: id.side },
        Date.now(),
      );
      return await play(
        updateDisplay(interaction),
        botFlipFrames(userId, flip),
        botFlipCard(userId, flip),
        { channelId: interaction.channelId },
      );
    } finally {
      end(userId);
    }
  }

  /**
   * Turns a finished challenge into a new one from the presser to the other player. Single use
   * per result message; no coins move and no busy lock is taken, as when a challenge is created.
   */
  private async rematch(interaction: ButtonInteraction, id: RematchId) {
    const clickerId = interaction.user.id;
    if (clickerId !== id.challengerId && clickerId !== id.acceptorId) {
      return interaction.reply(errorReply(notYourChallenge));
    }
    // Before the key is claimed, so a refused rematch can be pressed again once a slot is free.
    assertChallengeCapacity(interaction.guildId as string, clickerId);
    const key = `rematch:${interaction.message.id}`;
    if (!tryClose(key)) {
      return interaction.reply(errorReply(rematchTaken));
    }

    // Retire the button first, so the result card cannot offer a rematch that is already on.
    const shown = interaction.message.components[0]?.toJSON();
    try {
      if (shown?.type === ComponentType.Container) {
        await interaction.update(cardReply(withoutActionRows(shown)));
      } else {
        await interaction.deferUpdate();
      }
    } catch (error) {
      // Nothing was sent, so the players can press again.
      reopen(key);
      throw error;
    }

    const isChallenger = clickerId === id.challengerId;
    const otherId = isChallenger ? id.acceptorId : id.challengerId;
    const now = Date.now();
    const view: ChallengeView = {
      challengerId: clickerId,
      opponentId: otherId,
      bet: id.bet,
      side: isChallenger ? id.challengerSide : otherSide(id.challengerSide),
      expiresAt: now + coinflip.expiryMs.challenge,
    };
    let sent: Message;
    try {
      sent = await interaction.message.reply({
        ...cardReply(challengeCard(view)),
        allowedMentions: { users: [otherId] },
      });
    } catch (error) {
      this.container.logger.error(
        `coinflip: could not send the rematch for ${interaction.message.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    trackChallengeCard(
      interaction.guildId as string,
      interaction.channelId,
      sent.id,
      view,
      (closed) => sent.edit(cardReply(closed)),
    );
  }

  private async answer(interaction: ButtonInteraction, id: ChallengeId) {
    const clickerId = interaction.user.id;
    const messageId = interaction.message.id;
    const view: ChallengeView = {
      challengerId: id.challengerId,
      opponentId: id.opponentId,
      bet: id.bet,
      side: id.side,
      expiresAt: id.expiresAt,
    };

    if (id.action === 'accept') {
      const allowed =
        id.opponentId === undefined ? clickerId !== id.challengerId : clickerId === id.opponentId;
      if (!allowed) {
        return interaction.reply(errorReply(notYourChallenge));
      }
      // Before the challenge is closed, so a busy acceptor leaves the card live for a later click.
      if (!tryBegin(clickerId)) {
        return interaction.reply(errorReply(stillRolling));
      }
      try {
        return await this.accept(interaction, id, view, messageId);
      } finally {
        end(clickerId);
      }
    }

    const owner = id.action === 'decline' ? id.opponentId : id.challengerId;
    if (clickerId !== owner) {
      return interaction.reply(errorReply(notYourChallenge));
    }
    if (
      isChallengeCardClosed(messageId) ||
      isChallengeSettled(this.container.db, messageId) ||
      !tryClose(messageId)
    ) {
      return interaction.reply(errorReply(challengeTaken));
    }
    const reason =
      Date.now() >= id.expiresAt ? 'expired' : id.action === 'decline' ? 'declined' : 'cancelled';
    return closeChallengeCard(messageId, view, reason, (closed) =>
      interaction.update(cardReply(closed)),
    );
  }

  private async accept(
    interaction: ButtonInteraction,
    id: ChallengeId,
    view: ChallengeView,
    messageId: string,
  ) {
    if (
      isChallengeCardClosed(messageId) ||
      isChallengeSettled(this.container.db, messageId) ||
      !tryClose(messageId)
    ) {
      return interaction.reply(errorReply(challengeTaken));
    }
    if (Date.now() >= id.expiresAt) {
      return closeChallengeCard(messageId, view, 'expired', (closed) =>
        interaction.update(cardReply(closed)),
      );
    }

    const request: ChallengeRequest = {
      guildId: interaction.guildId as string,
      messageId,
      mode: id.opponentId === undefined ? 'open' : 'challenge',
      challengerId: id.challengerId,
      acceptorId: interaction.user.id,
      bet: id.bet,
      challengerSide: id.side,
    };
    let settled: ReturnType<typeof settleChallenge>;
    try {
      settled = settleChallenge(this.container.db, request, Date.now());
    } catch (error) {
      if (error instanceof ShortStakeError && error.who === 'challenger') {
        return closeChallengeCard(messageId, view, 'challenger-short', (closed) =>
          interaction.update(cardReply(closed)),
        );
      }
      if (error instanceof ChallengeTakenError) {
        return interaction.reply(errorReply(challengeTaken));
      }
      // The acceptor can try again once funded (or someone else can accept), so the card stays
      // live, with its original expiry handler armed again for the time that is left.
      reopen(messageId, Math.max(0, id.expiresAt - Date.now()));
      throw error;
    }
    const result = await play(
      updateDisplay(interaction),
      challengeFlipFrames(view, request.acceptorId, settled.result),
      challengeResultCard(view, settled),
      { channelId: interaction.channelId },
    );
    forgetChallengeCard(messageId);
    return result;
  }
}

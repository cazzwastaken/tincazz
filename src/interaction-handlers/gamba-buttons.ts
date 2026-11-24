import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction, ContainerBuilder } from 'discord.js';
import { play, runAnimatedGame, stillRolling, updateDisplay } from '../features/animation/index.js';
import {
  assignJackpotRole,
  decodeSpinId,
  expiredSpin,
  isActiveCard,
  notYourSpin,
  type SpinButtonId,
  spin,
  spinErrorText,
  spinFrames,
} from '../features/gamba/index.js';
import { gameChannelDenied } from '../features/settings/index.js';
import { cardReply, errorReply } from '../features/ui/index.js';

export class GambaButtonsHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: ButtonInteraction) {
    const id = decodeSpinId(interaction.customId);
    return id ? this.some(id) : this.none();
  }

  public override async run(interaction: ButtonInteraction, id: SpinButtonId) {
    const denied = gameChannelDenied(
      this.container.db,
      interaction.guildId as string,
      interaction.channelId,
      interaction.channel,
    );
    if (denied) return interaction.reply(errorReply(denied));
    const userId = interaction.user.id;
    if (userId !== id.userId) {
      return interaction.reply(errorReply(notYourSpin));
    }
    if (!isActiveCard(userId, interaction.message.id)) {
      return interaction.reply(errorReply(expiredSpin));
    }

    return runAnimatedGame({
      userId,
      busy: () => interaction.reply(errorReply(stillRolling)),
      settle: () =>
        spin(
          this.container.db,
          { guildId: interaction.guildId as string, userId, bet: String(id.bet) },
          Date.now(),
          {
            assignJackpotRole: (roleId) =>
              assignJackpotRole(
                interaction.inCachedGuild() ? interaction.member : null,
                userId,
                roleId,
              ),
          },
        ),
      errorText: spinErrorText,
      // The card stays as it was: a stale button only gets a private explanation.
      reject: (text) => interaction.reply(errorReply(text)),
      show: async (messages) => {
        // Settled above, so the frames only dress up a result already decided.
        await play(updateDisplay(interaction), spinFrames(userId, messages.bet), messages.card, {
          channelId: interaction.channelId,
        });
        await this.announce(userId, interaction, messages.announcement);
      },
    });
  }

  private async announce(
    userId: string,
    interaction: ButtonInteraction,
    announcement: ContainerBuilder | undefined,
  ) {
    if (!announcement) {
      return;
    }
    // Its own try: a failed announcement is logged and never undoes the updated card.
    try {
      await interaction.message.reply({
        ...cardReply(announcement),
        allowedMentions: { users: [userId] },
      });
    } catch (error) {
      this.container.logger.error(
        `gamba: could not send the announcement for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

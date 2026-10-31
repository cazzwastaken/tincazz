import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction, ContainerBuilder } from 'discord.js';
import {
  assignJackpotRole,
  decodeSpinId,
  expiredSpin,
  isActiveCard,
  notYourSpin,
  type SpinButtonId,
  spin,
  spinErrorText,
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

    let messages: Awaited<ReturnType<typeof spin>>;
    try {
      messages = await spin(
        this.container.db,
        {
          guildId: interaction.guildId as string,
          userId,
          bet: String(id.bet),
        },
        Date.now(),
        {
          assignJackpotRole: () =>
            assignJackpotRole(interaction.inCachedGuild() ? interaction.member : null, userId),
        },
      );
    } catch (error) {
      const text = spinErrorText(error);
      if (text === undefined) {
        throw error;
      }
      // The card stays as it was: a stale button only gets a private explanation.
      return interaction.reply(errorReply(text));
    }

    await interaction.update(cardReply(messages.card));
    const { announcement } = messages;
    if (!announcement) {
      return;
    }
    // Its own try: a failed announcement is logged and never undoes the updated card.
    try {
      await interaction.message.reply({
        ...cardReply(announcement as ContainerBuilder),
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

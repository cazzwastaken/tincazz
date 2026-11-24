import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { end, play, stillRolling, tryBegin, updateDisplay } from '../features/animation/index.js';
import {
  type DiceId,
  decodeDiceId,
  diceErrorText,
  notYourRoll,
  rollFrames,
  rollResult,
  settleRoll,
} from '../features/dice/index.js';
import { gameChannelDenied } from '../features/settings/index.js';
import { errorReply } from '../features/ui/index.js';

export class DiceButtonsHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: ButtonInteraction) {
    const id = decodeDiceId(interaction.customId);
    return id && id.kind !== 'call' ? this.some(id) : this.none();
  }

  /** Roll again and Double: the owner rolls the bet in the id (doubled for Double) on the same card. */
  public override async run(interaction: ButtonInteraction, id: DiceId) {
    const denied = gameChannelDenied(
      this.container.db,
      interaction.guildId as string,
      interaction.channelId,
      interaction.channel,
    );
    if (denied) return interaction.reply(errorReply(denied));
    const userId = interaction.user.id;
    if (userId !== id.userId) {
      return interaction.reply(errorReply(notYourRoll));
    }
    if (!tryBegin(userId)) {
      return interaction.reply(errorReply(stillRolling));
    }
    try {
      const guildId = interaction.guildId as string;
      const roll = settleRoll(
        this.container.db,
        { guildId, userId, bet: String(id.bet), call: id.call },
        Date.now(),
      );
      return await play(
        updateDisplay(interaction),
        await rollFrames(userId, roll),
        await rollResult(userId, roll),
        { channelId: interaction.channelId },
      );
    } catch (error) {
      // A stale button keeps the card as it was and only gets a private explanation.
      const text = diceErrorText(error);
      if (text === undefined) {
        throw error;
      }
      return interaction.reply(errorReply(text));
    } finally {
      end(userId);
    }
  }
}

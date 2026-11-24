import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction } from 'discord.js';
import { play, runAnimatedGame, stillRolling, updateDisplay } from '../features/animation/index.js';
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
    const guildId = interaction.guildId as string;
    return runAnimatedGame({
      userId,
      busy: () => interaction.reply(errorReply(stillRolling)),
      settle: () =>
        settleRoll(
          this.container.db,
          { guildId, userId, bet: String(id.bet), call: id.call },
          Date.now(),
        ),
      errorText: diceErrorText,
      // A stale button keeps the card as it was and only gets a private explanation.
      reject: (text) => interaction.reply(errorReply(text)),
      show: async (roll) =>
        play(
          updateDisplay(interaction),
          await rollFrames(userId, roll),
          await rollResult(userId, roll),
          {
            channelId: interaction.channelId,
          },
        ),
    });
  }
}

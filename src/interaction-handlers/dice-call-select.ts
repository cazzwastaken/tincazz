import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import {
  type APIContainerComponent,
  type ButtonInteraction,
  ComponentType,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { end, stillRolling, tryBegin } from '../features/animation/index.js';
import {
  type CallSelectId,
  type DiceCall,
  decodeCall,
  decodeDiceId,
  notYourRoll,
  retargetCard,
} from '../features/dice/index.js';
import { cardReply, errorReply } from '../features/ui/index.js';

interface CallPick {
  id: CallSelectId;
  call: DiceCall;
}

const staleCard = 'That roll card is too old to change. Use `/dice` to roll again.';

export class DiceCallSelectHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, {
      ...options,
      interactionHandlerType: InteractionHandlerTypes.MessageComponent,
    });
  }

  public override parse(interaction: ButtonInteraction | StringSelectMenuInteraction) {
    if (!interaction.isStringSelectMenu()) {
      return this.none();
    }
    const id = decodeDiceId(interaction.customId);
    const [value] = interaction.values;
    const call = value === undefined ? undefined : decodeCall(value);
    return id?.kind === 'call' && call ? this.some<CallPick>({ id, call }) : this.none();
  }

  /**
   * Change call: only the owner, and only the card changes (its `Next:` line and the controls'
   * IDs). Nothing is rolled or charged until Roll again or Double is pressed.
   */
  public override async run(interaction: StringSelectMenuInteraction, { id, call }: CallPick) {
    if (interaction.user.id !== id.userId) {
      return interaction.reply(errorReply(notYourRoll));
    }
    const card = interaction.message.components[0]?.toJSON() as APIContainerComponent | undefined;
    if (card?.type !== ComponentType.Container) {
      return interaction.reply(errorReply(staleCard));
    }
    // An animation edits this card; changing it now would be overwritten or race the edits.
    const messageId = interaction.message.id;
    if (!tryBegin(messageId)) {
      return interaction.reply(errorReply(stillRolling));
    }
    try {
      return await interaction.update(cardReply(retargetCard(card, id.userId, id.bet, call)));
    } finally {
      end(messageId);
    }
  }
}

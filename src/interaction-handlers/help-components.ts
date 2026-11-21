import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { type ButtonInteraction, MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import {
  commandPrefix,
  decodeHelpId,
  type HelpPage,
  helpPage,
  isHelpPage,
} from '../features/help/index.js';
import { cardReply } from '../features/ui/index.js';

interface HelpClick {
  ownerId: string;
  page: HelpPage;
}

export class HelpComponentsHandler extends InteractionHandler {
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
    const id = decodeHelpId(interaction.customId);
    if (!id) {
      return this.none();
    }
    if (id.kind === 'page') {
      return interaction.isButton() ? this.some<HelpClick>(id) : this.none();
    }
    if (!interaction.isStringSelectMenu()) {
      return this.none();
    }
    const [page] = interaction.values;
    if (page === undefined || page === 'home' || !isHelpPage(page)) {
      return this.none();
    }
    return this.some<HelpClick>({ ownerId: id.ownerId, page });
  }

  public override async run(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    click: HelpClick,
  ) {
    const prefix = commandPrefix(this.container.client.options.defaultPrefix);
    if (interaction.user.id !== click.ownerId) {
      // Someone else pressed it: give them their own copy of the page instead of moving the card.
      return interaction.reply({
        ...cardReply(helpPage(click.page, prefix, interaction.user.id)),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
    }
    return interaction.update(cardReply(helpPage(click.page, prefix, click.ownerId)));
  }
}

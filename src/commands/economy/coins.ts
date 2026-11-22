import { Command } from '@sapphire/framework';
import { type ChatInputCommandInteraction, InteractionContextType } from 'discord.js';
import { coinHistory, coinHistoryCard } from '../../features/economy/index.js';
import { cardReply, errorReply } from '../../features/ui/index.js';

export class CoinsCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, { name: 'coins', description: 'See your coin activity' });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addSubcommand((sub) =>
          sub.setName('history').setDescription('Privately see your latest coin changes'),
        ),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    const { guildId, user } = interaction;
    if (!guildId) {
      return interaction.reply(errorReply('Use `/coins history` in a server.'));
    }

    const entries = coinHistory(this.container.db, guildId, user.id);
    return interaction.reply(cardReply(coinHistoryCard(entries), { ephemeral: true }));
  }
}

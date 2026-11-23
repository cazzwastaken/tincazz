import type { Args } from '@sapphire/framework';
import { Command } from '@sapphire/framework';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import {
  commandPrefix,
  type HelpPage,
  helpPage,
  isHelpPage,
  parseTopic,
  topicInfo,
  topicPages,
} from '../../features/help/index.js';
import { cardReply } from '../../features/ui/index.js';

export class HelpCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, { name: 'help', description: 'Find commands and learn how to use Tincazz' });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .addStringOption((option) =>
          option
            .setName('topic')
            .setDescription('Open a topic directly')
            .addChoices(...topicPages.map((value) => ({ name: topicInfo[value].label, value }))),
        ),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    const topic = interaction.options.getString('topic');
    const page: HelpPage = topic !== null && isHelpPage(topic) ? topic : 'home';
    return interaction.reply(
      cardReply(helpPage(page, this.prefix(), interaction.user.id), { ephemeral: true }),
    );
  }

  public override async messageRun(message: Message, args: Args) {
    const topic = (await args.pickResult('string')).unwrapOr(undefined);
    return message.reply(cardReply(helpPage(parseTopic(topic), this.prefix(), message.author.id)));
  }

  /** The configured command prefix (`COMMAND_PREFIX`), as set on the client. */
  private prefix(): string {
    return commandPrefix(this.container.client.options.defaultPrefix);
  }
}

import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  type ChatInputCommandInteraction,
  type Client,
  InteractionContextType,
  type Message,
  MessageFlags,
} from 'discord.js';
import { poll } from '../../features/poll/config.js';
import {
  createPoll,
  type PollInput,
  parsePollInput,
  parsePrefixPoll,
  pollUsage,
} from '../../features/poll/index.js';
import { accents, card, cardReply, errorReply } from '../../features/ui/index.js';

export class PollCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'poll',
      description: 'Ask a question and let people vote with reactions',
      runIn: CommandOptionsRunTypeEnum.GuildAny,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addStringOption((option) =>
          option
            .setName('question')
            .setDescription('What to ask')
            .setMaxLength(poll.maxQuestionLength * 2)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('options')
            .setDescription('2 to 9 options separated by | (default: yes or no)'),
        )
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('How long it runs: 30m, 2h or 3d (default: 24h)'),
        )
        .addBooleanOption((option) =>
          option.setName('anonymous').setDescription('Never show who voted'),
        ),
    );
  }

  public override async messageRun(message: Message, args: Args) {
    // The argument parser strips quotes, which the question needs, so read the raw text.
    const rest = message.content
      .slice(args.commandContext.commandPrefix.length)
      .trimStart()
      .replace(/^\S+/, '');
    if (rest.trim() === '') return message.reply(pollUsage);
    const parsed = parsePrefixPoll(rest);
    if (!parsed.ok) return message.reply(`${parsed.error}\n${pollUsage}`);
    const created = await this.create(
      message.guildId as string,
      message.channelId,
      message.author.id,
      message.id,
      parsed.value,
    );
    // The poll card itself is the reply when it worked.
    if (!created.ok) return message.reply(created.error);
    return undefined;
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    const parsed = parsePollInput({
      question: interaction.options.getString('question', true),
      options: interaction.options.getString('options'),
      duration: interaction.options.getString('duration'),
      anonymous: interaction.options.getBoolean('anonymous'),
    });
    if (!parsed.ok) return interaction.reply(errorReply(parsed.error));

    // Seeding the reactions can outlast the three seconds Discord allows for a first reply.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const created = await this.create(
      interaction.guildId as string,
      interaction.channelId,
      interaction.user.id,
      interaction.id,
      parsed.value,
    );
    return interaction.editReply(
      cardReply(
        card(
          created.ok ? accents.win : accents.error,
          created.ok ? `Your poll is up: ${created.url}` : created.error,
        ),
      ),
    );
  }

  private create(
    guildId: string,
    channelId: string,
    hostId: string,
    creationId: string,
    input: PollInput,
  ) {
    return createPoll(this.container.client as Client<true>, this.container.db, {
      guildId,
      channelId,
      hostId,
      creationId,
      input,
    });
  }
}

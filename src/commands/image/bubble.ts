import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import { type ChatInputCommandInteraction, InteractionContextType, type Message } from 'discord.js';
import {
  type BubbleStyle,
  bubbleUsage,
  canAttachFiles,
  commandPrefix,
  commandRemainder,
  interactionInputs,
  limits,
  messageInputs,
  messages,
  parseBubbleArgs,
  produceImage,
  replyWithImage,
  type TailSide,
} from '../../features/imaging/index.js';

export class BubbleCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'bubble',
      description: 'Put a speech bubble on an image or GIF',
      runIn: CommandOptionsRunTypeEnum.GuildAny,
      cooldownDelay: limits.cooldownMs,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand((builder) =>
      builder
        .setName(this.name)
        .setDescription(this.description)
        .setContexts(InteractionContextType.Guild)
        .addAttachmentOption((option) =>
          option.setName('image').setDescription('The image or GIF to use'),
        )
        .addStringOption((option) =>
          option.setName('url').setDescription('A Discord, Tenor or Giphy link'),
        )
        .addUserOption((option) => option.setName('user').setDescription("Use this user's avatar"))
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('The bubble style (default: transparent)')
            .addChoices(
              { name: 'Transparent', value: 'transparent' },
              { name: 'White', value: 'white' },
            ),
        )
        .addStringOption((option) =>
          option
            .setName('tail')
            .setDescription('Which side the tail points to (default: left)')
            .addChoices({ name: 'Left', value: 'left' }, { name: 'Right', value: 'right' }),
        ),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    return replyWithImage(interaction, () =>
      produceImage(
        interactionInputs(interaction),
        {
          kind: 'bubble',
          style: (interaction.options.getString('style') ?? 'transparent') as BubbleStyle,
          tail: (interaction.options.getString('tail') ?? 'left') as TailSide,
        },
        interaction.user.id,
      ),
    );
  }

  public override async messageRun(message: Message, args: Args) {
    const prefix = commandPrefix(this.container.client);
    if (!(await canAttachFiles(message))) {
      return message.reply(messages.noAttachFiles);
    }

    const rest = commandRemainder(message.content, prefix, args.commandContext.commandName);
    const parsed = parseBubbleArgs(rest);
    if ('error' in parsed) {
      return message.reply(bubbleUsage(prefix));
    }

    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }
    const result = await produceImage(
      await messageInputs(message, parsed),
      { kind: 'bubble', style: parsed.style, tail: parsed.tail },
      message.author.id,
    );
    if ('file' in result) {
      return message.reply({ files: [result.file] });
    }
    return message.reply(result.error ?? bubbleUsage(prefix));
  }
}

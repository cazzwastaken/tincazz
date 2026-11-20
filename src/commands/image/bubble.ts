import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
  PermissionFlagsBits,
} from 'discord.js';
import {
  type BubbleStyle,
  bubbleUsage,
  commandRemainder,
  interactionInputs,
  limits,
  messageInputs,
  messages,
  parseBubbleArgs,
  produceImage,
  type TailSide,
} from '../../features/imaging/index.js';
import { errorReply } from '../../features/ui/index.js';

const slashUsage = 'Give me an image: attach one, paste a link, or pick a user.';

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
    let result: Awaited<ReturnType<typeof produceImage>>;
    try {
      result = await produceImage(
        interactionInputs(interaction),
        {
          kind: 'bubble',
          style: (interaction.options.getString('style') ?? 'transparent') as BubbleStyle,
          tail: (interaction.options.getString('tail') ?? 'left') as TailSide,
        },
        interaction.user.id,
      );
    } catch (error) {
      // The generic error listener follows up ephemerally, but the first follow-up would replace
      // the public "thinking..." message and stay public, so drop it first.
      await interaction.deleteReply().catch(() => undefined);
      throw error;
    }
    if ('file' in result) {
      return interaction.editReply({ files: [result.file] });
    }
    // The deferred reply is public; drop it and answer privately instead.
    await interaction.deleteReply().catch(() => undefined);
    return interaction.followUp(errorReply(result.error ?? slashUsage));
  }

  public override async messageRun(message: Message, args: Args) {
    const prefix = this.prefix();
    const me = message.guild?.members.me ?? (await message.guild?.members.fetchMe());
    if (
      !me ||
      !message.channel.isSendable() ||
      !message.guild ||
      !('permissionsFor' in message.channel) ||
      !message.channel.permissionsFor(me)?.has(PermissionFlagsBits.AttachFiles)
    ) {
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

  /** The configured command prefix (`COMMAND_PREFIX`), as set on the client. */
  private prefix(): string {
    const configured = this.container.client.options.defaultPrefix;
    return (Array.isArray(configured) ? configured[0] : configured) ?? '?';
  }
}

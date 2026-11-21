import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
} from 'discord.js';
import {
  type BubbleStyle,
  bubbleUsage,
  canAttachFiles,
  commandPrefix,
  commandRemainder,
  hasDirectSource,
  type ImageOperation,
  interactionInputs,
  invokerMember,
  limits,
  linkedMessage,
  messageInputs,
  messageSnapshot,
  messages,
  parseBubbleArgs,
  produceImage,
  produceMessageImage,
  repliedMessage,
  replyWithImage,
  type TailSide,
} from '../../features/imaging/index.js';

/** The name of the message context menu command (right-click a message > Apps). */
const bubbleMessageMenu = 'Bubble message';

/**
 * Sources, highest first: attachment, link, user, then a message (the replied-to message of
 * `?bubble`, or the `message` option of `/bubble`). A message with text becomes a screenshot.
 */
export class BubbleCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'bubble',
      description: 'Put a speech bubble on an image, GIF or message',
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
            .setName('message')
            .setDescription('A message link or ID: text messages become a screenshot'),
        )
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
    registry.registerContextMenuCommand((builder) =>
      builder
        .setName(bubbleMessageMenu)
        .setType(ApplicationCommandType.Message)
        .setContexts(InteractionContextType.Guild),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    return replyWithImage(interaction, async () => {
      const op: ImageOperation = {
        kind: 'bubble',
        style: (interaction.options.getString('style') ?? 'transparent') as BubbleStyle,
        tail: (interaction.options.getString('tail') ?? 'left') as TailSide,
      };
      const inputs = interactionInputs(interaction);
      const link = interaction.options.getString('message');
      if (hasDirectSource(inputs) || link === null) {
        return produceImage(inputs, op, interaction.user.id);
      }
      const target = await linkedMessage(interaction, link);
      if (!target) return { error: messages.messageNotFound };
      const viewer = await invokerMember(interaction.guild, interaction.user.id);
      return produceMessageImage(await messageSnapshot(target, viewer), op, interaction.user.id);
    });
  }

  public override async contextMenuRun(interaction: Command.ContextMenuCommandInteraction) {
    if (!interaction.isMessageContextMenuCommand()) return;
    await interaction.deferReply();
    return replyWithImage(interaction, async () => {
      // The target is a message the user is looking at; it is always in this guild.
      const target = interaction.targetMessage;
      if (!interaction.guildId || target.guildId !== interaction.guildId) {
        return { error: messages.messageNotFound };
      }
      const viewer = await invokerMember(interaction.guild, interaction.user.id);
      return produceMessageImage(
        await messageSnapshot(target, viewer),
        { kind: 'bubble', style: 'transparent', tail: 'left' },
        interaction.user.id,
      );
    });
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
    const op: ImageOperation = { kind: 'bubble', style: parsed.style, tail: parsed.tail };
    const inputs = await messageInputs(message, parsed, { reply: false });
    const target = hasDirectSource(inputs) ? null : await repliedMessage(message);
    const result = target
      ? await produceMessageImage(
          await messageSnapshot(target, message.member),
          op,
          message.author.id,
        )
      : await produceImage(inputs, op, message.author.id);
    if ('file' in result) {
      return message.reply({ files: [result.file] });
    }
    return message.reply(result.error ?? bubbleUsage(prefix));
  }
}

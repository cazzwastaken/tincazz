import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  InteractionContextType,
  LabelBuilder,
  type Message,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  canAttachFiles,
  captionModalTextId,
  captionUsage,
  commandPrefix,
  commandRemainder,
  encodeCaptionModalId,
  hasDirectSource,
  ImagingError,
  interactionInputs,
  interactionMentionNames,
  invokerMember,
  limits,
  linkedMessage,
  messageInputs,
  messageMentionNames,
  messageSnapshot,
  messages,
  parseCaptionArgs,
  produceImage,
  produceMessageImage,
  repliedMessage,
  replyWithImage,
  sanitizeCaption,
} from '../../features/imaging/index.js';
import { errorReply } from '../../features/ui/index.js';

/** The name of the message context menu command (right-click a message > Apps). */
const captionMessageMenu = 'Caption message';

/**
 * Sources, highest first: attachment, link, user, then a message (the replied-to message of
 * `?caption`, the `message` option of `/caption`, or the "Caption message" context menu, which
 * asks for the text in a modal). A message with text becomes a screenshot under the caption.
 */

export class CaptionCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'caption',
      description: 'Add a white caption bar above an image, GIF or message',
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
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('The caption')
            .setRequired(true)
            .setMaxLength(limits.captionChars),
        )
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
        ),
    );
    registry.registerContextMenuCommand((builder) =>
      builder
        .setName(captionMessageMenu)
        .setType(ApplicationCommandType.Message)
        .setContexts(InteractionContextType.Guild),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    // Sanitise before deferring: a bad caption is answered privately and directly.
    const raw = interaction.options.getString('text', true);
    let text: string;
    try {
      text = sanitizeCaption(raw, interactionMentionNames(interaction, raw));
      if (text.length > limits.captionChars) throw new ImagingError(messages.captionTooLongChars);
    } catch (error) {
      if (error instanceof ImagingError) return interaction.reply(errorReply(error.message));
      throw error;
    }

    await interaction.deferReply();
    return replyWithImage(interaction, async () => {
      const op = { kind: 'caption', text } as const;
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

  /**
   * A context menu cannot take text, so it asks for the caption in a modal (no defer: a modal must
   * be the first response). The modal's ID carries the message; `caption-modal.ts` renders it.
   */
  public override async contextMenuRun(interaction: Command.ContextMenuCommandInteraction) {
    if (!interaction.isMessageContextMenuCommand()) return;
    const modal = new ModalBuilder()
      .setCustomId(encodeCaptionModalId(interaction.targetId))
      .setTitle('Caption message')
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Caption')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId(captionModalTextId)
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setMaxLength(limits.captionChars),
          ),
      );
    return interaction.showModal(modal);
  }

  public override async messageRun(message: Message, args: Args) {
    const prefix = commandPrefix(this.container.client);
    if (!(await canAttachFiles(message))) {
      return message.reply(messages.noAttachFiles);
    }

    const rest = commandRemainder(message.content, prefix, args.commandContext.commandName);
    const parsed = parseCaptionArgs(rest);
    if (parsed.text.length === 0) {
      return message.reply(captionUsage(prefix));
    }

    let text: string;
    try {
      text = sanitizeCaption(parsed.text, messageMentionNames(message, message.member));
      if (text.length > limits.captionChars) throw new ImagingError(messages.captionTooLongChars);
    } catch (error) {
      if (error instanceof ImagingError) return message.reply(error.message);
      throw error;
    }

    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }
    const op = { kind: 'caption', text } as const;
    const inputs = await messageInputs(
      message,
      parsed.url === undefined ? {} : { url: parsed.url },
      { reply: false },
    );
    const direct = hasDirectSource(inputs);
    const target = direct ? null : await repliedMessage(message);
    // A reply whose message cannot be used (deleted, another channel, a forward) is not "nothing
    // given": say so instead of showing the usage.
    if (!direct && !target && message.reference?.messageId) {
      return message.reply(messages.messageNotFound);
    }
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
    return message.reply(result.error ?? captionUsage(prefix));
  }
}

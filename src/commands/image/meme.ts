import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import { type ChatInputCommandInteraction, InteractionContextType, type Message } from 'discord.js';
import {
  canAttachFiles,
  commandPrefix,
  commandRemainder,
  ImagingError,
  interactionInputs,
  interactionMentionNames,
  limits,
  memeUsage,
  messageInputs,
  messageMentionNames,
  messages,
  parseMemeArgs,
  produceImage,
  replyWithImage,
  sanitizeCaption,
} from '../../features/imaging/index.js';
import { errorReply } from '../../features/ui/index.js';

export class MemeCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'meme',
      description: 'Add a white caption bar above an image or GIF',
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
        .addUserOption((option) => option.setName('user').setDescription("Use this user's avatar")),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    // Sanitise before deferring: a bad caption is answered privately and directly.
    const raw = interaction.options.getString('text', true);
    let text: string;
    try {
      text = sanitizeCaption(raw, interactionMentionNames(interaction, raw));
      if (text.length > limits.captionChars) throw new ImagingError(messages.captionTooLong);
    } catch (error) {
      if (error instanceof ImagingError) return interaction.reply(errorReply(error.message));
      throw error;
    }

    await interaction.deferReply();
    return replyWithImage(interaction, () =>
      produceImage(interactionInputs(interaction), { kind: 'meme', text }, interaction.user.id),
    );
  }

  public override async messageRun(message: Message, args: Args) {
    const prefix = commandPrefix(this.container.client);
    if (!(await canAttachFiles(message))) {
      return message.reply(messages.noAttachFiles);
    }

    const rest = commandRemainder(message.content, prefix, args.commandContext.commandName);
    const parsed = parseMemeArgs(rest);
    if (parsed.text.length === 0) {
      return message.reply(memeUsage(prefix));
    }

    let text: string;
    try {
      text = sanitizeCaption(parsed.text, messageMentionNames(message));
      if (text.length > limits.captionChars) throw new ImagingError(messages.captionTooLong);
    } catch (error) {
      if (error instanceof ImagingError) return message.reply(error.message);
      throw error;
    }

    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }
    const inputs = await messageInputs(
      message,
      parsed.url === undefined ? {} : { url: parsed.url },
    );
    const result = await produceImage(inputs, { kind: 'meme', text }, message.author.id);
    if ('file' in result) {
      return message.reply({ files: [result.file] });
    }
    return message.reply(result.error ?? memeUsage(prefix));
  }
}

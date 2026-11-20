import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import {
  type ChatInputCommandInteraction,
  InteractionContextType,
  type Message,
  PermissionFlagsBits,
} from 'discord.js';
import {
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
  sanitizeCaption,
} from '../../features/imaging/index.js';
import { errorReply } from '../../features/ui/index.js';

const slashUsage = 'Give me an image: attach one, paste a link, or pick a user.';

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
    let result: Awaited<ReturnType<typeof produceImage>>;
    try {
      result = await produceImage(
        interactionInputs(interaction),
        { kind: 'meme', text },
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

  /** The configured command prefix (`COMMAND_PREFIX`), as set on the client. */
  private prefix(): string {
    const configured = this.container.client.options.defaultPrefix;
    return (Array.isArray(configured) ? configured[0] : configured) ?? '?';
  }
}

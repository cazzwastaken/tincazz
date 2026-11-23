import { type Args, Command, CommandOptionsRunTypeEnum } from '@sapphire/framework';
import { type ChatInputCommandInteraction, InteractionContextType, type Message } from 'discord.js';
import {
  canAttachFiles,
  commandPrefix,
  commandRemainder,
  gifUsage,
  hasDirectSource,
  interactionInputs,
  limits,
  messageInputs,
  messages,
  parseGifArgs,
  produceImage,
  repliedMessage,
  replyData,
  replyWithImage,
} from '../../features/imaging/index.js';

const operation = { kind: 'gif' } as const;

export class GifCommand extends Command {
  public constructor(context: Command.LoaderContext) {
    super(context, {
      name: 'gif',
      description: 'Convert an image to a downloadable GIF',
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
        .addAttachmentOption((option) => option.setName('image').setDescription('Image to convert'))
        .addStringOption((option) =>
          option.setName('url').setDescription('A Discord, Tenor or Giphy link'),
        ),
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();
    return replyWithImage(
      interaction,
      () => produceImage(interactionInputs(interaction), operation, interaction.user.id),
      'Attach an image or paste a Discord, Tenor or Giphy link.',
    );
  }

  public override async messageRun(message: Message, args: Args) {
    if (!(await canAttachFiles(message))) return message.reply(messages.noAttachFiles);

    const prefix = commandPrefix(this.container.client);
    const parsed = parseGifArgs(
      commandRemainder(message.content, prefix, args.commandContext.commandName),
    );
    if ('error' in parsed) return message.reply(gifUsage(prefix));

    const inputs = await messageInputs(message, parsed, { reply: false });
    if (!hasDirectSource(inputs) && message.reference?.messageId) {
      const target = await repliedMessage(message);
      if (!target) return message.reply(messages.messageNotFound);
      inputs.reply = replyData(target);
    }
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }
    const result = await produceImage(inputs, operation, message.author.id);
    return message.reply(
      'file' in result ? { files: [result.file] } : (result.error ?? gifUsage(prefix)),
    );
  }
}

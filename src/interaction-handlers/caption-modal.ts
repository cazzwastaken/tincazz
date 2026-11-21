import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ModalSubmitInteraction } from 'discord.js';
import {
  captionModalTextId,
  decodeCaptionModalId,
  ImagingError,
  interactionMentionNames,
  invokerMember,
  limits,
  linkedMessage,
  messageSnapshot,
  messages,
  produceMessageImage,
  replyWithImage,
  sanitizeCaption,
} from '../features/imaging/index.js';
import { errorReply } from '../features/ui/index.js';

/**
 * The modal of the "Caption message" context menu. Its custom ID names the message, but it comes
 * back from the client, so the message is resolved like `/caption message:<id>`: in this channel,
 * only when both the user and the bot may read it.
 */
export class CaptionModalHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
  }

  public override parse(interaction: ModalSubmitInteraction) {
    const messageId = decodeCaptionModalId(interaction.customId);
    return messageId === null ? this.none() : this.some(messageId);
  }

  public override async run(interaction: ModalSubmitInteraction, messageId: string) {
    // Sanitise before deferring: a bad caption is answered privately and directly.
    const raw = interaction.fields.getTextInputValue(captionModalTextId);
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
      const target = await linkedMessage(interaction, messageId);
      if (!target) return { error: messages.messageNotFound };
      const viewer = await invokerMember(interaction.guild, interaction.user.id);
      return produceMessageImage(
        await messageSnapshot(target, viewer),
        { kind: 'caption', text },
        interaction.user.id,
      );
    });
  }
}

import {
  type ChatInputCommandErrorPayload,
  type ContextMenuCommandErrorPayload,
  container,
  Events,
  type InteractionHandlerError,
  Listener,
} from '@sapphire/framework';
import { type ContextMenuCommandInteraction, type Interaction, MessageFlags } from 'discord.js';

const genericError = {
  content: 'Something went wrong running that. It has been logged.',
  flags: MessageFlags.Ephemeral,
} as const;

/**
 * Tells the user a command failed. Sapphire's core listeners already log the error itself, so this
 * only replies; a failing reply (for example an expired token) is logged, never thrown.
 */
export async function replyWithGenericError(
  interaction: Interaction | ContextMenuCommandInteraction,
): Promise<void> {
  if (!interaction.isRepliable()) return;
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(genericError);
    } else {
      await interaction.reply(genericError);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    container.logger.warn(
      `Could not send the error reply for interaction ${interaction.id}: ${reason}`,
    );
  }
}

export class ChatInputCommandErrorListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'ChatInputCommandErrorReply', event: Events.ChatInputCommandError });
  }

  public override async run(_error: Error, { interaction }: ChatInputCommandErrorPayload) {
    await replyWithGenericError(interaction);
  }
}

export class ContextMenuCommandErrorListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'ContextMenuCommandErrorReply', event: Events.ContextMenuCommandError });
  }

  public override async run(_error: Error, { interaction }: ContextMenuCommandErrorPayload) {
    await replyWithGenericError(interaction);
  }
}

export class InteractionHandlerErrorListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'InteractionHandlerErrorReply', event: Events.InteractionHandlerError });
  }

  public override async run(_error: Error, { interaction }: InteractionHandlerError) {
    await replyWithGenericError(interaction);
  }
}

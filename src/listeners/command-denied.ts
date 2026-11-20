import {
  type ChatInputCommandDeniedPayload,
  container,
  Events,
  Listener,
  type MessageCommandDeniedPayload,
  type UserError,
} from '@sapphire/framework';
import { errorReply } from '../features/ui/index.js';

/** A precondition can opt out of the reply (for example when it already answered). */
function isSilent(error: UserError): boolean {
  return Reflect.get(Object(error.context), 'silent') === true;
}

function logReplyFailure(what: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  container.logger.warn(`Could not send the denial reply for ${what}: ${reason}`);
}

/** Tells the user why a slash command was not run (cooldown, wrong channel type, ...). */
export class ChatInputCommandDeniedListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'ChatInputCommandDeniedReply', event: Events.ChatInputCommandDenied });
  }

  public override async run(error: UserError, { interaction }: ChatInputCommandDeniedPayload) {
    if (isSilent(error)) return;
    try {
      const reply = errorReply(error.message);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (failure) {
      logReplyFailure(`interaction ${interaction.id}`, failure);
    }
  }
}

/** Tells the user why a prefix command was not run. */
export class MessageCommandDeniedListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'MessageCommandDeniedReply', event: Events.MessageCommandDenied });
  }

  public override async run(error: UserError, { message }: MessageCommandDeniedPayload) {
    if (isSilent(error)) return;
    try {
      await message.reply(error.message);
    } catch (failure) {
      logReplyFailure(`message ${message.id}`, failure);
    }
  }
}

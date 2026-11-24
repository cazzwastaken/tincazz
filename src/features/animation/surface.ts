import type { ChatInputCommandInteraction, Message } from 'discord.js';
import { errorReply } from '../ui/index.js';
import { messageDisplay, replyDisplay } from './displays.js';
import type { Display } from './play.js';

/** Where a game came from: a slash interaction or a prefix message. Both run the same body. */
export interface GameSurface {
  channelId: string;
  userId: string;
  guildId: string;
  /** Shows the animated game: the first card, then edits of it. */
  display: Display;
  /** Answers with an error: ephemeral for slash, plain text for prefix. */
  error(text: string): Promise<unknown>;
}

export function interactionSurface(interaction: ChatInputCommandInteraction): GameSurface {
  return {
    channelId: interaction.channelId,
    userId: interaction.user.id,
    guildId: interaction.guildId as string,
    display: replyDisplay(interaction),
    error: (text) => interaction.reply(errorReply(text)),
  };
}

export function messageSurface(message: Message): GameSurface {
  return {
    channelId: message.channel.id,
    userId: message.author.id,
    guildId: message.guildId as string,
    display: messageDisplay(message),
    error: (text) => message.reply(text),
  };
}

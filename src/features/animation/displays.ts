import type { ButtonInteraction, Message, RepliableInteraction } from 'discord.js';
import type { CardReply, Display } from './play.js';

/** A command's reply, then edits of it. */
export function replyDisplay(interaction: RepliableInteraction): Display {
  return {
    first: (reply: CardReply) => interaction.reply(reply),
    next: (reply: CardReply) => interaction.editReply(reply),
    // The game has settled, so the result must arrive even when the edits keep failing.
    fallback: (reply: CardReply) =>
      interaction.replied || interaction.deferred
        ? interaction.followUp(reply)
        : interaction.reply(reply),
  };
}

/** A button press that updates the card it sits on, then edits it. */
export function updateDisplay(interaction: ButtonInteraction): Display {
  return {
    first: (reply: CardReply) => interaction.update(reply),
    next: (reply: CardReply) => interaction.editReply(reply),
    fallback: (reply: CardReply) => interaction.message.edit(reply),
  };
}

/**
 * A reply to a prefix-command message, then edits of the reply. The command message may be deleted
 * before the result is ready, so the reply must not fail when it is gone (it posts normally).
 */
export function messageDisplay(message: Message): Display & { sent(): Message | undefined } {
  let sent: Message | undefined;
  return {
    first: async (reply: CardReply) => {
      sent = await message.reply({ ...reply, failIfNotExists: false });
      return sent;
    },
    next: async (reply: CardReply) => {
      if (!sent) {
        throw new Error('no reply to edit');
      }
      return sent.edit(reply);
    },
    // A new reply: the original reply or its edits failed, and the command message may be gone.
    fallback: async (reply: CardReply) => {
      sent = await message.reply({ ...reply, failIfNotExists: false });
      return sent;
    },
    sent: () => sent,
  };
}

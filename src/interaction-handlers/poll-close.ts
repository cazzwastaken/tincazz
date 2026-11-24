import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import { type ButtonInteraction, PermissionFlagsBits } from 'discord.js';
import {
  closePollEarly,
  decodePollCloseId,
  getPoll,
  type PollCloseId,
} from '../features/poll/index.js';
import { errorReply } from '../features/ui/index.js';

export const notYourPoll = 'Only the host or a moderator with Manage Messages can close this poll.';
export const pollAlreadyOver = 'This poll is already closed.';
export const pollWrongMessage = 'This button does not belong to a live poll.';
export const pollStillPosting = 'This poll is still being posted. Try again in a moment.';
export const pollGone = 'This poll no longer exists.';

export class PollCloseHandler extends InteractionHandler {
  public constructor(
    context: InteractionHandler.LoaderContext,
    options: InteractionHandler.Options,
  ) {
    super(context, { ...options, interactionHandlerType: InteractionHandlerTypes.Button });
  }

  public override parse(interaction: ButtonInteraction) {
    const id = decodePollCloseId(interaction.customId);
    // An ID for another server is not ours to answer.
    return id && id.guildId === interaction.guildId ? this.some(id) : this.none();
  }

  public override async run(interaction: ButtonInteraction, id: PollCloseId) {
    const row = getPoll(this.container.db, id.guildId, id.pollId);
    if (!row || row.status === 'deleted') return interaction.reply(errorReply(pollGone));
    // A button from a message that is not this poll's (such as an orphaned post) closes nothing.
    if (interaction.message.id !== row.messageId) {
      return interaction.reply(errorReply(pollWrongMessage));
    }
    if (row.status === 'publishing') return interaction.reply(errorReply(pollStillPosting));
    if (row.status !== 'open') return interaction.reply(errorReply(pollAlreadyOver));

    const allowed =
      interaction.user.id === row.hostId ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) === true;
    if (!allowed) return interaction.reply(errorReply(notYourPoll));

    const closed = closePollEarly(
      this.container.db,
      id.guildId,
      id.pollId,
      interaction.user.id,
      Date.now(),
    );
    if (!closed) return interaction.reply(errorReply(pollAlreadyOver));
    // The runner edits the card to its final form on its next scan.
    return interaction.deferUpdate();
  }
}

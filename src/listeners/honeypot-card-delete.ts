import { Events, Listener } from '@sapphire/framework';
import type { Message, PartialMessage } from 'discord.js';
import { onCardDeleted } from '../features/honeypot/index.js';

export class HoneypotCardDeleteListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'HoneypotCardDelete', event: Events.MessageDelete });
  }

  public override run(message: Message | PartialMessage) {
    // Partials carry only the IDs, which is all the card check needs.
    void onCardDeleted({ id: message.id, guildId: message.guildId }).catch((error: unknown) => {
      this.container.logger.error(`honeypot card delete handling failed for ${message.id}`, error);
    });
  }
}

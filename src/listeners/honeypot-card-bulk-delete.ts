import { Events, Listener } from '@sapphire/framework';
import type {
  GuildTextBasedChannel,
  Message,
  PartialMessage,
  ReadonlyCollection,
  Snowflake,
} from 'discord.js';
import { onCardsDeleted } from '../features/honeypot/index.js';

export class HoneypotCardBulkDeleteListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'HoneypotCardBulkDelete', event: Events.MessageBulkDelete });
  }

  public override run(
    messages: ReadonlyCollection<Snowflake, Message<true> | PartialMessage<true>>,
    channel: GuildTextBasedChannel,
  ) {
    // A purge removes the card without firing messageDelete for it.
    void onCardsDeleted(channel.guildId, messages.keys()).catch((error: unknown) => {
      this.container.logger.error(
        `honeypot card bulk delete handling failed in ${channel.id}`,
        error,
      );
    });
  }
}

import { Events, Listener } from '@sapphire/framework';
import type { Message } from 'discord.js';
import { handleHoneypotMessage, scheduleCardRefresh } from '../features/honeypot/index.js';
import { logMod } from '../features/logs/index.js';

export class HoneypotListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'Honeypot', event: Events.MessageCreate });
  }

  public override run(message: Message) {
    void handleHoneypotMessage(message, {
      db: this.container.db,
      botUserId: this.container.client.user?.id ?? '',
      now: Date.now,
      log: (guildId, event) => void logMod(guildId, event),
      refreshCard: scheduleCardRefresh,
    });
  }
}

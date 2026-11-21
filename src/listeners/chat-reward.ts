import { Events, Listener } from '@sapphire/framework';
import type { Message } from 'discord.js';
import { isChatRewardable, rewardChat } from '../features/economy/index.js';
import { isHoneypotChannel } from '../features/honeypot/index.js';

export class ChatRewardListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'ChatReward', event: Events.MessageCreate });
  }

  public override run(message: Message) {
    if (!isChatRewardable(message, this.prefixes())) {
      return;
    }
    try {
      if (isHoneypotChannel(this.container.db, message.guildId as string, message.channelId)) {
        return;
      }
      rewardChat(this.container.db, message.guildId as string, message.author.id, Date.now());
    } catch (error) {
      this.container.logger.error(`chat reward failed for ${message.author.id}`, error);
    }
  }

  private prefixes(): string[] {
    const prefix = this.container.client.options.defaultPrefix;
    if (!prefix) {
      return [];
    }
    return typeof prefix === 'string' ? [prefix] : [...prefix];
  }
}

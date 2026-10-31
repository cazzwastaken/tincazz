import { Events, Listener } from '@sapphire/framework';
import type { DMChannel, NonThreadGuildBasedChannel } from 'discord.js';
import { logMod } from '../features/logs/index.js';
import { removeGameChannelEverywhere } from '../features/settings/game-channels.js';
import { clearChannelEverywhere } from '../features/settings/store.js';

export class ChannelDeleteListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'ChannelDelete', event: Events.ChannelDelete });
  }

  public override run(channel: DMChannel | NonThreadGuildBasedChannel) {
    try {
      removeGameChannelEverywhere(this.container.db, channel.id);
      const cleared = clearChannelEverywhere(this.container.db, channel.id, Date.now());
      for (const { guildId, kind } of cleared) {
        if (kind === 'economy') {
          void logMod(guildId, {
            type: 'setting_auto_cleared',
            setting: 'log_channel',
            id: channel.id,
            detail: 'economy log channel was deleted',
          });
        } else {
          this.container.logger.info(`Mod log channel ${channel.id} was deleted in ${guildId}`);
        }
      }
    } catch (error) {
      this.container.logger.error(`channel delete cleanup failed for ${channel.id}`, error);
    }
  }
}

import { Events, Listener } from '@sapphire/framework';
import type { DMChannel, NonThreadGuildBasedChannel } from 'discord.js';
import { clearHoneypotChannelEverywhere } from '../features/honeypot/index.js';
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
      const now = Date.now();
      const cleared = clearChannelEverywhere(this.container.db, channel.id, now);
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
      for (const guildId of clearHoneypotChannelEverywhere(this.container.db, channel.id, now)) {
        void logMod(guildId, {
          type: 'setting_auto_cleared',
          setting: 'honeypot',
          id: channel.id,
          detail: 'honeypot channel was deleted',
        });
      }
    } catch (error) {
      this.container.logger.error(`channel delete cleanup failed for ${channel.id}`, error);
    }
  }
}

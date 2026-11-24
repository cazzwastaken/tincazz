import { Events, Listener } from '@sapphire/framework';
import type { DMChannel, NonThreadGuildBasedChannel } from 'discord.js';
import {
  clearHallChannelEverywhere,
  removeExemptEverywhere,
} from '../features/halloffame/index.js';
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
      const { db } = this.container;
      const now = Date.now();
      const { removedGames, clearedLogs, clearedHoneypots, clearedHalls, clearedExempt } =
        db.transaction((tx) => ({
          removedGames: removeGameChannelEverywhere(tx, channel.id),
          clearedLogs: clearChannelEverywhere(tx, channel.id, now),
          clearedHoneypots: clearHoneypotChannelEverywhere(tx, channel.id, now),
          // The runner removes the entries that pointed at it (raw event); the setting is cleared once, here.
          clearedHalls: clearHallChannelEverywhere(tx, channel.id, now),
          clearedExempt: removeExemptEverywhere(tx, channel.id),
        }));
      for (const { guildId, paused } of removedGames) {
        void logMod(guildId, {
          type: 'setting_auto_cleared',
          setting: 'game_channel',
          id: channel.id,
          detail: paused
            ? 'The last allowed channel was deleted. Games are paused until you allow a channel or use `/settings games reset`.'
            : 'A game channel was deleted.',
        });
      }
      for (const { guildId, kind } of clearedLogs) {
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
      for (const guildId of clearedHoneypots) {
        void logMod(guildId, {
          type: 'setting_auto_cleared',
          setting: 'honeypot',
          id: channel.id,
          detail: 'honeypot channel was deleted',
        });
      }
      for (const guildId of clearedHalls) {
        void logMod(guildId, {
          type: 'setting_auto_cleared',
          setting: 'hall_of_fame',
          id: channel.id,
          detail: 'Hall of Fame channel was deleted. Nothing is inducted until you pick a new one.',
        });
      }
      for (const guildId of clearedExempt) {
        void logMod(guildId, {
          type: 'setting_auto_cleared',
          setting: 'hall_exempt',
          id: channel.id,
          detail: 'A deleted channel or category was removed from the Hall of Fame exemptions.',
        });
      }
    } catch (error) {
      this.container.logger.error(`channel delete cleanup failed for ${channel.id}`, error);
    }
  }
}

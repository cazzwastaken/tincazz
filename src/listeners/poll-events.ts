import { Listener } from '@sapphire/framework';
import {
  Events,
  GatewayDispatchEvents,
  type GatewayDispatchPayload,
  PermissionFlagsBits,
  Routes,
} from 'discord.js';
import {
  castVote,
  clearAllVotes,
  clearOptionVotes,
  clearVote,
  getPollByMessage,
  markPollChannelDeleted,
  markPollMessagesDeleted,
  optionIndexOf,
  pollEmojis,
} from '../features/poll/index.js';

interface ReactionEmoji {
  id: string | null;
  name: string | null;
}

/** The unicode emoji name, or undefined for a custom emoji (polls only use unicode). */
const unicode = (emoji: ReactionEmoji) => (emoji.id || !emoji.name ? undefined : emoji.name);

export class PollEventsListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'PollEvents', event: Events.Raw });
  }

  public override run(packet: GatewayDispatchPayload) {
    // Raw events also cover uncached messages and users, such as after a restart.
    try {
      this.handle(packet);
    } catch (error) {
      this.container.logger.error(`poll event ${packet.t} failed`, error);
    }
  }

  private handle(packet: GatewayDispatchPayload) {
    const { db, client } = this.container;
    const now = Date.now();
    switch (packet.t) {
      case GatewayDispatchEvents.MessageReactionAdd: {
        const { guild_id: guildId, message_id: messageId, user_id: userId } = packet.d;
        // Super (burst) reactions never vote.
        if (!guildId || packet.d.burst) return;
        if (packet.d.member?.user.bot || userId === client.user?.id) return;
        const emoji = unicode(packet.d.emoji);
        if (!emoji) return;
        // Only a poll's own option emoji reach the vote path.
        const probe = this.pollOption(guildId, messageId, (poll) => optionIndexOf(poll, emoji));
        if (probe === undefined) return;
        const cast = castVote(db, guildId, messageId, userId, probe, now);
        if (cast && cast.previous !== undefined && cast.previous !== probe) {
          this.removeReaction(
            guildId,
            packet.d.channel_id,
            messageId,
            userId,
            pollEmojis(cast.poll)[cast.previous],
          );
        }
        return;
      }
      case GatewayDispatchEvents.MessageReactionRemove: {
        const { guild_id: guildId, message_id: messageId } = packet.d;
        const emoji = unicode(packet.d.emoji);
        if (!guildId || !emoji || packet.d.burst) return;
        const index = this.pollOption(guildId, messageId, (poll) => optionIndexOf(poll, emoji));
        if (index !== undefined) clearVote(db, guildId, messageId, packet.d.user_id, index, now);
        return;
      }
      case GatewayDispatchEvents.MessageReactionRemoveEmoji: {
        const { guild_id: guildId, message_id: messageId } = packet.d;
        const emoji = unicode(packet.d.emoji);
        if (!guildId || !emoji) return;
        const index = this.pollOption(guildId, messageId, (poll) => optionIndexOf(poll, emoji));
        if (index !== undefined) clearOptionVotes(db, guildId, messageId, index, now);
        return;
      }
      case GatewayDispatchEvents.MessageReactionRemoveAll:
        if (packet.d.guild_id) clearAllVotes(db, packet.d.guild_id, packet.d.message_id, now);
        return;
      case GatewayDispatchEvents.MessageDelete:
        if (packet.d.guild_id) markPollMessagesDeleted(db, packet.d.guild_id, [packet.d.id]);
        return;
      case GatewayDispatchEvents.MessageDeleteBulk:
        if (packet.d.guild_id) markPollMessagesDeleted(db, packet.d.guild_id, packet.d.ids);
        return;
      case GatewayDispatchEvents.ChannelDelete:
      case GatewayDispatchEvents.ThreadDelete:
        if (packet.d.guild_id) markPollChannelDeleted(db, packet.d.guild_id, packet.d.id);
        return;
      default:
    }
  }

  /** The option `emoji` votes for on this message's open poll, if it is a poll message. */
  private pollOption(
    guildId: string,
    messageId: string,
    optionOf: (poll: { yesNo: boolean; options: readonly string[] }) => number | undefined,
  ): number | undefined {
    const row = getPollByMessage(this.container.db, guildId, messageId);
    return row ? optionOf(row) : undefined;
  }

  /** Removes a voter's old reaction when the bot may manage messages; any failure is ignored. */
  private removeReaction(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    emoji: string | undefined,
  ) {
    if (!emoji) return;
    const { client, logger } = this.container;
    const guild = client.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    const me = guild?.members.me;
    if (!channel || !me) return;
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) return;
    client.rest
      .delete(
        Routes.channelMessageUserReaction(channelId, messageId, encodeURIComponent(emoji), userId),
      )
      .catch((error) =>
        logger.debug(`poll: could not remove a stale reaction in ${channelId}`, error),
      );
  }
}

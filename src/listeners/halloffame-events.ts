import { Listener } from '@sapphire/framework';
import { Events, GatewayDispatchEvents, type GatewayDispatchPayload } from 'discord.js';
import {
  onHallChannelDeleted,
  onHallMessagesDeleted,
  onMessageUpdate,
  onReactionAdd,
  onReactionChange,
  onSourceChannelDeleted,
  onSourceMessagesDeleted,
} from '../features/halloffame/index.js';

/** Feeds the Hall of Fame runner from raw gateway events, so uncached messages work too. */
export class HallOfFameEventsListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'HallOfFameEvents', event: Events.Raw });
  }

  public override run(packet: GatewayDispatchPayload) {
    try {
      this.handle(packet);
    } catch (error) {
      this.container.logger.error(`hall of fame event ${packet.t} failed`, error);
    }
  }

  private handle(packet: GatewayDispatchPayload) {
    const { client } = this.container;
    switch (packet.t) {
      case GatewayDispatchEvents.MessageReactionAdd: {
        const { guild_id: guildId, channel_id: channelId, message_id: messageId } = packet.d;
        const { user_id: userId } = packet.d;
        if (!guildId || !channelId || !messageId || !userId) return;
        onReactionAdd({
          guildId,
          channelId,
          messageId,
          userId,
          messageAuthorId: packet.d.message_author_id,
          isBot: Boolean(packet.d.member?.user.bot || client.users.cache.get(userId)?.bot),
          burst: Boolean(packet.d.burst),
          emoji: packet.d.emoji,
        });
        return;
      }
      case GatewayDispatchEvents.MessageReactionRemove:
        // A super reaction never counted, so taking one back changes nothing.
        if (packet.d.burst) return;
        this.reactionChanged(packet.d);
        return;
      case GatewayDispatchEvents.MessageReactionRemoveEmoji:
      case GatewayDispatchEvents.MessageReactionRemoveAll:
        this.reactionChanged(packet.d);
        return;
      case GatewayDispatchEvents.MessageUpdate:
        if (packet.d.guild_id && packet.d.id) onMessageUpdate(packet.d.guild_id, packet.d.id);
        return;
      case GatewayDispatchEvents.MessageDelete: {
        const { guild_id: guildId, id } = packet.d;
        if (guildId && id) this.messagesDeleted(guildId, [id]);
        return;
      }
      case GatewayDispatchEvents.MessageDeleteBulk: {
        const { guild_id: guildId, ids } = packet.d;
        if (guildId && Array.isArray(ids)) this.messagesDeleted(guildId, ids);
        return;
      }
      case GatewayDispatchEvents.ChannelDelete:
        if (packet.d.guild_id && packet.d.id) {
          // The hall channel setting itself is cleared by the channel delete listener.
          onHallChannelDeleted(packet.d.id);
          this.background('delete the posts of', packet.d.id, onSourceChannelDeleted(packet.d.id));
        }
        return;
      case GatewayDispatchEvents.ThreadDelete:
        if (packet.d.guild_id && packet.d.id) {
          this.background('delete the posts of', packet.d.id, onSourceChannelDeleted(packet.d.id));
        }
        return;
      default:
    }
  }

  private reactionChanged(data: { guild_id?: string; channel_id: string; message_id: string }) {
    if (!data.guild_id || !data.channel_id || !data.message_id) return;
    onReactionChange({
      guildId: data.guild_id,
      channelId: data.channel_id,
      messageId: data.message_id,
    });
  }

  /**
   * A message was deleted: it may be an inducted source (its hall post goes too) or a hall post
   * (it becomes a tombstone). Both are cheap lookups, so run both.
   */
  private messagesDeleted(guildId: string, ids: readonly string[]) {
    onHallMessagesDeleted(guildId, ids);
    this.background('delete the posts of', ids.join(','), onSourceMessagesDeleted(guildId, ids));
  }

  private background(action: string, subject: string, work: Promise<unknown>) {
    work.catch((error) =>
      this.container.logger.error(`hall of fame could not ${action} ${subject}`, error),
    );
  }
}

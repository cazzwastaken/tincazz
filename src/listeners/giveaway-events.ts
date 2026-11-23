import { Listener } from '@sapphire/framework';
import { Events, GatewayDispatchEvents, type GatewayDispatchPayload } from 'discord.js';
import {
  cancelGiveawayPosts,
  entryReaction,
  requestGiveawayRefresh,
} from '../features/giveaways/index.js';

export class GiveawayEventsListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: Events.Raw });
  }

  public override run(packet: GatewayDispatchPayload) {
    // Raw events also cover uncached messages, reactions and users after a restart.
    switch (packet.t) {
      case GatewayDispatchEvents.MessageDelete:
      case GatewayDispatchEvents.MessageDeleteBulk:
        if (packet.d.guild_id) {
          cancelGiveawayPosts(
            this.container.db,
            packet.d.guild_id,
            packet.t === GatewayDispatchEvents.MessageDeleteBulk ? packet.d.ids : [packet.d.id],
          );
        }
        return;
      case GatewayDispatchEvents.MessageReactionAdd:
      case GatewayDispatchEvents.MessageReactionRemove:
      case GatewayDispatchEvents.MessageReactionRemoveEmoji:
        if (!entryReaction(packet.d.emoji)) return;
        break;
      case GatewayDispatchEvents.MessageReactionRemoveAll:
        break;
      default:
        return;
    }
    if (packet.d.guild_id) {
      requestGiveawayRefresh(this.container.db, packet.d.guild_id, packet.d.message_id, Date.now());
    }
  }
}

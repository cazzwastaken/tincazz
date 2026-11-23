import { Events, Listener } from '@sapphire/framework';
import type { GuildMember, PartialGuildMember } from 'discord.js';
import { logEconomy } from '../features/logs/send.js';
import { members } from '../features/members/config.js';
import { markDeparted } from '../features/members/departures.js';
import { forgetScreening } from '../features/settings/screening.js';

export class MemberLeaveListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'MemberLeave', event: Events.GuildMemberRemove });
  }

  public override run(member: GuildMember | PartialGuildMember) {
    try {
      forgetScreening(member.guild.id, member.user.id);
      if (member.user.bot) return;
      const now = Date.now();
      const wallet = markDeparted(this.container.db, member.guild.id, member.user.id, now);
      if (wallet) {
        void logEconomy(member.guild.id, {
          type: 'member_departed',
          userId: member.user.id,
          balance: wallet.balance,
          purgeAt: now + members.graceMs,
        });
      }
    } catch (error) {
      this.container.logger.error(`member leave handling failed for ${member.user.id}`, error);
    }
  }
}

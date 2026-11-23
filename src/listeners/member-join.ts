import { Events, Listener } from '@sapphire/framework';
import type { GuildMember } from 'discord.js';
import { logEconomy } from '../features/logs/send.js';
import { markPresent } from '../features/members/departures.js';
import { assignAutoRoles } from '../features/settings/assign.js';
import { forgetScreening, rememberScreening } from '../features/settings/screening.js';

export class MemberJoinListener extends Listener {
  public constructor(context: Listener.LoaderContext) {
    super(context, { name: 'MemberJoin', event: Events.GuildMemberAdd });
  }

  public override async run(member: GuildMember) {
    try {
      if (!member.user.bot) {
        const wallet = markPresent(this.container.db, member.guild.id, member.user.id);
        if (wallet) {
          void logEconomy(member.guild.id, {
            type: 'member_restored',
            userId: member.user.id,
            balance: wallet.balance,
          });
        }
      }
      // Members still in membership screening get their roles once they pass it.
      if (member.pending) rememberScreening(member);
      else {
        forgetScreening(member.guild.id, member.user.id);
        await assignAutoRoles(member);
      }
    } catch (error) {
      this.container.logger.error(`member join handling failed for ${member.id}`, error);
    }
  }
}

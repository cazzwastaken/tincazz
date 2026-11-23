import { container } from '@sapphire/framework';
import type { GuildMember } from 'discord.js';
import { logMod } from '../logs/send.js';
import { botCannotAssign, botFacts, moderatorPermissionProblem, roleFacts } from './autorole.js';
import { autoRoles } from './store.js';

/** Gives a new (or just-screened) member the configured auto-roles. Never throws. */
export async function assignAutoRoles(member: GuildMember): Promise<boolean> {
  try {
    const guild = member.guild;
    const ids = autoRoles(container.db, guild.id, member.user.bot ? 'bot' : 'member');
    if (ids.length === 0) return true;

    const bot = botFacts(guild);
    const assignable: string[] = [];
    const failures: { roleId: string; reason: string }[] = [];
    for (const roleId of ids) {
      const role = guild.roles.cache.get(roleId);
      if (!role) {
        failures.push({ roleId, reason: 'role no longer exists' });
        continue;
      }
      const facts = roleFacts(role);
      const reason = botCannotAssign(facts, bot);
      if (reason) {
        failures.push({ roleId, reason });
        continue;
      }
      if (moderatorPermissionProblem(facts)) {
        failures.push({ roleId, reason: 'role has moderator permissions' });
        continue;
      }
      assignable.push(roleId);
    }

    if (assignable.length > 0) {
      try {
        await member.roles.add(assignable, 'auto-role');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const roleId of assignable) failures.push({ roleId, reason });
      }
    }

    if (failures.length > 0) {
      container.logger.warn(
        `Could not assign ${failures.length} auto-role(s) to ${member.user.id} in ${guild.id}`,
      );
      void logMod(guild.id, { type: 'autorole_failed', userId: member.user.id, failures });
    }
    return failures.length === 0;
  } catch (error) {
    container.logger.error(`auto-role assignment failed for ${member.user.id}`, error);
    return false;
  }
}

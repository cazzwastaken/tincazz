import { container } from '@sapphire/framework';
import { type GuildMember, RESTJSONErrorCodes } from 'discord.js';
import { and, eq } from 'drizzle-orm';
import { pendingScreenings as pending } from '../../db/schema.js';
import type { Job } from '../scheduler/runner.js';
import { assignAutoRoles } from './assign.js';

function identity(guildId: string, userId: string) {
  return and(eq(pending.guildId, guildId), eq(pending.userId, userId));
}

export function forgetScreening(guildId: string, userId: string) {
  container.db.delete(pending).where(identity(guildId, userId)).run();
}

export function rememberScreening(member: GuildMember) {
  if (member.joinedTimestamp == null) return;
  const row = {
    guildId: member.guild.id,
    userId: member.user.id,
    joinedAt: member.joinedTimestamp,
  };
  container.db
    .insert(pending)
    .values(row)
    .onConflictDoUpdate({
      target: [pending.guildId, pending.userId],
      set: { joinedAt: row.joinedAt },
    })
    .run();
}

const assigning = new Set<string>();

export async function finishScreening(member: GuildMember, observed = false) {
  if (member.pending !== false || member.joinedTimestamp == null) return;
  const match = and(
    identity(member.guild.id, member.user.id),
    eq(pending.joinedAt, member.joinedTimestamp),
  );
  if (observed) rememberScreening(member);
  else if (!container.db.select().from(pending).where(match).get()) return;
  const key = `${member.guild.id}:${member.user.id}:${member.joinedTimestamp}`;
  if (assigning.has(key)) return;
  assigning.add(key);
  try {
    if (await assignAutoRoles(member)) container.db.delete(pending).where(match).run();
  } finally {
    assigning.delete(key);
  }
}

export const screeningJob: Job = {
  name: 'pending-screenings',
  everyMs: 3_600_000,
  async run(client) {
    for (const row of container.db.select().from(pending).all()) {
      const guild = client.guilds.cache.get(row.guildId);
      if (!guild) continue;
      const match = and(identity(row.guildId, row.userId), eq(pending.joinedAt, row.joinedAt));
      try {
        const member = await guild.members.fetch({ user: row.userId, force: true });
        if (member.joinedTimestamp === row.joinedAt) await finishScreening(member);
        else if (member.joinedTimestamp !== null) container.db.delete(pending).where(match).run();
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === RESTJSONErrorCodes.UnknownMember
        )
          container.db.delete(pending).where(match).run();
        else container.logger.warn('Could not check pending screening', error);
      }
    }
    return true;
  },
};

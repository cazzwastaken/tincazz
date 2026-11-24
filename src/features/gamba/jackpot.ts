import { container } from '@sapphire/framework';

export interface JackpotMember {
  roles: { add(roleId: string, reason?: string): Promise<unknown> };
}

/** Gives the guild's jackpot role to the winner. Never throws: a failure is logged and returns false. */
export async function assignJackpotRole(
  member: JackpotMember | null | undefined,
  userId: string,
  roleId: string,
): Promise<boolean> {
  try {
    if (!member) {
      throw new Error('member not cached');
    }
    await member.roles.add(roleId, 'gamba jackpot');
    return true;
  } catch (error) {
    container.logger.warn(
      `gamba: could not assign jackpot role to ${userId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

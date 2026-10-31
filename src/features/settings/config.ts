import { PermissionFlagsBits } from 'discord.js';

export const autoRoles = { maxPerTarget: 10 } as const;

/** A role with any of these can't be an auto-role: it would hand out moderator powers on join. */
export const dangerousPermissions: bigint =
  PermissionFlagsBits.Administrator |
  PermissionFlagsBits.ManageGuild |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.BanMembers |
  PermissionFlagsBits.KickMembers |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.MentionEveryone |
  PermissionFlagsBits.ManageWebhooks |
  PermissionFlagsBits.ModerateMembers;

/** At most this many channels can be listed for the games in one guild. */
export const gameChannels = { max: 25 } as const;

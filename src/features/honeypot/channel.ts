import {
  ChannelType,
  type GuildMember,
  PermissionFlagsBits,
  type PermissionsBitField,
} from 'discord.js';
import type { DbOrTx } from '../../db/index.js';
import { hallSettings } from '../halloffame/store.js';
import { logKinds } from '../logs/config.js';
import { gameChannels } from '../settings/game-channels.js';
import { logChannelId } from '../settings/store.js';

export interface HoneypotChannelLike {
  id: string;
  type: ChannelType;
  permissionsFor(me: GuildMember): Readonly<PermissionsBitField> | null;
}

/** Why the bot cannot run the honeypot in this channel, or undefined when it can. */
export function honeypotChannelProblem(
  channel: HoneypotChannelLike,
  me: GuildMember,
): string | undefined {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return 'Pick a text or announcement channel.';
  }
  const permissions = channel.permissionsFor(me);
  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages) ||
    !permissions.has(PermissionFlagsBits.ManageMessages)
  ) {
    return `I need View Channel, Send Messages and Manage Messages in <#${channel.id}>.`;
  }
  if (!me.permissions.has(PermissionFlagsBits.BanMembers)) {
    return 'I need the Ban Members permission.';
  }
  return undefined;
}

/** Why this channel can't become the honeypot (a log, game or Hall of Fame channel), or undefined. */
export function honeypotConflict(
  db: DbOrTx,
  guildId: string,
  channelId: string,
): string | undefined {
  if (logKinds.some((kind) => logChannelId(db, guildId, kind) === channelId)) {
    return `<#${channelId}> is a log channel, so it can't be the honeypot.`;
  }
  if (gameChannels(db, guildId).includes(channelId)) {
    return `<#${channelId}> is a game channel, so it can't be the honeypot.`;
  }
  if (hallSettings(db, guildId).channelId === channelId) {
    return `<#${channelId}> is the Hall of Fame channel, so it can't be the honeypot.`;
  }
  return undefined;
}

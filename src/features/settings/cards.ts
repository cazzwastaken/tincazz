import type { ContainerBuilder } from 'discord.js';
import type { AutoRoleTarget } from '../../db/schema.js';
import type { LogKind } from '../logs/config.js';
import { accents, card } from '../ui/index.js';

export const settingsNeedsManageServer =
  'You need the Manage Server permission to use `/settings`.';

export const logChannelAlreadySet = (kind: LogKind, id: string) =>
  `<#${id}> is already the ${kind} log channel.`;

export interface SettingsView {
  autoRoles: Record<AutoRoleTarget, { roleId: string; problem?: string }[]>;
  logs: Record<LogKind, { channelId?: string; problem?: string }>;
  /** Channels the games are limited to; empty means every channel. */
  gameChannels: string[];
}

const warn = (problem?: string) => (problem ? ` ⚠️ ${problem}` : '');

export function settingsCard(view: SettingsView): ContainerBuilder {
  const roles = (target: AutoRoleTarget) => {
    const entries = view.autoRoles[target];
    return entries.length === 0
      ? 'none'
      : entries.map((r) => `<@&${r.roleId}>${warn(r.problem)}`).join(', ');
  };
  const log = (kind: LogKind) => {
    const { channelId, problem } = view.logs[kind];
    return channelId ? `<#${channelId}>${warn(problem)}` : 'not set';
  };
  return card(
    accents.brand,
    [
      '## Settings',
      `**Auto-roles (members):** ${roles('member')}`,
      `**Auto-roles (bots):** ${roles('bot')}`,
      `**Economy log:** ${log('economy')}`,
      `**Mod log:** ${log('mod')}`,
      `**Game channels:** ${view.gameChannels.length === 0 ? 'all channels' : view.gameChannels.map((id) => `<#${id}>`).join(', ')}`,
    ].join('\n'),
  );
}

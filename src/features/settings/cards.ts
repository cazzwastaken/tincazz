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
  /** Undefined means unrestricted; an empty allowlist means games are paused. */
  gameChannels: string[] | undefined;
  honeypot: { channelId?: string; kicks: number; problem?: string };
  jackpotRole: { roleId?: string; problem?: string };
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
  const { channelId: pot, kicks, problem: potProblem } = view.honeypot;
  const { roleId: jackpotRole, problem: jackpotProblem } = view.jackpotRole;
  const allowed = view.gameChannels;
  let games = 'all channels';
  if (allowed) {
    games =
      allowed.length === 0
        ? 'none (games are paused; allow a channel or use `/settings games reset`)'
        : allowed.map((id) => `<#${id}>`).join(', ');
  }
  return card(
    accents.brand,
    [
      '## Settings',
      `**Auto-roles (members):** ${roles('member')}`,
      `**Auto-roles (bots):** ${roles('bot')}`,
      `**Economy log:** ${log('economy')}`,
      `**Mod log:** ${log('mod')}`,
      `**Jackpot role:** ${jackpotRole ? `<@&${jackpotRole}>${warn(jackpotProblem)}` : 'not set (jackpots give no role)'}`,
      `**Game channels:** ${games}`,
      `**Honeypot:** ${pot ? `<#${pot}> · ${kicks.toLocaleString('en-US')} ${kicks === 1 ? 'kick' : 'kicks'}${warn(potProblem)}` : 'not set'}`,
    ].join('\n'),
  );
}

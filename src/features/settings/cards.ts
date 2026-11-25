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
  hallOfFame: { channelId?: string; threshold: number; exempt: string[]; problem?: string };
}

/** Exempt channels listed on the card before it says how many more there are. */
const exemptShown = 15;

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
  const hall = view.hallOfFame;
  const people = `${hall.threshold.toLocaleString('en-US')} ${hall.threshold === 1 ? 'person' : 'people'}`;
  const exempt =
    hall.exempt.length === 0
      ? 'none'
      : `${hall.exempt
          .slice(0, exemptShown)
          .map((id) => `<#${id}>`)
          .join(
            ', ',
          )}${hall.exempt.length > exemptShown ? ` and ${hall.exempt.length - exemptShown} more` : ''}`;
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
      `**Hall of Fame:** ${hall.channelId ? `<#${hall.channelId}> · ${people}${warn(hall.problem)}` : `not set (threshold ${people})`}`,
      `**Hall of Fame exempt:** ${exempt}`,
      '-# The Hall of Fame always skips private threads, age-restricted channels (unless the hall is too), channels that someone who can see the hall cannot see, or hides from someone with a View Channel deny that the hall lacks (the check compares channel permissions and errs on the side of refusing, exempt a channel to be sure), bots, webhooks and system messages.',
    ].join('\n'),
  );
}

import type { ContainerBuilder } from 'discord.js';
import { members } from '../members/config.js';
import { accents, card, coins, discordTime } from '../ui/index.js';
import type { EconomyEvent, ModEvent } from './events.js';

function build(accent: number, title: string, lines: string[], now: number): ContainerBuilder {
  return card(accent, [`### ${title}`, ...lines, `-# <t:${Math.floor(now / 1000)}:f>`].join('\n'));
}

const mention = (id: string) => `<@${id}>`;

const clearedSettingLabels = {
  autorole: (id: string) => `Auto-role <@&${id}>`,
  jackpot_role: (id: string) => `Jackpot role <@&${id}>`,
  log_channel: (id: string) => `Log channel <#${id}>`,
  honeypot: (id: string) => `Honeypot channel <#${id}>`,
  game_channel: (id: string) => `Game channel <#${id}>`,
  hall_of_fame: (id: string) => `Hall of Fame channel <#${id}>`,
  hall_exempt: (id: string) => `Hall of Fame exempt channel <#${id}>`,
} as const;

export function economyLogCard(event: EconomyEvent, now: number): ContainerBuilder {
  switch (event.type) {
    case 'admin_adjust':
      return build(
        accents.brand,
        event.action === 'give' ? 'Coins given' : 'Coins taken',
        [
          `${mention(event.actorId)} ${event.action === 'give' ? 'gave' : 'took'} ${coins(event.amount)} coins ${event.action === 'give' ? 'to' : 'from'} ${mention(event.userId)}`,
          `Reason: ${event.reason}`,
          `New balance: ${coins(event.balance)}`,
        ],
        now,
      );
    case 'jackpot':
      return build(
        accents.gold,
        'Jackpot',
        [
          `${mention(event.userId)} hit the jackpot with a ${coins(event.bet)} bet`,
          `Payout: ${coins(event.payout)} (pot ${coins(event.potWon)})`,
          event.roleAssigned ? 'Jackpot role assigned' : 'Jackpot role not assigned',
        ],
        now,
      );
    case 'member_departed':
      return build(
        accents.loss,
        'Member departed',
        [
          `${mention(event.userId)} left with ${coins(event.balance)} coins`,
          `Wallet purged <t:${Math.floor(event.purgeAt / 1000)}:R>`,
        ],
        now,
      );
    case 'member_restored':
      return build(
        accents.brand,
        'Member restored',
        [`${mention(event.userId)} returned, wallet restored with ${coins(event.balance)} coins`],
        now,
      );
    case 'reconcile_summary': {
      const listed =
        event.purged.length > members.maxListedPurges
          ? `Purged ${event.purged.length} wallets`
          : event.purged.length > 0
            ? `Purged: ${event.purged.map(mention).join(' ')}`
            : 'Purged: none';
      return build(
        event.purged.length > 0 ? accents.loss : accents.brand,
        'Member reconciliation',
        [
          `Departed: ${event.departed}, restored: ${event.restored}`,
          listed,
          `Coins removed: ${coins(event.coinsRemoved)}`,
        ],
        now,
      );
    }
  }
}

export function modLogCard(event: ModEvent, now: number): ContainerBuilder {
  switch (event.type) {
    case 'autorole_added':
    case 'autorole_removed':
      return build(
        accents.brand,
        event.type === 'autorole_added' ? 'Auto-role added' : 'Auto-role removed',
        [
          `${mention(event.actorId)} ${event.type === 'autorole_added' ? 'added' : 'removed'} <@&${event.roleId}> for ${event.target}`,
        ],
        now,
      );
    case 'log_channel_set':
      return build(
        accents.brand,
        'Log channel set',
        [
          `${mention(event.actorId)} set the ${event.kind} log to <#${event.toChannelId}>`,
          ...(event.fromChannelId ? [`Previously <#${event.fromChannelId}>`] : []),
        ],
        now,
      );
    case 'log_channel_cleared':
      return build(
        accents.brand,
        'Log channel cleared',
        [`${mention(event.actorId)} cleared the ${event.kind} log (was <#${event.fromChannelId}>)`],
        now,
      );
    case 'setting_auto_cleared':
      return build(
        accents.loss,
        'Setting cleared automatically',
        [`${clearedSettingLabels[event.setting](event.id)} was removed`, event.detail],
        now,
      );
    case 'autorole_failed':
      return build(
        accents.error,
        'Auto-role failed',
        [
          `Could not give roles to ${mention(event.userId)}`,
          ...event.failures.map((f) => `<@&${f.roleId}>: ${f.reason}`),
        ],
        now,
      );
    case 'honeypot_kick':
      return build(
        accents.loss,
        'Honeypot kick',
        [
          `${mention(event.userId)} was kicked for triggering the honeypot in <#${event.channelId}>`,
          `User ID: ${event.userId} · Created: ${discordTime(event.createdAt)}${event.joinedAt === undefined ? '' : ` · Joined: ${discordTime(event.joinedAt)}`}`,
          ...(event.dmSent ? [] : ['DM not delivered']),
          ...(event.unbanFailed ? ['⚠️ still banned, unban failed'] : []),
        ],
        now,
      );
    case 'honeypot_failed':
      return build(
        accents.error,
        'Honeypot failed',
        [
          `Could not softban ${mention(event.userId)} after they posted in <#${event.channelId}>: ${event.reason}`,
          event.messageDeleted ? 'Their message was deleted' : 'Their message could not be deleted',
        ],
        now,
      );
    case 'honeypot_set':
      return build(
        accents.brand,
        'Honeypot set',
        [
          `${mention(event.actorId)} set the honeypot to <#${event.toChannelId}>`,
          ...(event.fromChannelId ? [`Previously <#${event.fromChannelId}>`] : []),
        ],
        now,
      );
    case 'honeypot_cleared':
      return build(
        accents.brand,
        'Honeypot cleared',
        [`${mention(event.actorId)} cleared the honeypot (was <#${event.fromChannelId}>)`],
        now,
      );
    case 'hall_set':
      return build(
        accents.brand,
        'Hall of Fame set',
        [
          `${mention(event.actorId)} set the Hall of Fame to <#${event.toChannelId}> (${event.threshold} people)`,
          ...(event.fromChannelId ? [`Previously <#${event.fromChannelId}>`] : []),
        ],
        now,
      );
    case 'hall_cleared':
      return build(
        accents.brand,
        'Hall of Fame cleared',
        [
          `${mention(event.actorId)} cleared the Hall of Fame (was <#${event.fromChannelId}>)`,
          'Existing posts stay where they are',
        ],
        now,
      );
    case 'hall_threshold':
      return build(
        accents.brand,
        'Hall of Fame threshold changed',
        [
          `${mention(event.actorId)} changed the threshold from ${event.from} to ${event.to} people`,
        ],
        now,
      );
    case 'hall_exempt_added':
    case 'hall_exempt_removed':
      return build(
        accents.brand,
        event.type === 'hall_exempt_added'
          ? 'Hall of Fame exemption added'
          : 'Hall of Fame exemption removed',
        [
          `${mention(event.actorId)} ${event.type === 'hall_exempt_added' ? 'exempted' : 'stopped exempting'} <#${event.channelId}> ${event.type === 'hall_exempt_added' ? 'from' : 'for'} the Hall of Fame`,
        ],
        now,
      );
  }
}

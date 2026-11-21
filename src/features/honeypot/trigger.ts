import { container } from '@sapphire/framework';
import { PermissionFlagsBits } from 'discord.js';
import type { DbOrTx } from '../../db/index.js';
import type { ModEvent } from '../logs/index.js';
import { banProblem } from './bannable.js';
import { honeypotDm, honeypotExemptDm } from './cards.js';
import { honeypotConfig } from './config.js';
import { classifyAuthor } from './decide.js';
import { finish, guardKey, tryBegin } from './guard.js';
import { honeypot, incrementKicks } from './store.js';

export interface HoneypotMember {
  joinedTimestamp: number | null;
  permissions: { has(permission: bigint): boolean };
  roles: { highest: { position: number } };
}

export interface HoneypotGuild {
  id: string;
  name: string;
  ownerId: string;
  members: { me: HoneypotMember | null; fetch(userId: string): Promise<HoneypotMember> };
  bans: {
    create(
      userId: string,
      options: { deleteMessageSeconds: number; reason: string },
    ): Promise<unknown>;
    remove(userId: string, reason: string): Promise<unknown>;
  };
}

export interface HoneypotMessage {
  guildId: string | null;
  channelId: string;
  webhookId: string | null;
  system: boolean;
  author: {
    id: string;
    bot: boolean;
    createdTimestamp: number;
    send(options: { content: string }): Promise<unknown>;
  };
  member: HoneypotMember | null;
  guild: HoneypotGuild | null;
  delete(): Promise<unknown>;
}

export interface TriggerDeps {
  db: DbOrTx;
  botUserId: string;
  now(): number;
  log(guildId: string, event: ModEvent): void;
  refreshCard(guildId: string): void;
  /** Defaults to `honeypotConfig.dmTimeoutMs`. */
  dmTimeoutMs?: number;
}

export type TriggerOutcome = 'ignored' | 'busy' | 'failed' | 'softbanned';

export const banRequestFailed = 'the ban request failed';

function deleteMessage(message: HoneypotMessage): Promise<boolean> {
  try {
    return message.delete().then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** Sends the DM, giving up after `timeoutMs`; true only when the send resolved first. */
async function sendDm(message: HoneypotMessage, content: string, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const sent = (async () => {
      await message.author.send({ content });
      return true;
    })().catch(() => false);
    return await Promise.race([sent, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Softbans whoever posts in the guild's honeypot channel: DM, ban with a one hour message wipe,
 * unban at once, count the kick and log it. Exempt people only get a DM. Never throws.
 */
export async function handleHoneypotMessage(
  message: HoneypotMessage,
  deps: TriggerDeps,
): Promise<TriggerOutcome> {
  try {
    const { guildId, guild, author } = message;
    if (guildId === null || guild === null) {
      return 'ignored';
    }
    // A thread's channelId is the thread, so threads under the honeypot are ignored too.
    if (honeypot(deps.db, guildId).channelId !== message.channelId) {
      return 'ignored';
    }

    const member =
      message.member ??
      (await Promise.resolve()
        .then(() => guild.members.fetch(author.id))
        .catch(() => null));

    const decision = classifyAuthor({
      isBot: author.bot,
      isWebhook: message.webhookId !== null,
      isSystem: message.system,
      isSelf: author.id === deps.botUserId,
      isStaff: member?.permissions.has(honeypotConfig.staffPermission) ?? false,
      isOwner: guild.ownerId === author.id,
    });
    if (decision === 'ignore') {
      return 'ignored';
    }
    const dmTimeoutMs = deps.dmTimeoutMs ?? honeypotConfig.dmTimeoutMs;
    if (decision === 'notify') {
      await sendDm(message, honeypotExemptDm(guild.name), dmTimeoutMs);
      return 'ignored';
    }

    const key = guardKey(guildId, author.id);
    const claim = tryBegin(key, deps.now());
    if (!claim.begun) {
      // In flight, softbanned or failed: the account is already handled (and logged once), but a
      // ban wipe may never come (failed, or a burst before it) or has already passed (a quick
      // rejoin). Keep the channel clean without flooding the mod log.
      await deleteMessage(message);
      return 'busy';
    }

    let outcome: 'softbanned' | 'failed' = 'failed';
    try {
      const failed = async (reason: string): Promise<'failed'> => {
        const messageDeleted = await deleteMessage(message);
        deps.log(guildId, {
          type: 'honeypot_failed',
          userId: author.id,
          channelId: message.channelId,
          reason,
          messageDeleted,
        });
        return 'failed';
      };

      const me = guild.members.me;
      const problem = banProblem({
        botCanBan: me?.permissions.has(PermissionFlagsBits.BanMembers) ?? false,
        targetIsOwner: guild.ownerId === author.id,
        targetHighest: member?.roles.highest.position,
        botHighest: me?.roles.highest.position ?? -1,
      });
      if (problem !== undefined) {
        return await failed(problem);
      }

      const dmSent = await sendDm(message, honeypotDm(guild.name), dmTimeoutMs);

      const banned = await Promise.resolve()
        .then(() =>
          guild.bans.create(author.id, {
            deleteMessageSeconds: honeypotConfig.deleteMessageSeconds,
            reason: honeypotConfig.banReason,
          }),
        )
        .then(
          () => true,
          () => false,
        );
      if (!banned) {
        return await failed(banRequestFailed);
      }

      const unbanFailed = await Promise.resolve()
        .then(() => guild.bans.remove(author.id, honeypotConfig.unbanReason))
        .then(
          () => false,
          () => true,
        );

      incrementKicks(deps.db, guildId, deps.now());
      outcome = 'softbanned';
      deps.refreshCard(guildId);
      deps.log(guildId, {
        type: 'honeypot_kick',
        userId: author.id,
        channelId: message.channelId,
        createdAt: author.createdTimestamp,
        joinedAt: member?.joinedTimestamp ?? undefined,
        dmSent,
        unbanFailed,
      });
      return 'softbanned';
    } finally {
      finish(key, deps.now(), outcome);
    }
  } catch (error) {
    container.logger.warn('Honeypot: could not handle a message', error);
    return 'failed';
  }
}

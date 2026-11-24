import type { ContainerBuilder } from 'discord.js';
import type { Db } from '../../db/index.js';
import { getOrCreateWallet } from '../economy/wallets.js';
import { spinLogEvent } from '../logs/economy.js';
import { logEconomy } from '../logs/send.js';
import { jackpotRoleId } from '../settings/store.js';
import { parseBet } from './bet.js';
import { announcementCard, wagerCard } from './cards.js';
import { wager } from './config.js';
import type { Spin } from './index.js';
import { playWager } from './play.js';
import type { RandomInt } from './roll.js';

export interface SpinRequest {
  guildId: string;
  userId: string;
  /** Absent or blank means the default bet. */
  bet?: string;
}

export interface SpinMessages {
  /** The settled bet, for the reel frames shown before the card. */
  bet: number;
  card: ContainerBuilder;
  announcement?: ContainerBuilder;
}

export interface SpinOptions {
  /** Called only on a jackpot in a guild that has a jackpot role set. */
  assignJackpotRole: (roleId: string) => Promise<boolean>;
  randomInt?: RandomInt;
}

export interface SettledSpin {
  played: Spin;
  /** The guild's jackpot role, when one is set. */
  jackpotRoleId?: string;
  /** Set only on a jackpot with a role set: whether the role could be assigned. */
  roleAssigned?: boolean;
}

/**
 * Settles one spin. Bet and funds errors propagate before anything is written; the jackpot role is
 * assigned only after the spin has committed.
 */
export async function settleSpin(
  db: Db,
  request: SpinRequest,
  now: number,
  options: SpinOptions,
): Promise<SettledSpin> {
  const { guildId, userId } = request;
  const bet = request.bet?.trim() || String(wager.defaultBet);

  const played = playWager(
    db,
    guildId,
    userId,
    parseBet(bet, getOrCreateWallet(db, guildId, userId, now).balance, wager),
    now,
    options.randomInt,
  );

  const roleId = jackpotRoleId(db, guildId);
  const jackpot = played.evaluation.result === 'jackpot';
  const roleAssigned =
    jackpot && roleId !== undefined ? await options.assignJackpotRole(roleId) : undefined;
  return { played, jackpotRoleId: roleId, roleAssigned };
}

/** Settles one spin and builds its v2 card messages. */
export async function spin(
  db: Db,
  request: SpinRequest,
  now: number,
  options: SpinOptions,
): Promise<SpinMessages> {
  const {
    played,
    roleAssigned,
    jackpotRoleId: roleId,
  } = await settleSpin(db, request, now, options);
  const { userId } = request;
  // Fire and forget, after the commit: a slow or broken log channel never delays or fails a spin.
  const event = spinLogEvent(userId, played, roleAssigned);
  if (event) void logEconomy(request.guildId, event);
  const { result } = played.evaluation;
  const card = wagerCard(userId, played);
  const announced = result === 'triple' || result === 'jackpot';
  return announced
    ? {
        bet: played.bet,
        card,
        announcement: announcementCard(userId, played, roleAssigned, roleId),
      }
    : { bet: played.bet, card };
}

import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/index.js';
import { type FlipMode, type FlipSide, flips } from '../../db/schema.js';
import { credit, debit } from '../economy/ledger.js';
import { getOrCreateWallet } from '../economy/wallets.js';
import { parseBet } from '../gamba/bet.js';
import { addToPot } from '../gamba/pot.js';
import type { RandomInt } from '../gamba/roll.js';
import { wager } from './config.js';
import { ChallengeTakenError, ShortStakeError } from './errors.js';
import { flipCoin } from './flip.js';
import { botFlipRake, flipRake } from './rake.js';
import { recordFlipStats } from './stats.js';

export interface BotFlip {
  bet: number;
  side: FlipSide;
  result: FlipSide;
  won: boolean;
  rake: number;
  /** Coins paid back to the player: `2 × bet − rake` on a win, 0 on a loss. */
  credited: number;
  balance: number;
  pot: number;
  flipId: number;
}

export interface BotFlipRequest {
  guildId: string;
  userId: string;
  /** Absent or blank means the default bet. */
  bet?: string;
  side: FlipSide;
}

/**
 * Flips against the bot and settles it (stake, payout, rake from a win into the pot, flip row, stats) in one
 * transaction. Bet and funds errors propagate before anything but the wallet is written.
 */
export function settleBotFlip(
  db: Db,
  request: BotFlipRequest,
  now: number,
  randomInt?: RandomInt,
): BotFlip {
  const { guildId, userId, side } = request;
  const wallet = getOrCreateWallet(db, guildId, userId, now);
  const bet = parseBet(request.bet?.trim() || String(wager.defaultBet), wallet.balance, wager);

  return db.transaction((tx) => {
    const result = flipCoin(randomInt);
    const won = result === side;
    // The bot's rake comes off a win only: a loss costs the bet and adds nothing to the pot.
    const rake = won ? botFlipRake(bet, randomInt) : 0;
    const credited = won ? 2 * bet - rake : 0;
    const { id: flipId } = tx
      .insert(flips)
      .values({
        guildId,
        mode: 'bot',
        challengerId: userId,
        opponentId: null,
        bet,
        challengerSide: side,
        resultSide: result,
        winnerId: won ? userId : null,
        rake,
        messageId: null,
        createdAt: now,
      })
      .returning({ id: flips.id })
      .get();
    let balance = debit(tx, { guildId, userId, amount: bet, reason: 'flip_bet', now, ref: flipId });
    if (won) {
      balance = credit(tx, {
        guildId,
        userId,
        amount: credited,
        reason: 'flip_win',
        now,
        ref: flipId,
      });
    }
    const pot = addToPot(tx, guildId, rake);
    recordFlipStats(tx, guildId, userId, { bet, won, credited, vsBot: true });
    return { bet, side, result, won, rake, credited, balance, pot, flipId };
  });
}

export interface ChallengeRequest {
  guildId: string;
  messageId: string;
  mode: Exclude<FlipMode, 'bot'>;
  challengerId: string;
  acceptorId: string;
  bet: number;
  challengerSide: FlipSide;
}

export interface SettledChallenge {
  result: FlipSide;
  winnerId: string;
  loserId: string;
  rake: number;
  /** Coins paid to the winner: `2 × bet − rake`. */
  credited: number;
  challengerBalance: number;
  acceptorBalance: number;
  pot: number;
  flipId: number;
}

function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return true;
    }
  }
  return false;
}

/** Whether a challenge message already has its flip, which outlives the in-memory registry. */
export function isChallengeSettled(tx: DbOrTx, messageId: string): boolean {
  return (
    tx.select({ id: flips.id }).from(flips).where(eq(flips.messageId, messageId)).get() !==
    undefined
  );
}

/**
 * Settles an accepted challenge in one transaction, wallets included: any throw leaves the
 * database unchanged. Each message settles at most once (the UNIQUE `message_id` is the backstop
 * across restarts), and both stakes are checked at settle time, not at challenge time.
 */
export function settleChallenge(
  db: Db,
  request: ChallengeRequest,
  now: number,
  randomInt?: RandomInt,
): SettledChallenge {
  const { guildId, messageId, mode, challengerId, acceptorId, bet, challengerSide } = request;

  return db.transaction((tx) => {
    if (isChallengeSettled(tx, messageId)) {
      throw new ChallengeTakenError();
    }
    const challenger = getOrCreateWallet(tx, guildId, challengerId, now);
    if (challenger.balance < bet) {
      throw new ShortStakeError('challenger', challengerId, challenger.balance, bet);
    }
    const acceptor = getOrCreateWallet(tx, guildId, acceptorId, now);
    if (acceptor.balance < bet) {
      throw new ShortStakeError('acceptor', acceptorId, acceptor.balance, bet);
    }

    const result = flipCoin(randomInt);
    const challengerWon = result === challengerSide;
    const winnerId = challengerWon ? challengerId : acceptorId;
    const loserId = challengerWon ? acceptorId : challengerId;
    const rake = flipRake(bet);
    const credited = 2 * bet - rake;

    let flipId: number;
    try {
      ({ id: flipId } = tx
        .insert(flips)
        .values({
          guildId,
          mode,
          challengerId,
          opponentId: acceptorId,
          bet,
          challengerSide,
          resultSide: result,
          winnerId,
          rake,
          messageId,
          createdAt: now,
        })
        .returning({ id: flips.id })
        .get());
    } catch (error) {
      throw isUniqueViolation(error) ? new ChallengeTakenError() : error;
    }

    const stake = (userId: string) =>
      debit(tx, { guildId, userId, amount: bet, reason: 'flip_bet', now, ref: flipId });
    let challengerBalance = stake(challengerId);
    let acceptorBalance = stake(acceptorId);
    const winnings = credit(tx, {
      guildId,
      userId: winnerId,
      amount: credited,
      reason: 'flip_win',
      now,
      ref: flipId,
    });
    if (challengerWon) {
      challengerBalance = winnings;
    } else {
      acceptorBalance = winnings;
    }
    const pot = addToPot(tx, guildId, rake);
    recordFlipStats(tx, guildId, winnerId, { bet, won: true, credited, vsBot: false });
    recordFlipStats(tx, guildId, loserId, { bet, won: false, credited: 0, vsBot: false });
    return {
      result,
      winnerId,
      loserId,
      rake,
      credited,
      challengerBalance,
      acceptorBalance,
      pot,
      flipId,
    };
  });
}

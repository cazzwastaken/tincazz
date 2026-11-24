import type { Db } from '../../db/index.js';
import { rolls } from '../../db/schema.js';
import { credit, debit } from '../economy/ledger.js';
import { getOrCreateWallet } from '../economy/wallets.js';
import { parseBet } from '../gamba/bet.js';
import { addToPot } from '../gamba/pot.js';
import type { RandomInt } from '../gamba/roll.js';
import type { DiceCall } from './calls.js';
import { wager } from './config.js';
import { diceEdge, payoutFor, rollDice, wins } from './rules.js';
import { recordRollStats } from './stats.js';

export interface RollRequest {
  guildId: string;
  userId: string;
  /** Absent or blank means the default bet. */
  bet?: string;
  call: DiceCall;
}

export interface Roll {
  bet: number;
  call: DiceCall;
  die1: number;
  die2: number;
  total: number;
  won: boolean;
  /** Coins paid back to the player on a win, 0 on a loss. */
  payout: number;
  /** Coins added to the pot as the house edge. */
  edge: number;
  balance: number;
  pot: number;
  rollId: number;
}

/**
 * Rolls two dice for a call and settles it (stake, payout, edge into the pot, roll row, stats) in
 * one transaction. Bet and funds errors propagate before anything but the wallet is written.
 */
export function settleRoll(db: Db, request: RollRequest, now: number, randomInt?: RandomInt): Roll {
  const { guildId, userId, call } = request;
  const wallet = getOrCreateWallet(db, guildId, userId, now);
  const bet = parseBet(request.bet?.trim() || String(wager.defaultBet), wallet.balance, wager);

  return db.transaction((tx) => {
    const [die1, die2] = rollDice(randomInt);
    const won = wins(call, die1, die2);
    const payout = won ? payoutFor(call, bet, randomInt) : 0;
    const edge = diceEdge(bet, randomInt);
    const { id: rollId } = tx
      .insert(rolls)
      .values({
        guildId,
        userId,
        bet,
        call: call.kind,
        target: call.kind === 'exact' ? call.target : null,
        die1,
        die2,
        won: won ? 1 : 0,
        payout,
        edge,
        createdAt: now,
      })
      .returning({ id: rolls.id })
      .get();
    let balance = debit(tx, { guildId, userId, amount: bet, reason: 'dice_bet', now, ref: rollId });
    if (won) {
      balance = credit(tx, {
        guildId,
        userId,
        amount: payout,
        reason: 'dice_win',
        now,
        ref: rollId,
      });
    }
    const pot = addToPot(tx, guildId, edge);
    recordRollStats(tx, guildId, userId, { bet, won, payout });
    return { bet, call, die1, die2, total: die1 + die2, won, payout, edge, balance, pot, rollId };
  });
}

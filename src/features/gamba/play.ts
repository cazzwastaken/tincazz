import type { Db } from '../../db/index.js';
import { spins } from '../../db/schema.js';
import { settleStake } from '../economy/ledger.js';
import { getOrCreateWallet } from '../economy/wallets.js';
import { type Evaluation, evaluate } from './evaluate.js';
import { type Reels, spinGamba } from './index.js';
import { settlePot } from './pot.js';
import type { RandomInt } from './roll.js';
import { recordWagerSpinStats } from './stats.js';

export interface WagerSpin {
  mode: 'wager';
  reels: Reels;
  evaluation: Evaluation;
  bet: number;
  payout: number;
  potWon: number;
  balance: number;
  pot: number;
  spinId: number;
}

/**
 * Rolls a wagered spin and settles it (bet, payout, pot, spin row, stats) in one transaction.
 * `bet` must already be validated with `parseBet`; an unaffordable bet throws and changes nothing.
 */
export function playWager(
  db: Db,
  guildId: string,
  userId: string,
  bet: number,
  now: number,
  randomInt?: RandomInt,
): WagerSpin {
  const reels = spinGamba(randomInt);
  const evaluation = evaluate(reels);
  const payout = Math.floor((bet * evaluation.payoutBps) / 10_000);

  return db.transaction((tx) => {
    getOrCreateWallet(tx, guildId, userId, now);
    const { potWon, pot } = settlePot(tx, guildId, bet, evaluation.tier, userId, now);
    const { id: spinId } = tx
      .insert(spins)
      .values({
        guildId,
        userId,
        mode: 'wager',
        reels: reels.join(','),
        result: evaluation.result,
        bet,
        payout,
        potWon,
        createdAt: now,
      })
      .returning({ id: spins.id })
      .get();
    const balance = settleStake(tx, {
      guildId,
      userId,
      now,
      ref: spinId,
      bet,
      betReason: 'bet',
      payouts: [
        { amount: payout, reason: 'payout' },
        { amount: potWon, reason: 'pot_win' },
      ],
    });
    recordWagerSpinStats(tx, guildId, userId, { evaluation, bet, payout, potWon });
    return { mode: 'wager', reels, evaluation, bet, payout, potWon, balance, pot, spinId };
  });
}

import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { type LedgerReason, ledger } from '../../db/schema.js';

export interface CoinHistoryEntry {
  delta: number;
  reason: LedgerReason;
  balanceAfter: number;
  createdAt: number;
}

/** The latest player-visible ledger entries, even after a wallet is removed. */
export function coinHistory(db: DbOrTx, guildId: string, userId: string): CoinHistoryEntry[] {
  return db
    .select({
      delta: ledger.delta,
      reason: ledger.reason,
      balanceAfter: ledger.balanceAfter,
      createdAt: ledger.createdAt,
    })
    .from(ledger)
    .where(and(eq(ledger.guildId, guildId), eq(ledger.userId, userId)))
    .orderBy(desc(ledger.id))
    .limit(10)
    .all();
}

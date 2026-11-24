import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { playerStats } from '../../db/schema.js';

/**
 * Counts a flip in `player_stats`; `credited` is what the player was paid (0 on a loss). `vsBot`
 * flips also feed the bot-only totals the coinflip leaderboard ranks: a flip between two players
 * only moves coins from one to the other, so ranking it would reward trading coins back and forth.
 */
export function recordFlipStats(
  tx: DbOrTx,
  guildId: string,
  userId: string,
  flip: { bet: number; won: boolean; credited: number; vsBot: boolean },
): void {
  const win = flip.won ? 1 : 0;
  const botWagered = flip.vsBot ? flip.bet : 0;
  const botWon = flip.vsBot ? flip.credited : 0;
  tx.insert(playerStats)
    .values({
      guildId,
      userId,
      flips: 1,
      flipWins: win,
      flipWagered: flip.bet,
      flipWon: flip.credited,
      botFlipWagered: botWagered,
      botFlipWon: botWon,
    })
    .onConflictDoUpdate({
      target: [playerStats.guildId, playerStats.userId],
      set: {
        flips: sql`${playerStats.flips} + 1`,
        flipWins: sql`${playerStats.flipWins} + ${win}`,
        flipWagered: sql`${playerStats.flipWagered} + ${flip.bet}`,
        flipWon: sql`${playerStats.flipWon} + ${flip.credited}`,
        botFlipWagered: sql`${playerStats.botFlipWagered} + ${botWagered}`,
        botFlipWon: sql`${playerStats.botFlipWon} + ${botWon}`,
      },
    })
    .run();
}

import { and, asc, desc, eq, gt, isNull, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbOrTx } from '../../db/index.js';
import { playerStats, wallets } from '../../db/schema.js';
import { type LeaderboardCategory, leaderboardPageSize } from './config.js';

export interface BoardRow {
  userId: string;
  value: number;
  rank: number;
}

export interface LeaderboardPage {
  rows: BoardRow[];
  /** The page actually shown, counted from 0, after clamping. */
  page: number;
  pageCount: number;
}

interface Source {
  table: SQLiteTable;
  guildId: SQLiteColumn;
  userId: SQLiteColumn;
  value: SQL<number>;
  /** Extra conditions on the source's table: departed members never rank. */
  present?: SQL;
}

function source(category: LeaderboardCategory): Source {
  switch (category) {
    case 'coins':
      return {
        table: wallets,
        ...columns(wallets),
        value: sql<number>`${wallets.balance}`,
        present: isNull(wallets.departedAt),
      };
    case 'biggest-win':
      return {
        table: playerStats,
        ...columns(playerStats),
        present: playerPresent,
        value: sql<number>`${playerStats.biggestWin}`,
      };
    case 'jackpots':
      return {
        table: playerStats,
        ...columns(playerStats),
        present: playerPresent,
        value: sql<number>`${playerStats.jackpots}`,
      };
    case 'profit':
      return {
        table: playerStats,
        ...columns(playerStats),
        present: playerPresent,
        value: sql<number>`(${playerStats.won} - ${playerStats.wagered})`,
      };
    case 'coinflip':
      return {
        table: playerStats,
        ...columns(playerStats),
        present: playerPresent,
        // Flips against the bot only: player-versus-player flips just trade coins, so they cannot be
        // farmed between two accounts.
        value: sql<number>`(${playerStats.botFlipWon} - ${playerStats.botFlipWagered})`,
      };
    case 'dice':
      return {
        table: playerStats,
        ...columns(playerStats),
        present: playerPresent,
        value: sql<number>`(${playerStats.rollWon} - ${playerStats.rollWagered})`,
      };
    case 'spins':
      return {
        table: playerStats,
        ...columns(playerStats),
        present: playerPresent,
        value: sql<number>`${playerStats.spins}`,
      };
  }
}

const playerPresent = sql`exists (select 1 from ${wallets} where ${wallets.guildId} = ${playerStats.guildId} and ${wallets.userId} = ${playerStats.userId} and ${wallets.departedAt} is null)`;

function columns(table: typeof wallets | typeof playerStats) {
  return { guildId: table.guildId, userId: table.userId };
}

export function leaderboardPage(
  db: DbOrTx,
  guildId: string,
  category: LeaderboardCategory,
  page: number,
): LeaderboardPage {
  const { table, guildId: guildColumn, userId, value, present } = source(category);
  const qualifying = and(eq(guildColumn, guildId), gt(value, 0), present);
  const total =
    db.select({ count: sql<number>`count(*)` }).from(table).where(qualifying).get()?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / leaderboardPageSize));
  const shown = Math.min(Math.max(0, page), pageCount - 1);
  const rows = db
    .select({ userId, value })
    .from(table)
    .where(qualifying)
    .orderBy(desc(value), asc(sql`cast(${userId} as integer)`))
    .limit(leaderboardPageSize)
    .offset(shown * leaderboardPageSize)
    .all() as { userId: string; value: number }[];
  return {
    rows: rows.map((row, index) => ({
      userId: row.userId,
      value: row.value,
      rank: shown * leaderboardPageSize + index + 1,
    })),
    page: shown,
    pageCount,
  };
}

export function leaderboardRank(
  db: DbOrTx,
  guildId: string,
  category: LeaderboardCategory,
  userId: string,
): { rank: number; value: number } | undefined {
  const { table, guildId: guildColumn, userId: userColumn, value, present } = source(category);
  const own = db
    .select({ value })
    .from(table)
    .where(and(eq(guildColumn, guildId), eq(userColumn, userId), present))
    .get() as { value: number } | undefined;
  if (!own || own.value <= 0) {
    return undefined;
  }
  const ahead = db
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(
      and(
        eq(guildColumn, guildId),
        present,
        or(
          gt(value, own.value),
          and(
            eq(value, own.value),
            sql`cast(${userColumn} as integer) < cast(${userId} as integer)`,
          ),
        ),
      ),
    )
    .get();
  return { rank: 1 + (ahead?.count ?? 0), value: own.value };
}

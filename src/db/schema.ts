import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const ledgerReasons = [
  'start',
  'daily',
  'cashback',
  'bailout',
  'collect',
  'chat',
  'free_prize', // legacy: free spins are gone, rows stay in history
  'bet',
  'payout',
  'pot_win',
  'flip_bet',
  'flip_win',
  'dice_bet',
  'dice_win',
  'admin_grant',
  'admin_take',
  'pruned',
] as const;
// 'free' is legacy (free spins are gone); old rows keep it.
export const spinModes = ['free', 'wager'] as const;
export const flipModes = ['bot', 'challenge', 'open'] as const;
export const autoRoleTargets = ['member', 'bot'] as const;
export const flipSides = ['heads', 'tails'] as const;
export const spinResults = ['none', 'pair', 'triple', 'jackpot'] as const;
export const diceCallKinds = ['high', 'low', 'seven', 'doubles', 'exact'] as const;

export type LedgerReason = (typeof ledgerReasons)[number];
export type SpinMode = (typeof spinModes)[number];
export type FlipMode = (typeof flipModes)[number];
export type FlipSide = (typeof flipSides)[number];
export type AutoRoleTarget = (typeof autoRoleTargets)[number];
export type SpinResult = (typeof spinResults)[number];
export type DiceCallKind = (typeof diceCallKinds)[number];

export const wallets = sqliteTable(
  'wallets',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    balance: integer('balance').notNull(),
    dailyStreak: integer('daily_streak').notNull().default(0),
    lastDailyAt: integer('last_daily_at'),
    lastBailoutAt: integer('last_bailout_at'),
    lastChatRewardAt: integer('last_chat_reward_at'),
    lastCollectAt: integer('last_collect_at'),
    departedAt: integer('departed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    check('wallets_balance_non_negative', sql`${table.balance} >= 0`),
    index('wallets_guild_balance_idx').on(table.guildId, table.balance),
    index('wallets_guild_departed_idx').on(table.guildId, table.departedAt),
  ],
);

export const ledger = sqliteTable(
  'ledger',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason', { enum: ledgerReasons }).notNull(),
    ref: integer('ref'),
    actorId: text('actor_id'),
    note: text('note'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('ledger_user_idx').on(table.guildId, table.userId, table.id)],
);

export const spins = sqliteTable(
  'spins',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    mode: text('mode', { enum: spinModes }).notNull(),
    reels: text('reels').notNull(),
    result: text('result', { enum: spinResults }).notNull(),
    bet: integer('bet').notNull().default(0),
    payout: integer('payout').notNull().default(0),
    potWon: integer('pot_won').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('spins_user_idx').on(table.guildId, table.userId)],
);

export const flips = sqliteTable(
  'flips',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    mode: text('mode', { enum: flipModes }).notNull(),
    challengerId: text('challenger_id').notNull(),
    opponentId: text('opponent_id'),
    bet: integer('bet').notNull(),
    challengerSide: text('challenger_side', { enum: flipSides }).notNull(),
    resultSide: text('result_side', { enum: flipSides }).notNull(),
    winnerId: text('winner_id'),
    rake: integer('rake').notNull(),
    messageId: text('message_id').unique(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('flips_guild_created_idx').on(table.guildId, table.createdAt),
    index('flips_challenger_idx').on(table.guildId, table.challengerId),
    index('flips_opponent_idx').on(table.guildId, table.opponentId),
  ],
);

export const rolls = sqliteTable(
  'rolls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    bet: integer('bet').notNull(),
    call: text('call', { enum: diceCallKinds }).notNull(),
    /** The called total for an exact call, null otherwise. */
    target: integer('target'),
    die1: integer('die1').notNull(),
    die2: integer('die2').notNull(),
    /** 1 for a win, 0 for a loss. */
    won: integer('won').notNull(),
    payout: integer('payout').notNull(),
    edge: integer('edge').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('rolls_user_idx').on(table.guildId, table.userId, table.createdAt)],
);

export const playerStats = sqliteTable(
  'player_stats',
  {
    guildId: text('guild_id').notNull(),
    userId: text('user_id').notNull(),
    spins: integer('spins').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    jackpots: integer('jackpots').notNull().default(0),
    wagered: integer('wagered').notNull().default(0),
    won: integer('won').notNull().default(0),
    biggestWin: integer('biggest_win').notNull().default(0),
    bestOdds: integer('best_odds').notNull().default(0),
    flips: integer('flips').notNull().default(0),
    flipWins: integer('flip_wins').notNull().default(0),
    flipWagered: integer('flip_wagered').notNull().default(0),
    flipWon: integer('flip_won').notNull().default(0),
    rolls: integer('rolls').notNull().default(0),
    rollWins: integer('roll_wins').notNull().default(0),
    rollWagered: integer('roll_wagered').notNull().default(0),
    rollWon: integer('roll_won').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index('player_stats_guild_biggest_win_idx').on(table.guildId, table.biggestWin),
    index('player_stats_guild_jackpots_idx').on(table.guildId, table.jackpots),
    index('player_stats_guild_spins_idx').on(table.guildId, table.spins),
  ],
);

export const pots = sqliteTable('pots', {
  guildId: text('guild_id').primaryKey(),
  amount: integer('amount').notNull(),
  lastWinnerId: text('last_winner_id'),
  lastWonAt: integer('last_won_at'),
});

export const guildSettings = sqliteTable('guild_settings', {
  guildId: text('guild_id').primaryKey(),
  economyLogChannelId: text('economy_log_channel_id'),
  modLogChannelId: text('mod_log_channel_id'),
  updatedAt: integer('updated_at').notNull(),
});

export const guildAutoRoles = sqliteTable(
  'guild_auto_roles',
  {
    guildId: text('guild_id').notNull(),
    roleId: text('role_id').notNull(),
    target: text('target', { enum: autoRoleTargets }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.roleId, table.target] })],
);

/** Channels where the games may be played in a guild. No rows means every channel. */
export const guildGameChannels = sqliteTable(
  'guild_game_channels',
  {
    guildId: text('guild_id').notNull(),
    channelId: text('channel_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);

export const jobRuns = sqliteTable('job_runs', {
  name: text('name').primaryKey(),
  lastRunAt: integer('last_run_at').notNull(),
});

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { container } from '@sapphire/framework';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  flips,
  giveaways,
  guildSettings,
  ledger,
  playerStats,
  pots,
  rolls,
  spins,
  wallets,
} from '../src/db/schema.js';

describe('database', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tincazz-db-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  it('is reachable from the Sapphire container', () => {
    container.db = openDatabase(':memory:');

    expect(container.db.select().from(pots).all()).toEqual([]);
  });

  it('applies migrations to a fresh in-memory database', () => {
    const db = openDatabase(':memory:');
    const tables = db.$client
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like '\\_\\_%' escape '\\' and name != 'sqlite_sequence'",
      )
      .pluck()
      .all();

    expect((tables as string[]).sort()).toEqual([
      'flips',
      'giveaways',
      'guild_auto_roles',
      'guild_game_channels',
      'guild_settings',
      'job_runs',
      'ledger',
      'pending_coinflip_challenges',
      'pending_screenings',
      'player_stats',
      'poll_votes',
      'polls',
      'pots',
      'rolls',
      'spins',
      'wallets',
    ]);
  });

  it('round-trips a row through every table', () => {
    const db = openDatabase(':memory:');
    const wallet = {
      guildId: 'g',
      userId: 'u',
      balance: 100,
      dailyStreak: 0,
      lastDailyAt: null,
      lastBailoutAt: null,
      lastChatRewardAt: null,
      lastCollectAt: null,
      departedAt: null,
      createdAt: 1,
    };
    const entry = {
      id: 1,
      guildId: 'g',
      userId: 'u',
      delta: 100,
      balanceAfter: 100,
      reason: 'start' as const,
      ref: null,
      actorId: null,
      note: null,
      createdAt: 1,
    };
    const spin = {
      id: 1,
      guildId: 'g',
      userId: 'u',
      mode: 'free' as const,
      reels: 'a,b,c',
      result: 'none' as const,
      bet: 0,
      payout: 0,
      potWon: 0,
      createdAt: 1,
    };
    const stats = {
      guildId: 'g',
      userId: 'u',
      spins: 0,
      wins: 0,
      jackpots: 0,
      wagered: 0,
      won: 0,
      biggestWin: 0,
      bestOdds: 0,
      flips: 0,
      flipWins: 0,
      flipWagered: 0,
      flipWon: 0,
      botFlipWagered: 0,
      botFlipWon: 0,
      rolls: 0,
      rollWins: 0,
      rollWagered: 0,
      rollWon: 0,
    };
    const pot = { guildId: 'g', amount: 5, lastWinnerId: null, lastWonAt: null };

    db.insert(wallets).values({ guildId: 'g', userId: 'u', balance: 100, createdAt: 1 }).run();
    db.insert(ledger)
      .values({
        guildId: 'g',
        userId: 'u',
        delta: 100,
        balanceAfter: 100,
        reason: 'start',
        createdAt: 1,
      })
      .run();
    db.insert(spins)
      .values({
        guildId: 'g',
        userId: 'u',
        mode: 'free',
        reels: 'a,b,c',
        result: 'none',
        createdAt: 1,
      })
      .run();
    db.insert(playerStats).values({ guildId: 'g', userId: 'u' }).run();
    db.insert(pots).values({ guildId: 'g', amount: 5 }).run();

    expect(db.select().from(wallets).all()).toEqual([wallet]);
    expect(db.select().from(ledger).all()).toEqual([entry]);
    expect(db.select().from(spins).all()).toEqual([spin]);
    expect(db.select().from(playerStats).all()).toEqual([stats]);
    expect(db.select().from(pots).all()).toEqual([pot]);
  });

  it('rejects a negative balance', () => {
    const db = openDatabase(':memory:');
    db.insert(wallets).values({ guildId: 'g', userId: 'u', balance: 0, createdAt: 1 }).run();

    expect(() => db.update(wallets).set({ balance: -1 }).run()).toThrow(/CHECK constraint/);
  });

  it('enables WAL and foreign keys on file databases', () => {
    const db = openDatabase(join(dir, 'x.db'));

    expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase(db);
  });

  it('creates missing parent directories', () => {
    const path = join(dir, 'nested', 'deeper', 'tincazz.db');
    closeDatabase(openDatabase(path));

    expect(existsSync(path)).toBe(true);
  });

  it('keeps data and does not re-run migrations on reopen', () => {
    const path = join(dir, 'tincazz.db');
    const first = openDatabase(path);
    first.insert(pots).values({ guildId: 'g', amount: 7 }).run();
    const migrationCount = first.$client.prepare('select count(*) from __drizzle_migrations');
    const applied = migrationCount.pluck().get();
    closeDatabase(first);

    const second = openDatabase(path);

    expect(second.select().from(pots).all()).toEqual([
      { guildId: 'g', amount: 7, lastWinnerId: null, lastWonAt: null },
    ]);
    expect(second.$client.prepare('select count(*) from __drizzle_migrations').pluck().get()).toBe(
      applied,
    );
    closeDatabase(second);
  });

  function copyMigrationsBefore(nextMigration: string) {
    const source = new URL('../drizzle/', import.meta.url);
    const legacy = join(dir, 'legacy');
    mkdirSync(join(legacy, 'meta'), { recursive: true });
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', source), 'utf8')) as {
      entries: { tag: string }[];
    };
    const entries = journal.entries.slice(
      0,
      journal.entries.findIndex(({ tag }) => tag === nextMigration),
    );
    writeFileSync(join(legacy, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) {
      copyFileSync(new URL(`${tag}.sql`, source), join(legacy, `${tag}.sql`));
    }

    return legacy;
  }

  it('keeps existing game-channel allowlists restricted on upgrade', () => {
    const legacy = copyMigrationsBefore('0008_game_channels_restricted');
    const path = join(dir, 'legacy.db');
    const sqlite = new Database(path);
    try {
      migrate(drizzle(sqlite), { migrationsFolder: legacy });
      sqlite.exec(`
        INSERT INTO guild_settings (guild_id, mod_log_channel_id, updated_at)
        VALUES ('configured', 'logs', 10), ('unrestricted', NULL, 20);
        INSERT INTO guild_game_channels (guild_id, channel_id, created_at)
        VALUES ('configured', 'games', 30), ('channel-only', 'games', 40);
      `);
    } finally {
      sqlite.close();
    }
    const db = openDatabase(path);
    try {
      expect(db.select().from(guildSettings).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            guildId: 'configured',
            gameChannelsRestricted: true,
            modLogChannelId: 'logs',
            updatedAt: 10,
          }),
          expect.objectContaining({ guildId: 'channel-only', gameChannelsRestricted: true }),
          expect.objectContaining({ guildId: 'unrestricted', gameChannelsRestricted: false }),
        ]),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades existing giveaways and preserves deadlines and recorded winners', () => {
    const path = join(dir, 'legacy.db');
    const legacy = new Database(path);
    try {
      migrate(drizzle(legacy), {
        migrationsFolder: copyMigrationsBefore('0011_giveaway_publication'),
      });
      legacy.exec(`
        INSERT INTO giveaways (
          id, guild_id, channel_id, message_id, host_id, prize, ends_at, status,
          entry_count, winner_id, drawn_at, next_sync_at
        ) VALUES
          (1, 'guild', 'channel', 'open', 'host', 'Open prize', 100, 'open', 5, NULL, NULL, 85),
          (2, 'guild', 'channel', 'ended', 'host', 'Ended prize', 90, 'ended', 9, 'winner', 92, 92);
      `);
    } finally {
      legacy.close();
    }

    const db = openDatabase(path);
    try {
      expect(db.select().from(giveaways).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: 'open',
            status: 'open',
            endsAt: 100,
            entryCount: 5,
            nextSyncAt: 85,
            accessFailures: 0,
            durationMs: null,
            creationId: null,
          }),
          expect.objectContaining({
            messageId: 'ended',
            status: 'ended',
            endsAt: 90,
            entryCount: 9,
            winnerId: 'winner',
            drawnAt: 92,
            nextSyncAt: 92,
            accessFailures: 0,
            durationMs: null,
            creationId: null,
          }),
        ]),
      );
    } finally {
      closeDatabase(db);
    }
  });

  it('stores a flip and rejects a second flip for the same message', () => {
    const db = openDatabase(':memory:');
    const row = {
      guildId: '2',
      mode: 'open' as const,
      challengerId: '1',
      opponentId: '3',
      bet: 100,
      challengerSide: 'heads' as const,
      resultSide: 'tails' as const,
      winnerId: '3',
      rake: 6,
      messageId: 'm1',
      createdAt: 1,
    };
    db.insert(flips).values(row).run();
    expect(() => db.insert(flips).values(row).run()).toThrow(/UNIQUE/);
    const bot = { ...row, mode: 'bot' as const, opponentId: null, messageId: null };
    db.insert(flips).values(bot).run();
    db.insert(flips).values(bot).run();
  });

  it('defaults the coinflip stats columns to zero', () => {
    const db = openDatabase(':memory:');
    db.insert(playerStats).values({ guildId: '2', userId: '1' }).run();
    expect(db.select().from(playerStats).get()).toMatchObject({
      flips: 0,
      flipWins: 0,
      flipWagered: 0,
      flipWon: 0,
    });
  });

  it('creates the settings, auto-role and job tables and wallets.departed_at', () => {
    const db = openDatabase(':memory:');
    const names = db.$client
      .prepare("select name from sqlite_master where type = 'table'")
      .pluck()
      .all();
    expect(names).toEqual(
      expect.arrayContaining(['guild_settings', 'guild_auto_roles', 'job_runs']),
    );
    const columns = db.$client.prepare('pragma table_info(wallets)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('departed_at');
  });

  it('applies the dice migration: rolls, roll stats and the flips player indexes', () => {
    const db = openDatabase(':memory:');
    db.insert(playerStats).values({ guildId: '2', userId: '1' }).run();
    expect(db.select().from(playerStats).get()).toMatchObject({
      rolls: 0,
      rollWins: 0,
      rollWagered: 0,
      rollWon: 0,
    });
    const row = {
      guildId: '2',
      userId: '1',
      bet: 100,
      call: 'exact' as const,
      target: 12,
      die1: 6,
      die2: 6,
      won: 1,
      payout: 3_564,
      edge: 1,
      createdAt: 1,
    };
    db.insert(rolls).values(row).run();
    expect(db.select().from(rolls).all()).toEqual([{ id: 1, ...row }]);
    const indexes = db.$client
      .prepare("select name from sqlite_master where type = 'index'")
      .pluck()
      .all();
    expect(indexes).toEqual(
      expect.arrayContaining(['rolls_user_idx', 'flips_challenger_idx', 'flips_opponent_idx']),
    );
  });

  it('applies the honeypot migration: honeypot columns with zero kicks', () => {
    const db = openDatabase(':memory:');
    db.insert(guildSettings).values({ guildId: '2', updatedAt: 1 }).run();
    expect(db.select().from(guildSettings).get()).toMatchObject({
      honeypotChannelId: null,
      honeypotMessageId: null,
      honeypotKicks: 0,
    });
  });
});

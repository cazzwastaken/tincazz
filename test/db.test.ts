import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { container } from '@sapphire/framework';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { flips, ledger, playerStats, pots, rolls, spins, wallets } from '../src/db/schema.js';

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
      'guild_auto_roles',
      'guild_game_channels',
      'guild_settings',
      'job_runs',
      'ledger',
      'player_stats',
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
    closeDatabase(first);

    const second = openDatabase(path);

    expect(second.select().from(pots).all()).toEqual([
      { guildId: 'g', amount: 7, lastWinnerId: null, lastWonAt: null },
    ]);
    expect(second.$client.prepare('select count(*) from __drizzle_migrations').pluck().get()).toBe(
      7,
    );
    closeDatabase(second);
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
});

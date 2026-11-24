import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { flips, playerStats, wallets } from '../src/db/schema.js';
import { settleBotFlip, settleChallenge } from '../src/features/coinflip/index.js';
import { getOrCreateWallet } from '../src/features/economy/index.js';
import { leaderboardPage, leaderboardRank, playerProfile } from '../src/features/stats/index.js';

const fund = (db: Db, userId: string) => {
  getOrCreateWallet(db, 'g', userId, 0);
  db.update(wallets).set({ balance: 10_000_000 }).where(eq(wallets.userId, userId)).run();
};

describe('wash trading flips', () => {
  it('keeps challenge and open flips out of the coinflip board', () => {
    const db = openDatabase(':memory:');
    fund(db, '1');
    fund(db, '2');
    let message = 0;
    for (const mode of ['challenge', 'open'] as const) {
      for (const draw of [0, 1]) {
        settleChallenge(
          db,
          {
            guildId: 'g',
            messageId: `m${message++}`,
            mode,
            challengerId: '1',
            acceptorId: '2',
            bet: 1_000,
            challengerSide: 'heads',
          },
          1,
          () => draw,
        );
      }
    }

    expect(leaderboardPage(db, 'g', 'coinflip', 0).rows).toEqual([]);
    expect(leaderboardRank(db, 'g', 'coinflip', '1')).toBeUndefined();
    expect(leaderboardRank(db, 'g', 'coinflip', '2')).toBeUndefined();
  });

  it('still shows every flip in the player-visible totals', () => {
    const db = openDatabase(':memory:');
    fund(db, '1');
    fund(db, '2');
    settleChallenge(
      db,
      {
        guildId: 'g',
        messageId: 'm',
        mode: 'challenge',
        challengerId: '1',
        acceptorId: '2',
        bet: 500,
        challengerSide: 'heads',
      },
      1,
      () => 0,
    );

    const winner = playerProfile(db, 'g', '1', 1) as NonNullable<ReturnType<typeof playerProfile>>;
    expect(winner).toMatchObject({ flips: 1, flipWins: 1, flipWagered: 500 });
    expect(winner.flipWon).toBeGreaterThan(500);
    expect(playerProfile(db, 'g', '2', 1)).toMatchObject({
      flips: 1,
      flipWins: 0,
      flipWagered: 500,
    });
  });

  it('ranks only the bot flips of a player who also flips against members', () => {
    const db = openDatabase(':memory:');
    fund(db, '1');
    fund(db, '2');
    settleBotFlip(db, { guildId: 'g', userId: '1', bet: '100', side: 'heads' }, 1, () => 0);
    settleChallenge(
      db,
      {
        guildId: 'g',
        messageId: 'm',
        mode: 'open',
        challengerId: '1',
        acceptorId: '2',
        bet: 5_000,
        challengerSide: 'heads',
      },
      2,
      () => 0,
    );

    const bot = db.select().from(flips).where(eq(flips.mode, 'bot')).get();
    expect(leaderboardRank(db, 'g', 'coinflip', '1')?.value).toBe(
      (bot?.bet ?? 0) - (bot?.rake ?? 0),
    );
  });

  it('keeps the bot columns equal to the sum of bot flips for any play sequence', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pvp: fc.boolean(),
            bet: fc.integer({ min: 10, max: 2_000 }),
            draw: fc.constantFrom(0, 1),
          }),
          { maxLength: 25 },
        ),
        (plays) => {
          const db = openDatabase(':memory:');
          fund(db, '1');
          fund(db, '2');
          let wagered = 0;
          let won = 0;
          plays.forEach((play, index) => {
            if (play.pvp) {
              settleChallenge(
                db,
                {
                  guildId: 'g',
                  messageId: `m${index}`,
                  mode: 'open',
                  challengerId: '1',
                  acceptorId: '2',
                  bet: play.bet,
                  challengerSide: 'heads',
                },
                1,
                () => play.draw,
              );
            } else {
              const flip = settleBotFlip(
                db,
                { guildId: 'g', userId: '1', bet: String(play.bet), side: 'heads' },
                1,
                () => play.draw,
              );
              wagered += flip.bet;
              won += flip.credited;
            }
          });
          const stats = db.select().from(playerStats).where(eq(playerStats.userId, '1')).get();
          expect(stats?.botFlipWagered ?? 0).toBe(wagered);
          expect(stats?.botFlipWon ?? 0).toBe(won);
          expect(
            db.select().from(playerStats).where(eq(playerStats.userId, '2')).get()
              ?.botFlipWagered ?? 0,
          ).toBe(0);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('backfills the bot columns from existing flips in the migration', () => {
    const db = openDatabase(':memory:');
    fund(db, '1');
    settleBotFlip(db, { guildId: 'g', userId: '1', bet: '100', side: 'heads' }, 1, () => 0);
    settleBotFlip(db, { guildId: 'g', userId: '1', bet: '200', side: 'heads' }, 2, () => 1);
    const before = db.select().from(playerStats).get();
    db.update(playerStats).set({ botFlipWagered: 0, botFlipWon: 0 }).run();

    const sql = readFileSync(
      new URL('../drizzle/0014_challenge_guild_bot_flip_stats.sql', import.meta.url),
      'utf8',
    );
    const backfill = sql.split('--> statement-breakpoint').at(-1) as string;
    db.$client.exec(backfill);

    const after = db.select().from(playerStats).get();
    expect(after?.botFlipWagered).toBe(300);
    expect(after?.botFlipWagered).toBe(before?.botFlipWagered);
    expect(after?.botFlipWon).toBe(before?.botFlipWon);
  });
});

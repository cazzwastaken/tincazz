import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { flipSides, flips, ledger, pots, rolls, spins, wallets } from '../src/db/schema.js';
import { settleBotFlip, settleChallenge } from '../src/features/coinflip/index.js';
import { type DiceCall, settleRoll } from '../src/features/dice/index.js';
import {
  adminAdjust,
  bailout,
  cashback,
  chatReward,
  claimBailout,
  claimCollect,
  claimDaily,
  coinsRank,
  collect,
  EconomyError,
  findWallet,
  gamblingReasons,
  getOrCreateWallet,
  purgeWallet,
  rewardChat,
  startingBalance,
  utcDay,
} from '../src/features/economy/index.js';
import { pot } from '../src/features/gamba/config.js';
import { InvalidBetError, settleSpin } from '../src/features/gamba/index.js';
import { maxPotWin, potContribution } from '../src/features/gamba/pot.js';
import { markDeparted, markPresent, members } from '../src/features/members/index.js';
import { leaderboardPage, leaderboardRank } from '../src/features/stats/index.js';
import { expectLedgerConsistent } from './support/ledger.js';

const guilds = ['1', '2'] as const;
const users = ['3', '4', '123456789012345678'] as const;
const who = fc.record({ guildId: fc.constantFrom(...guilds), userId: fc.constantFrom(...users) });

// One draw per reel from [0, 21): 0-17 are yt emojis, 18-19 python, 20 cpp. Bias toward triples.
const reels = fc.oneof(
  fc.tuple(fc.nat({ max: 20 }), fc.nat({ max: 20 }), fc.nat({ max: 20 })),
  fc.constantFrom([0, 0, 0], [18, 18, 18], [20, 20, 20], [20, 20, 0], [18, 19, 0]),
);

const betText = fc.oneof(
  fc.integer({ min: -10, max: 20_000 }).map(String),
  fc.constantFrom('all', 'half', 'ALL', '2.5k', '10k', '0.01k', '1e3', '', ' ', '9'.repeat(30)),
  fc.string({ unit: 'binary', maxLength: 12 }),
);

const sqlPayloads = [
  "'); DROP TABLE wallets;--",
  "' OR '1'='1",
  '"; DELETE FROM ledger; --',
  '%',
  '_',
  '\\',
  "''''",
  '1; ATTACH DATABASE ":memory:" AS x; --',
  'NULL',
  '\u0000',
  'a\u0000b',
];

const reason = fc.oneof(
  fc.constantFrom(...sqlPayloads),
  fc.string({ unit: 'grapheme', maxLength: 220 }),
  fc.constant('   '),
);

const adminAmount = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }),
  fc.integer({ min: -5, max: 1_000_005 }),
  fc.constantFrom(0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2),
);

/** Every dice call: the four named ones and the ten exact totals (7 is `seven`). */
const diceCalls: DiceCall[] = [
  { kind: 'high' },
  { kind: 'low' },
  { kind: 'seven' },
  { kind: 'doubles' },
  ...[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((target) => ({ kind: 'exact' as const, target })),
];

const op = fc.oneof(
  fc.record({ kind: fc.constant('wager' as const), who, reels, bet: betText }),
  fc.record({
    kind: fc.constant('diceRoll' as const),
    who,
    bet: betText,
    call: fc.constantFrom(...diceCalls),
    // One draw per die from [0, 6): draw d rolls a d + 1.
    draws: fc.tuple(fc.nat(5), fc.nat(5)),
  }),
  fc.record({
    kind: fc.constant('flipBot' as const),
    who,
    bet: betText,
    side: fc.constantFrom(...flipSides),
    draw: fc.constantFrom(0, 1),
  }),
  fc.record({
    kind: fc.constant('flipChallenge' as const),
    who,
    acceptorOffset: fc.integer({ min: 1, max: users.length - 1 }),
    mode: fc.constantFrom('challenge' as const, 'open' as const),
    bet: fc.integer({ min: 10, max: 10_000 }),
    side: fc.constantFrom(...flipSides),
    draw: fc.constantFrom(0, 1),
    // A small range, so repeats exercise ChallengeTakenError.
    message: fc.nat({ max: 5 }),
  }),
  fc.record({ kind: fc.constant('daily' as const), who }),
  fc.record({ kind: fc.constant('bailout' as const), who }),
  fc.record({ kind: fc.constant('collect' as const), who }),
  fc.record({ kind: fc.constant('chat' as const), who }),
  fc.record({
    kind: fc.constant('admin' as const),
    who,
    action: fc.constantFrom('give' as const, 'take' as const),
    amount: adminAmount,
    reason,
  }),
  fc.record({ kind: fc.constant('leave' as const), who }),
  fc.record({ kind: fc.constant('rejoin' as const), who }),
  fc.record({ kind: fc.constant('purge' as const) }),
  fc.record({
    kind: fc.constant('wait' as const),
    ms: fc.oneof(
      fc.nat({ max: 120_000 }),
      fc.constantFrom(
        chatReward.cooldownMs,
        bailout.cooldownMs,
        3_600_000,
        86_400_000,
        members.graceMs,
      ),
      fc.nat({ max: 3 * 86_400_000 }),
    ),
  }),
);

type Op = typeof op extends fc.Arbitrary<infer T> ? T : never;

function draws(values: readonly number[]) {
  let index = 0;
  return () => values[index++ % values.length] as number;
}

/** Applies one op and returns the coins a purge removed (0 for every other op). */
async function apply(db: Db, step: Op, now: number): Promise<number> {
  if (step.kind === 'wait') return 0;
  if (step.kind === 'purge') {
    // As reconcileGuild would: every wallet departed for at least the grace period, in one transaction.
    return db.transaction((tx) =>
      tx
        .select()
        .from(wallets)
        .all()
        .filter((w) => w.departedAt !== null && now - w.departedAt >= members.graceMs)
        .reduce((sum, w) => sum + purgeWallet(tx, w.guildId, w.userId, now), 0),
    );
  }
  const { guildId, userId } = step.who;
  switch (step.kind) {
    case 'leave':
      markDeparted(db, guildId, userId, now);
      return 0;
    case 'rejoin':
      markPresent(db, guildId, userId);
      return 0;
    case 'wager': {
      const potBefore = potAmount(db, guildId) ?? pot.seed;
      const { played } = await settleSpin(db, { guildId, userId, bet: step.bet }, now, {
        assignJackpotRole: async () => true,
        randomInt: draws(step.reels),
      });
      const before = potBefore + potContribution(played.bet);
      expect(played.potWon, 'a win takes at most its per-bet cap').toBeLessThanOrEqual(
        maxPotWin(played.bet, played.evaluation.tier),
      );
      if (played.evaluation.result !== 'jackpot') {
        // A rarer win pays from the excess over the seed: the pot loses exactly what was won.
        expect(played.potWon, 'a rare win takes at most the excess').toBeLessThanOrEqual(
          before - pot.seed,
        );
        expect(played.pot).toBe(before - played.potWon);
      }
      expect(potAmount(db, guildId)).toBe(played.pot);
      return 0;
    }
    case 'diceRoll': {
      const potBefore = potAmount(db, guildId);
      const roll = settleRoll(
        db,
        { guildId, userId, bet: step.bet, call: step.call },
        now,
        draws(step.draws),
      );
      // Conservation counts the edge into the pot: the pot grows by exactly the roll's edge.
      expect(roll.pot, 'a roll adds its edge to the pot').toBe((potBefore ?? pot.seed) + roll.edge);
      expect(potAmount(db, guildId)).toBe(roll.pot);
      return 0;
    }
    case 'flipBot':
      settleBotFlip(
        db,
        { guildId, userId, bet: step.bet, side: step.side },
        now,
        draws([step.draw]),
      );
      return 0;
    case 'flipChallenge':
      settleChallenge(
        db,
        {
          guildId,
          messageId: `m${step.message}`,
          mode: step.mode,
          challengerId: userId,
          acceptorId: users[
            (users.indexOf(userId as never) + step.acceptorOffset) % users.length
          ] as string,
          bet: step.bet,
          challengerSide: step.side,
        },
        now,
        draws([step.draw]),
      );
      return 0;
    case 'daily':
      claimDaily(db, guildId, userId, now);
      return 0;
    case 'bailout':
      claimBailout(db, guildId, userId, now);
      return 0;
    case 'collect':
      claimCollect(db, guildId, userId, now);
      return 0;
    case 'chat':
      rewardChat(db, guildId, userId, now);
      return 0;
    case 'admin':
      adminAdjust(db, { guildId, userId, actorId: '9', ...step, now });
      return 0;
  }
}

function potAmount(db: Db, guildId: string): number | undefined {
  return db
    .select()
    .from(pots)
    .all()
    .find((row) => row.guildId === guildId)?.amount;
}

function snapshot(db: Db) {
  return {
    wallets: db.select().from(wallets).all(),
    // `start` rows belong to wallet creation, which a rejected bet may leave behind (see below).
    ledger: db
      .select()
      .from(ledger)
      .all()
      .filter((row) => row.reason !== 'start'),
    spins: db.select().from(spins).all(),
    flips: db.select().from(flips).all(),
    rolls: db.select().from(rolls).all(),
    pots: db.select().from(pots).all(),
  };
}

/** Expected failures; anything else (a plain Error, a RangeError from the ledger) is a bug. */
function isExpectedFailure(step: Op, error: unknown): boolean {
  if (error instanceof EconomyError || error instanceof InvalidBetError) return true;
  return step.kind === 'admin' && error instanceof RangeError;
}

function expectInvariants(db: Db, removed: number): void {
  expectLedgerConsistent(db);
  const allWallets = db.select().from(wallets).all();
  const allLedger = db.select().from(ledger).all();
  const total = (list: number[]) => list.reduce((sum, n) => sum + n, 0);
  expect(total(allWallets.map((w) => w.balance)), 'wallets sum to the ledger sum').toBe(
    total(allLedger.map((row) => row.delta)),
  );
  expect(
    total(allLedger.filter((row) => row.reason === 'pruned').map((row) => row.delta)),
    'pruned deltas equal minus the coins removed',
  ).toBe(removed === 0 ? 0 : -removed);
  for (const wallet of allWallets.filter((w) => w.departedAt !== null)) {
    const { guildId, userId } = wallet;
    expect(
      leaderboardPage(db, guildId, 'coins', 0).rows.some((row) => row.userId === userId),
      'a departed wallet is off the board',
    ).toBe(false);
    expect(leaderboardRank(db, guildId, 'coins', userId)).toBeUndefined();
    expect(coinsRank(db, guildId, userId)).toBeUndefined();
  }
  for (const wallet of db.select().from(wallets).all()) {
    expect(Number.isSafeInteger(wallet.balance)).toBe(true);
    expect(wallet.balance).toBeGreaterThanOrEqual(0);
  }
  for (const row of db.select().from(ledger).all()) {
    expect(Number.isSafeInteger(row.delta)).toBe(true);
    expect(row.delta).not.toBe(0);
  }
  const ledgerRows = db.select().from(ledger).all();
  for (const row of db.select().from(flips).all()) {
    expect(row.rake).toBeGreaterThanOrEqual(1);
    expect(row.rake).toBeLessThanOrEqual(row.bet);
    const mine = ledgerRows.filter(
      (entry) =>
        (entry.reason === 'flip_bet' || entry.reason === 'flip_win') && entry.ref === row.id,
    );
    expect(
      mine.some((entry) => entry.reason === 'flip_bet'),
      'every flip has a stake row',
    ).toBe(true);
    // Coins only leave a flip as the rake (and, against the bot, the bot's side of the pool).
    const net = mine.reduce((sum, entry) => sum + entry.delta, 0);
    if (row.mode === 'bot') {
      expect(net, 'a bot flip nets bet - rake on a win and -bet on a loss').toBe(
        row.winnerId === null ? -row.bet : row.bet - row.rake,
      );
    } else {
      expect(net, 'a player flip loses exactly the rake').toBe(-row.rake);
    }
  }
  for (const row of db.select().from(rolls).all()) {
    expect(row.edge).toBeGreaterThanOrEqual(1);
    expect(row.edge).toBeLessThanOrEqual(row.bet);
    const mine = ledgerRows
      .filter(
        (entry) =>
          (entry.reason === 'dice_bet' || entry.reason === 'dice_win') && entry.ref === row.id,
      )
      .map(({ reason, delta }) => ({ reason, delta }));
    expect(mine, 'a roll has one stake row and, iff won, one win row').toEqual(
      row.won === 1
        ? [
            { reason: 'dice_bet', delta: -row.bet },
            { reason: 'dice_win', delta: row.payout },
          ]
        : [{ reason: 'dice_bet', delta: -row.bet }],
    );
    if (row.won === 0) expect(row.payout).toBe(0);
  }
  for (const row of db.select().from(pots).all()) {
    expect(row.amount).toBeGreaterThanOrEqual(pot.seed);
  }
}

/** Claims and rewards are never paid faster than their cooldowns allow. */
function expectCooldownsHeld(db: Db): void {
  const rows = db.select().from(ledger).all();
  for (const guildId of guilds) {
    for (const userId of users) {
      const mine = rows.filter((row) => row.guildId === guildId && row.userId === userId);
      const times = (reason: string) =>
        mine.filter((row) => row.reason === reason).map((row) => row.createdAt);
      const days = times('daily').map(utcDay);
      expect(new Set(days).size, 'one daily per UTC day').toBe(days.length);
      const gaps = (list: number[]) => list.slice(1).map((time, i) => time - (list[i] as number));
      for (const gap of gaps(times('bailout'))) {
        expect(gap).toBeGreaterThanOrEqual(bailout.cooldownMs);
      }
      for (const row of mine.filter((entry) => entry.reason === 'cashback')) {
        const day = utcDay(row.createdAt) - 1;
        const net = mine
          .filter(
            (entry) =>
              utcDay(entry.createdAt) === day &&
              (gamblingReasons as readonly string[]).includes(entry.reason),
          )
          .reduce((sum, entry) => sum + entry.delta, 0);
        expect(row.delta, "cashback matches yesterday's losses").toBe(
          Math.min(cashback.max, Math.floor((-net * cashback.percent) / 100)),
        );
        expect(
          mine.some((entry) => entry.reason === 'daily' && entry.createdAt === row.createdAt),
          'cashback only comes with a daily',
        ).toBe(true);
      }
      const collects = mine.filter((row) => row.reason === 'collect');
      for (const row of collects) {
        expect(row.delta % collect.perHour, 'collect pays whole hours').toBe(0);
        expect(row.delta).toBeLessThanOrEqual(collect.perHour * collect.maxHours);
      }
      const collected = collects.reduce((sum, row) => sum + row.delta, 0);
      const created = mine.find((row) => row.reason === 'start')?.createdAt;
      const last = collects.at(-1)?.createdAt;
      if (created !== undefined && last !== undefined) {
        expect(collected, 'collect never pays ahead of the clock').toBeLessThanOrEqual(
          Math.floor((last - created) / 3_600_000) * collect.perHour,
        );
      }
      for (const gap of gaps(times('chat'))) {
        expect(gap).toBeGreaterThanOrEqual(chatReward.cooldownMs);
      }
    }
  }
}

describe('economy fuzz', () => {
  it('keeps every wallet consistent and non-negative under random play', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        fc.array(op, { minLength: 1, maxLength: 50 }),
        async (start, steps) => {
          const db = openDatabase(':memory:');
          let now = start;
          let removed = 0;
          for (const step of steps) {
            if (step.kind === 'wait') {
              now += step.ms;
              continue;
            }
            if (step.kind === 'purge') {
              removed += await apply(db, step, now);
              expectInvariants(db, removed);
              continue;
            }
            const before = snapshot(db);
            const existed = findWallet(db, step.who.guildId, step.who.userId) !== undefined;
            try {
              removed += await apply(db, step, now);
            } catch (error) {
              if (!isExpectedFailure(step, error)) throw error;
              const after = snapshot(db);
              if (
                (step.kind === 'wager' || step.kind === 'flipBot' || step.kind === 'diceRoll') &&
                !existed
              ) {
                // settleSpin, settleBotFlip and settleRoll open the wallet before reading the bet;
                // that is all they may leave. settleChallenge is fully atomic.
                const created = findWallet(db, step.who.guildId, step.who.userId);
                expect(created?.balance).toBe(startingBalance);
                after.wallets = after.wallets.filter(
                  (w) => !(w.guildId === step.who.guildId && w.userId === step.who.userId),
                );
              }
              expect(after, `a failed ${step.kind} changed nothing`).toEqual(before);
            }
            expectInvariants(db, removed);
          }
          expectCooldownsHeld(db);
        },
      ),
      { numRuns: 200 },
    );
  }, 30_000);

  it('stores moderator reasons verbatim, whatever SQL they contain', () => {
    const db = openDatabase(':memory:');
    const tables = () =>
      db.$client.prepare("select name from sqlite_master where type = 'table' order by name").all();
    const before = tables();
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(...sqlPayloads), fc.string({ unit: 'grapheme', maxLength: 200 })),
        (text) => {
          const note = text.trim();
          fc.pre(note.length >= 1 && note.length <= 200);
          adminAdjust(db, {
            guildId: '1',
            userId: '3',
            actorId: '9',
            action: 'give',
            amount: 1,
            reason: text,
            now: 1,
          });
          const last = db.$client
            .prepare('select note from ledger order by id desc limit 1')
            .pluck()
            .get();
          expect(last).toBe(note);
        },
      ),
      { numRuns: 500 },
    );
    expect(tables()).toEqual(before);
    expectLedgerConsistent(db);
  });

  it('treats hostile guild and user ids as plain values in every query', () => {
    const hostile = fc.oneof(
      fc.constantFrom(...sqlPayloads),
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 40 }),
    );
    fc.assert(
      fc.property(hostile, hostile, (guildId, userId) => {
        const db = openDatabase(':memory:');
        const tables = db.$client.prepare("select name from sqlite_master where type = 'table'");
        const before = tables.all();
        const wallet = getOrCreateWallet(db, guildId, userId, 1);
        expect(wallet).toMatchObject({ guildId, userId, balance: startingBalance });
        expect(findWallet(db, guildId, userId)).toEqual(wallet);
        expect(coinsRank(db, guildId, userId)).toBeGreaterThanOrEqual(1);
        expect(leaderboardRank(db, guildId, 'coins', userId)?.value).toBe(startingBalance);
        const board = leaderboardPage(db, guildId, 'coins', 0);
        expect(board.rows).toEqual([{ userId, value: startingBalance, rank: 1 }]);
        expect(tables.all()).toEqual(before);
        expectLedgerConsistent(db);
      }),
      { numRuns: 300 },
    );
  });
});

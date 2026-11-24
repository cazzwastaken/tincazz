import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/db/index.js';
import { flips, ledger, playerStats, pots, wallets } from '../src/db/schema.js';
import {
  type ChallengeRequest,
  ChallengeTakenError,
  ShortStakeError,
  settleBotFlip,
  settleChallenge,
} from '../src/features/coinflip/index.js';
import {
  debit,
  findWallet,
  getOrCreateWallet,
  InsufficientFundsError,
  startingBalance,
} from '../src/features/economy/index.js';
import { pot } from '../src/features/gamba/config.js';
import { expectLedgerConsistent } from './support/ledger.js';

let db: Db;

beforeEach(() => {
  db = openDatabase(':memory:');
});

const reasonsFor = (userId: string) =>
  db
    .select()
    .from(ledger)
    .where(eq(ledger.userId, userId))
    .all()
    .map((row) => row.reason);
const statsFor = (userId: string) =>
  db.select().from(playerStats).where(eq(playerStats.userId, userId)).get();
const flipRow = (id: number) => db.select().from(flips).where(eq(flips.id, id)).get();
const balanceOf = (userId: string) => findWallet(db, 'g', userId)?.balance;
const potAmount = () => db.select().from(pots).get()?.amount;

const snapshot = () => ({
  wallets: db.select().from(wallets).all(),
  ledger: db.select().from(ledger).all(),
  flips: db.select().from(flips).all(),
  pots: db.select().from(pots).all(),
  stats: db.select().from(playerStats).all(),
});

describe('settleBotFlip', () => {
  it('pays a won flip 2B minus rake and feeds the pot', () => {
    const flip = settleBotFlip(
      db,
      { guildId: 'g', userId: 'u', bet: '100', side: 'heads' },
      5,
      () => 0,
    );
    expect(flip).toMatchObject({
      won: true,
      result: 'heads',
      rake: 6,
      credited: 194,
      balance: startingBalance + 94,
      pot: pot.seed + 6,
    });
    expect(reasonsFor('u')).toEqual(['start', 'flip_bet', 'flip_win']);
    const refs = db
      .select()
      .from(ledger)
      .all()
      .filter((row) => row.reason !== 'start');
    expect(refs.map((row) => row.ref)).toEqual([flip.flipId, flip.flipId]);
    expect(statsFor('u')).toMatchObject({ flips: 1, flipWins: 1, flipWagered: 100, flipWon: 194 });
    expectLedgerConsistent(db);
  });

  it('burns a lost flip and adds nothing to the pot', () => {
    const flip = settleBotFlip(
      db,
      { guildId: 'g', userId: 'u', bet: '100', side: 'heads' },
      5,
      () => 1,
    );
    expect(flip).toMatchObject({
      won: false,
      credited: 0,
      rake: 0,
      balance: startingBalance - 100,
      pot: pot.seed,
    });
    expect(flipRow(flip.flipId)).toMatchObject({
      mode: 'bot',
      winnerId: null,
      opponentId: null,
      messageId: null,
    });
    expect(statsFor('u')).toMatchObject({ flips: 1, flipWins: 0, flipWagered: 100, flipWon: 0 });
  });

  it('defaults to 10 coins', () => {
    const flip = settleBotFlip(db, { guildId: 'g', userId: 'u', side: 'tails' }, 5, () => 1);
    expect(flip).toMatchObject({ bet: 10, rake: 1, credited: 19 });
  });

  it('rejects a bet the wallet cannot cover and writes no flip', () => {
    getOrCreateWallet(db, 'g', 'u', 1);
    debit(db, { guildId: 'g', userId: 'u', amount: startingBalance - 5, reason: 'bet', now: 2 });
    expect(() => settleBotFlip(db, { guildId: 'g', userId: 'u', side: 'heads' }, 5)).toThrow(
      InsufficientFundsError,
    );
    expect(db.select().from(flips).all()).toEqual([]);
    expect(potAmount()).toBeUndefined();
  });
});

describe('settleChallenge', () => {
  const request: ChallengeRequest = {
    guildId: 'g',
    messageId: 'm1',
    mode: 'challenge',
    challengerId: 'a',
    acceptorId: 'b',
    bet: 100,
    challengerSide: 'heads',
  };

  it('pays the winner B minus rake net, takes B from the loser and feeds the pot', () => {
    const settled = settleChallenge(db, request, 5, () => 1);
    expect(settled).toMatchObject({
      result: 'tails',
      winnerId: 'b',
      loserId: 'a',
      rake: 6,
      credited: 194,
      challengerBalance: startingBalance - 100,
      acceptorBalance: startingBalance + 94,
      pot: pot.seed + 6,
    });
    expect(balanceOf('a')).toBe(startingBalance - 100);
    expect(balanceOf('b')).toBe(startingBalance + 94);
    expect(flipRow(settled.flipId)).toMatchObject({
      mode: 'challenge',
      challengerId: 'a',
      opponentId: 'b',
      winnerId: 'b',
      messageId: 'm1',
    });
    expect(statsFor('a')).toMatchObject({ flips: 1, flipWins: 0, flipWagered: 100, flipWon: 0 });
    expect(statsFor('b')).toMatchObject({ flips: 1, flipWins: 1, flipWagered: 100, flipWon: 194 });
    expectLedgerConsistent(db);
  });

  it('credits the challenger when the called side lands', () => {
    const settled = settleChallenge(db, request, 5, () => 0);
    expect(settled).toMatchObject({ winnerId: 'a', challengerBalance: startingBalance + 94 });
    expect(settled.acceptorBalance).toBe(startingBalance - 100);
  });

  it('creates the wallet of an acceptor who never played', () => {
    getOrCreateWallet(db, 'g', 'a', 1);
    expect(findWallet(db, 'g', 'b')).toBeUndefined();
    settleChallenge(db, request, 5, () => 1);
    expect(reasonsFor('b')).toEqual(['start', 'flip_bet', 'flip_win']);
  });

  it('throws ShortStakeError for a short challenger and changes nothing', () => {
    getOrCreateWallet(db, 'g', 'a', 1);
    debit(db, { guildId: 'g', userId: 'a', amount: startingBalance - 50, reason: 'bet', now: 2 });
    const before = snapshot();
    const error = (() => {
      try {
        settleChallenge(db, request, 5, () => 0);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ShortStakeError);
    expect(error).toMatchObject({ who: 'challenger', userId: 'a', balance: 50, needed: 100 });
    expect(snapshot()).toEqual(before);
  });

  it('throws ShortStakeError for a short acceptor and changes nothing', () => {
    getOrCreateWallet(db, 'g', 'b', 1);
    debit(db, { guildId: 'g', userId: 'b', amount: startingBalance - 5, reason: 'bet', now: 2 });
    const before = snapshot();
    const error = (() => {
      try {
        settleChallenge(db, request, 5, () => 0);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toMatchObject({ who: 'acceptor', userId: 'b', balance: 5, needed: 100 });
    expect(error).toBeInstanceOf(ShortStakeError);
    expect(snapshot()).toEqual(before);
    expect(findWallet(db, 'g', 'a')).toBeUndefined();
  });

  it('settles a message at most once', () => {
    settleChallenge(db, request, 5, () => 0);
    const after = snapshot();
    expect(() => settleChallenge(db, request, 6, () => 0)).toThrow(ChallengeTakenError);
    expect(snapshot()).toEqual(after);
  });

  it('maps the UNIQUE message_id backstop to ChallengeTakenError', () => {
    getOrCreateWallet(db, 'g', 'a', 1);
    getOrCreateWallet(db, 'g', 'b', 1);
    db.insert(flips)
      .values({
        guildId: 'g',
        mode: 'open',
        challengerId: 'x',
        opponentId: 'y',
        bet: 10,
        challengerSide: 'heads',
        resultSide: 'heads',
        winnerId: 'x',
        rake: 1,
        messageId: 'm1',
        createdAt: 1,
      })
      .run();
    expect(() => settleChallenge(db, request, 5, () => 0)).toThrow(ChallengeTakenError);
  });
});

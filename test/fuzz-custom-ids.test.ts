import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { flipSides } from '../src/db/schema.js';
import { wager as flipWager } from '../src/features/coinflip/config.js';
import {
  decodeCoinflipId,
  encodeRematchId,
  type RematchId,
} from '../src/features/coinflip/index.js';
import { wager as diceWager } from '../src/features/dice/config.js';
import {
  type DiceCall,
  decodeDiceId,
  encodeCallSelectId,
  encodeDoubleId,
  encodeRollAgainId,
  type RollAgainId,
} from '../src/features/dice/index.js';
import { wager } from '../src/features/gamba/config.js';
import { decodeSpinId, encodeSpinId, type SpinButtonId } from '../src/features/gamba/index.js';
import {
  decodeLeaderboardId,
  encodeCategoryId,
  encodePageId,
  type LeaderboardId,
  leaderboardCategories,
} from '../src/features/stats/index.js';

const snowflake = fc.stringMatching(/^[0-9]{1,20}$/);
const validBet = fc.integer({ min: wager.minBet, max: wager.maxBet });
const validFlipBet = fc.integer({ min: flipWager.minBet, max: flipWager.maxBet });
const validDiceBet = fc.integer({ min: diceWager.minBet, max: diceWager.maxBet });

const spinId: fc.Arbitrary<SpinButtonId> = fc.oneof(
  fc.record({
    action: fc.constant('again' as const),
    userId: snowflake,
    bet: validBet,
  }),
  fc.record({ action: fc.constant('double' as const), userId: snowflake, bet: validBet }),
);

const leaderboardId: fc.Arbitrary<LeaderboardId> = fc.oneof(
  fc.record({
    kind: fc.constant('page' as const),
    ownerId: snowflake,
    category: fc.constantFrom(...leaderboardCategories),
    page: fc.integer({ min: 0, max: 999_999 }),
  }),
  fc.record({ kind: fc.constant('cat' as const), ownerId: snowflake }),
);

function encodeLeaderboardId(id: LeaderboardId): string {
  return id.kind === 'page'
    ? encodePageId(id.ownerId, id.category, id.page)
    : encodeCategoryId(id.ownerId);
}

// Values that slip past naive number checks: signs, exponents, hex, whitespace, non-ASCII digits.
const nastyToken = fc.oneof(
  fc.constantFrom(
    '',
    '-1',
    '+10',
    '1e3',
    '0x10',
    '10.0',
    ' 10',
    '10 ',
    'NaN',
    'Infinity',
    '１０',
    '١٠',
    '9'.repeat(25),
    '0'.repeat(30),
    'again',
    'double',
    'gamba',
    'lb',
    'page',
    'cat',
    'coins',
    '__proto__',
    'constructor',
  ),
  fc.string({ unit: 'binary', maxLength: 8 }),
);

/** Replaces, inserts or drops one `:`-separated part of a valid ID. */
function mutated(valid: fc.Arbitrary<string>): fc.Arbitrary<string> {
  return fc
    .tuple(valid, fc.nat(), nastyToken, fc.constantFrom('replace', 'insert', 'drop'))
    .map(([id, index, token, edit]) => {
      const parts = id.split(':');
      const at = index % parts.length;
      if (edit === 'replace') parts[at] = token;
      else if (edit === 'insert') parts.splice(at, 0, token);
      else parts.splice(at, 1);
      return parts.join(':');
    });
}

const anySpinIdString = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 100 }),
  mutated(spinId.map(encodeSpinId)),
);
const anyLeaderboardIdString = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 100 }),
  mutated(leaderboardId.map(encodeLeaderboardId)),
);

function expectValidSpinId(id: SpinButtonId): void {
  expect(['again', 'double']).toContain(id.action);
  expect(id.userId).toMatch(/^[0-9]{1,20}$/);
  expect(Number.isSafeInteger(id.bet)).toBe(true);
  expect(id.bet).toBeGreaterThanOrEqual(wager.minBet);
  expect(id.bet).toBeLessThanOrEqual(wager.maxBet);
}

function expectValidLeaderboardId(id: LeaderboardId): void {
  expect(id.ownerId).toMatch(/^[0-9]{1,20}$/);
  if (id.kind === 'page') {
    expect(leaderboardCategories).toContain(id.category);
    expect(Number.isSafeInteger(id.page)).toBe(true);
    expect(id.page).toBeGreaterThanOrEqual(0);
    expect(id.page).toBeLessThanOrEqual(999_999);
  }
}

describe('spin button id fuzz', () => {
  it('round trips every valid id', () => {
    fc.assert(
      fc.property(spinId, (id) => {
        expect(decodeSpinId(encodeSpinId(id))).toEqual(id);
      }),
    );
  });

  it('decodes anything only to a valid id, and decoding is stable', () => {
    fc.assert(
      fc.property(anySpinIdString, (customId) => {
        const id = decodeSpinId(customId);
        if (id === undefined) return;
        expectValidSpinId(id);
        expect(decodeSpinId(encodeSpinId(id))).toEqual(id);
      }),
      { numRuns: 2000 },
    );
  });

  it('never claims a leaderboard id', () => {
    fc.assert(
      fc.property(leaderboardId, (id) => {
        expect(decodeSpinId(encodeLeaderboardId(id))).toBeUndefined();
      }),
    );
  });
});

describe('leaderboard id fuzz', () => {
  it('round trips every valid id', () => {
    fc.assert(
      fc.property(leaderboardId, (id) => {
        expect(decodeLeaderboardId(encodeLeaderboardId(id))).toEqual(id);
      }),
    );
  });

  it('decodes anything only to a valid id, and decoding is stable', () => {
    fc.assert(
      fc.property(anyLeaderboardIdString, (customId) => {
        const id = decodeLeaderboardId(customId);
        if (id === undefined) return;
        expectValidLeaderboardId(id);
        expect(decodeLeaderboardId(encodeLeaderboardId(id))).toEqual(id);
      }),
      { numRuns: 2000 },
    );
  });

  it('never claims a spin button id', () => {
    fc.assert(
      fc.property(spinId, (id) => {
        expect(decodeLeaderboardId(encodeSpinId(id))).toBeUndefined();
      }),
    );
  });
});

describe('coinflip rematch id fuzz', () => {
  const longSnowflake = fc.stringMatching(/^[1-9][0-9]{19}$/);
  const players = (ids: fc.Arbitrary<string>) =>
    fc.tuple(ids, ids).filter(([challengerId, acceptorId]) => challengerId !== acceptorId);
  const rematch = (ids: fc.Arbitrary<string>): fc.Arbitrary<Omit<RematchId, 'kind'>> =>
    fc
      .tuple(players(ids), validFlipBet, fc.constantFrom(...flipSides))
      .map(([[challengerId, acceptorId], bet, challengerSide]) => ({
        challengerId,
        acceptorId,
        bet,
        challengerSide,
      }));

  it('round trips every valid id, within 100 characters even with 20-digit snowflakes', () => {
    fc.assert(
      fc.property(fc.oneof(rematch(snowflake), rematch(longSnowflake)), (id) => {
        const encoded = encodeRematchId(id);
        expect(encoded.length).toBeLessThanOrEqual(100);
        expect(decodeCoinflipId(encoded)).toEqual({ kind: 'rematch', ...id });
      }),
    );
  });

  it('decodes anything only to a valid id, and decoding is stable', () => {
    const anyRematchIdString = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 100 }),
      mutated(rematch(snowflake).map(encodeRematchId)),
    );
    fc.assert(
      fc.property(anyRematchIdString, (customId) => {
        const id = decodeCoinflipId(customId);
        if (id?.kind !== 'rematch') return;
        expect(id.challengerId).toMatch(/^[0-9]{1,20}$/);
        expect(id.acceptorId).toMatch(/^[0-9]{1,20}$/);
        expect(id.challengerId).not.toBe(id.acceptorId);
        expect(id.bet).toBeGreaterThanOrEqual(flipWager.minBet);
        expect(id.bet).toBeLessThanOrEqual(flipWager.maxBet);
        expect(flipSides).toContain(id.challengerSide);
        const { kind: _kind, ...rest } = id;
        expect(decodeCoinflipId(encodeRematchId(rest))).toEqual(id);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('dice roll again id fuzz', () => {
  const encoders = {
    again: encodeRollAgainId,
    double: encodeDoubleId,
    call: encodeCallSelectId,
  } as const;
  const longSnowflake = fc.stringMatching(/^[1-9][0-9]{19}$/);
  const call: fc.Arbitrary<DiceCall> = fc.oneof(
    fc.constantFrom<DiceCall>(
      { kind: 'high' },
      { kind: 'low' },
      { kind: 'seven' },
      { kind: 'doubles' },
    ),
    fc
      .constantFrom(2, 3, 4, 5, 6, 8, 9, 10, 11, 12)
      .map((target): DiceCall => ({ kind: 'exact', target })),
  );
  const rollAgain = (ids: fc.Arbitrary<string>): fc.Arbitrary<Omit<RollAgainId, 'kind'>> =>
    fc.record({ userId: ids, bet: validDiceBet, call });

  it('round trips every valid id, within 100 characters even with 20-digit snowflakes', () => {
    fc.assert(
      fc.property(fc.oneof(rollAgain(snowflake), rollAgain(longSnowflake)), (id) => {
        const encoded = encodeRollAgainId(id);
        expect(encoded.length).toBeLessThanOrEqual(100);
        expect(decodeDiceId(encoded)).toEqual({ kind: 'again', ...id });
      }),
    );
  });

  it('stays within 100 characters for the longest user ID, bet and call code', () => {
    const encoded = encodeRollAgainId({
      userId: '9'.repeat(20),
      bet: diceWager.maxBet,
      call: { kind: 'exact', target: 12 },
    });
    expect(encoded.length).toBeLessThanOrEqual(100);
  });

  it('decodes anything only to a valid id, and decoding is stable', () => {
    const anyRollAgainIdString = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 100 }),
      mutated(rollAgain(snowflake).map(encodeRollAgainId)),
      mutated(rollAgain(snowflake).map(encodeDoubleId)),
      mutated(rollAgain(snowflake).map(encodeCallSelectId)),
    );
    fc.assert(
      fc.property(anyRollAgainIdString, (customId) => {
        const id = decodeDiceId(customId);
        if (id === undefined) return;
        expect(id.userId).toMatch(/^[0-9]{1,20}$/);
        expect(Number.isSafeInteger(id.bet)).toBe(true);
        expect(id.bet).toBeGreaterThanOrEqual(diceWager.minBet);
        expect(id.bet).toBeLessThanOrEqual(diceWager.maxBet);
        const { kind, ...rest } = id;
        expect(decodeDiceId(encoders[kind](rest))).toEqual(id);
      }),
      { numRuns: 2000 },
    );
  });

  it('round trips the Double and Change call ids and keeps the three kinds apart', () => {
    fc.assert(
      fc.property(fc.oneof(rollAgain(snowflake), rollAgain(longSnowflake)), (id) => {
        for (const kind of ['again', 'double', 'call'] as const) {
          const encoded = encoders[kind](id);
          expect(encoded.length).toBeLessThanOrEqual(100);
          expect(decodeDiceId(encoded)).toEqual({ kind, ...id });
        }
        expect(new Set(Object.values(encoders).map((encode) => encode(id))).size).toBe(3);
      }),
    );
  });

  it('rejects dice ids with an unknown kind or the wrong number of parts', () => {
    fc.assert(
      fc.property(
        rollAgain(snowflake),
        fc
          .string({ unit: 'binary', maxLength: 8 })
          .filter((kind) => !/^(again|double|call)$/.test(kind)),
        (id, kind) => {
          const valid = encodeDoubleId(id);
          expect(decodeDiceId(valid.replace(':double:', `:${kind}:`))).toBeUndefined();
          expect(decodeDiceId(`${valid}:x`)).toBeUndefined();
          expect(decodeDiceId(valid.split(':').slice(0, 4).join(':'))).toBeUndefined();
        },
      ),
    );
  });

  it('never claims a coinflip or spin id', () => {
    fc.assert(
      fc.property(spinId, (id) => {
        expect(decodeDiceId(encodeSpinId(id))).toBeUndefined();
      }),
    );
  });
});

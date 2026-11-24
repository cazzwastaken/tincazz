import { describe, expect, it } from 'vitest';
import { wager } from '../src/features/dice/config.js';
import {
  type DiceCall,
  decodeDiceId,
  encodeCall,
  encodeCallSelectId,
  encodeDoubleId,
  encodeRollAgainId,
} from '../src/features/dice/index.js';

const userId = '123456789012345678';
const calls: DiceCall[] = [
  { kind: 'high' },
  { kind: 'low' },
  { kind: 'seven' },
  { kind: 'doubles' },
  ...[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((target) => ({ kind: 'exact', target }) as const),
];

describe('dice custom ids', () => {
  it('encodes Double and Change call with their own kind', () => {
    const terms = { userId, bet: 200, call: { kind: 'low' } } as const;
    expect(encodeDoubleId(terms)).toBe(`dc:double:${userId}:200:l`);
    expect(encodeCallSelectId(terms)).toBe(`dc:call:${userId}:200:l`);
    expect(decodeDiceId(encodeDoubleId(terms))).toEqual({ kind: 'double', ...terms });
    expect(decodeDiceId(encodeCallSelectId(terms))).toEqual({ kind: 'call', ...terms });
  });

  it('holds the same bet limits and call rules for every kind', () => {
    for (const kind of ['again', 'double', 'call']) {
      expect(decodeDiceId(`dc:${kind}:${userId}:10001:h`)).toBeUndefined();
      expect(decodeDiceId(`dc:${kind}:${userId}:9:h`)).toBeUndefined();
      expect(decodeDiceId(`dc:${kind}:${userId}:10:e7`)).toBeUndefined();
      expect(decodeDiceId(`dc:${kind}:x:10:h`)).toBeUndefined();
    }
    expect(decodeDiceId(`dc:Double:${userId}:10:h`)).toBeUndefined();
  });

  it('encodes to dc:again:<userId>:<bet>:<callCode>', () => {
    expect(encodeRollAgainId({ userId, bet: 250, call: { kind: 'exact', target: 9 } })).toBe(
      `dc:again:${userId}:250:e9`,
    );
  });

  it('round-trips every call code', () => {
    for (const call of calls) {
      const id = { userId, bet: 250, call };
      expect(decodeDiceId(encodeRollAgainId(id))).toEqual({ kind: 'again', ...id });
    }
  });

  it('keeps the id within 100 characters at the extremes', () => {
    const encoded = encodeRollAgainId({
      userId: '9'.repeat(20),
      bet: wager.maxBet,
      call: { kind: 'exact', target: 12 },
    });
    expect(encoded.length).toBeLessThanOrEqual(100);
  });

  it('accepts the bet limits and rejects anything outside them', () => {
    const make = (bet: string) => `dc:again:${userId}:${bet}:h`;
    expect(decodeDiceId(make(String(wager.minBet)))?.bet).toBe(wager.minBet);
    expect(decodeDiceId(make(String(wager.maxBet)))?.bet).toBe(wager.maxBet);
    for (const bet of [
      String(wager.minBet - 1),
      String(wager.maxBet + 1),
      '0',
      '-10',
      '1e3',
      'x',
      '',
    ]) {
      expect(decodeDiceId(make(bet))).toBeUndefined();
    }
  });

  it('rejects other prefixes, bad call codes, bad users and wrong part counts', () => {
    for (const customId of [
      `cf:again:${userId}:10:h`,
      `gamba:again:${userId}:10`,
      `dc:rematch:${userId}:10:h`,
      `dc:again:${userId}:10:x`,
      `dc:again:${userId}:10:e7`,
      `dc:again:${userId}:10:e09`,
      `dc:again:${userId}:10:e13`,
      `dc:again:${userId}:10:`,
      `dc:again:abc:10:h`,
      `dc:again::10:h`,
      `dc:again:${'1'.repeat(21)}:10:h`,
      `dc:again:${userId}:10`,
      `dc:again:${userId}:10:h:extra`,
      '',
      'dc',
    ]) {
      expect(decodeDiceId(customId)).toBeUndefined();
    }
  });

  it('agrees with encodeCall for the call part', () => {
    for (const call of calls) {
      expect(encodeRollAgainId({ userId, bet: 10, call }).endsWith(`:${encodeCall(call)}`)).toBe(
        true,
      );
    }
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  callLabel,
  type DiceCall,
  decodeCall,
  defaultCall,
  dice,
  diceEdge,
  dieFace,
  encodeCall,
  needsText,
  payoutBps,
  payoutFor,
  rollDice,
  ways,
  wins,
} from '../src/features/dice/index.js';

const exactTargets = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
const allCalls: DiceCall[] = [
  { kind: 'high' },
  { kind: 'low' },
  { kind: 'seven' },
  { kind: 'doubles' },
  ...exactTargets.map((target): DiceCall => ({ kind: 'exact', target })),
];

describe('dice config', () => {
  it('returns 99% with a 1% edge', () => {
    expect(dice).toEqual({ returnBps: 9_900, edgePercent: 1 });
    expect(defaultCall).toEqual({ kind: 'high' });
  });
});

describe('payoutBps', () => {
  it('pays high and low 23,760', () => {
    expect(payoutBps({ kind: 'high' })).toBe(23_760);
    expect(payoutBps({ kind: 'low' })).toBe(23_760);
  });

  it('pays seven and doubles 59,400', () => {
    expect(payoutBps({ kind: 'seven' })).toBe(59_400);
    expect(payoutBps({ kind: 'doubles' })).toBe(59_400);
  });

  it('pays exact totals by how rare they are', () => {
    const bps = (target: number) => payoutBps({ kind: 'exact', target });
    expect([bps(2), bps(12)]).toEqual([356_400, 356_400]);
    expect([bps(3), bps(11)]).toEqual([178_200, 178_200]);
    expect([bps(4), bps(10)]).toEqual([118_800, 118_800]);
    expect([bps(5), bps(9)]).toEqual([89_100, 89_100]);
    expect([bps(6), bps(8)]).toEqual([71_280, 71_280]);
  });
});

describe('payoutFor and diceEdge', () => {
  it('rounds the payout down or up with the fraction as the odds', () => {
    // 100 on high pays 237.6: 6000 of 10000 draws round up.
    expect(payoutFor({ kind: 'high' }, 100, () => 5_999)).toBe(238);
    expect(payoutFor({ kind: 'high' }, 100, () => 6_000)).toBe(237);
    // 10 on seven pays 59.4.
    expect(payoutFor({ kind: 'seven' }, 10, () => 3_999)).toBe(60);
    expect(payoutFor({ kind: 'seven' }, 10, () => 4_000)).toBe(59);
  });

  it('draws nothing when the payout is a whole number', () => {
    const never = () => {
      throw new Error('no draw expected');
    };
    expect(payoutFor({ kind: 'high' }, 25_000, never)).toBe(59_400);
    expect(payoutFor({ kind: 'exact', target: 2 }, 100, never)).toBe(3_564);
  });

  it('takes the edge as a share of the bet, rounded with the fraction as the odds', () => {
    const never = () => {
      throw new Error('no draw expected');
    };
    expect(diceEdge(100, never)).toBe(1);
    expect(diceEdge(10_000, never)).toBe(100);
    expect(diceEdge(10, () => 9)).toBe(1);
    expect(diceEdge(10, () => 10)).toBe(0);
    expect(diceEdge(250, () => 49)).toBe(3);
    expect(diceEdge(250, () => 50)).toBe(2);
  });
});

describe('ways and wins', () => {
  it('counts the ways of every call', () => {
    expect(ways({ kind: 'high' })).toBe(15);
    expect(ways({ kind: 'low' })).toBe(15);
    expect(ways({ kind: 'seven' })).toBe(6);
    expect(ways({ kind: 'doubles' })).toBe(6);
    expect(ways({ kind: 'exact', target: 2 })).toBe(1);
    expect(ways({ kind: 'exact', target: 6 })).toBe(5);
    expect(ways({ kind: 'exact', target: 8 })).toBe(5);
  });

  it('judges a roll', () => {
    expect(wins({ kind: 'high' }, 4, 4)).toBe(true);
    expect(wins({ kind: 'high' }, 4, 3)).toBe(false);
    expect(wins({ kind: 'low' }, 3, 3)).toBe(true);
    expect(wins({ kind: 'low' }, 4, 3)).toBe(false);
    expect(wins({ kind: 'seven' }, 2, 5)).toBe(true);
    expect(wins({ kind: 'seven' }, 2, 4)).toBe(false);
    expect(wins({ kind: 'doubles' }, 3, 3)).toBe(true);
    expect(wins({ kind: 'doubles' }, 3, 4)).toBe(false);
    expect(wins({ kind: 'exact', target: 9 }, 4, 5)).toBe(true);
    expect(wins({ kind: 'exact', target: 9 }, 4, 4)).toBe(false);
  });
});

describe('call codes', () => {
  it('round-trips every call', () => {
    for (const call of allCalls) expect(decodeCall(encodeCall(call))).toEqual(call);
  });

  it('encodes compactly', () => {
    expect(encodeCall({ kind: 'high' })).toBe('h');
    expect(encodeCall({ kind: 'low' })).toBe('l');
    expect(encodeCall({ kind: 'seven' })).toBe('7');
    expect(encodeCall({ kind: 'doubles' })).toBe('d');
    expect(encodeCall({ kind: 'exact', target: 9 })).toBe('e9');
  });

  it('rejects codes it cannot decode', () => {
    for (const code of ['e7', 'e1', 'e13', 'x', '']) expect(decodeCall(code)).toBeUndefined();
  });

  it('rejects non-canonical codes', () => {
    for (const code of ['e09', 'e02', 'e012', 'e+9', 'e 9', 'e９', ' h', 'H', '07', 'e']) {
      expect(decodeCall(code)).toBeUndefined();
    }
  });

  it('only decodes codes that encode back to themselves', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 6 }), fc.stringMatching(/^e[0-9]{0,3}$/)),
        (code) => {
          const call = decodeCall(code);
          if (call !== undefined) expect(encodeCall(call)).toBe(code);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('callLabel and dieFace', () => {
  it('names calls', () => {
    expect(callLabel({ kind: 'high' })).toBe('High');
    expect(callLabel({ kind: 'low' })).toBe('Low');
    expect(callLabel({ kind: 'seven' })).toBe('Seven');
    expect(callLabel({ kind: 'doubles' })).toBe('Doubles');
    expect(callLabel({ kind: 'exact', target: 9 })).toBe('Exact 9');
  });

  it('draws the faces', () => {
    expect([1, 2, 3, 4, 5, 6].map(dieFace).join('')).toBe('⚀⚁⚂⚃⚄⚅');
  });
});

describe('rollDice', () => {
  it('rolls each die as randomInt(6) + 1', () => {
    const draws = [0, 5];
    const seen: number[] = [];
    const roll = rollDice((max) => {
      seen.push(max);
      return draws.shift() ?? 0;
    });
    expect(roll).toEqual([1, 6]);
    expect(seen).toEqual([6, 6]);
  });

  it('rolls within 1-6 by default', () => {
    for (let i = 0; i < 200; i++) {
      for (const die of rollDice()) {
        expect(die).toBeGreaterThanOrEqual(1);
        expect(die).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('needsText', () => {
  it('describes high', () => {
    expect(needsText({ kind: 'high' }, 6)).toBe('⚅ … any 2+ wins');
    expect(needsText({ kind: 'high' }, 3)).toBe('⚂ … needs 5+');
    expect(needsText({ kind: 'high' }, 1)).toBe("⚀ … can't make high now");
  });

  it('describes low', () => {
    expect(needsText({ kind: 'low' }, 1)).toBe('⚀ … needs 5 or less');
    expect(needsText({ kind: 'low' }, 6)).toBe("⚅ … can't make low now");
  });

  it('describes seven, doubles and exact', () => {
    expect(needsText({ kind: 'seven' }, 4)).toBe('⚃ … needs a ⚂');
    expect(needsText({ kind: 'doubles' }, 2)).toBe('⚁ … needs a ⚁ for doubles');
    expect(needsText({ kind: 'exact', target: 12 }, 4)).toBe("⚃ … can't make 12 now");
    expect(needsText({ kind: 'exact', target: 9 }, 4)).toBe('⚃ … needs a ⚄');
  });
});

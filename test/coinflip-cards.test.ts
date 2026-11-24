import { ButtonStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  type BotFlip,
  botFlipCard,
  botFlipFrames,
  ChallengeTakenError,
  type ChallengeView,
  challengeCard,
  challengeClosedCard,
  challengeFlipFrames,
  challengeResultCard,
  challengeTaken,
  flipAnimation,
  flipErrorText,
  type SettledChallenge,
  ShortStakeError,
} from '../src/features/coinflip/index.js';
import { InsufficientFundsError } from '../src/features/economy/errors.js';
import { InvalidBetError, spinErrorText } from '../src/features/gamba/index.js';
import { accents } from '../src/features/ui/index.js';

const limits = { minBet: 10, maxBet: 10_000, defaultBet: 10 };

const json = (c: { toJSON(): unknown }) => JSON.stringify(c.toJSON());
const accent = (c: { toJSON(): { accent_color?: number | null } }) => c.toJSON().accent_color;
const buttonIds = (c: { toJSON(): unknown }) =>
  [...json(c).matchAll(/"custom_id":"([^"]+)"/g)].map((match) => match[1]);

const flip = (extra: Partial<BotFlip> = {}): BotFlip => ({
  bet: 100,
  side: 'heads',
  result: 'heads',
  won: true,
  rake: 6,
  credited: 194,
  balance: 1_094,
  pot: 10_006,
  flipId: 1,
  ...extra,
});

const view = (extra: Partial<ChallengeView> = {}): ChallengeView => ({
  challengerId: '1',
  opponentId: '2',
  bet: 100,
  side: 'heads',
  expiresAt: 1_800_000_000_000,
  ...extra,
});

const settled: SettledChallenge = {
  result: 'tails',
  winnerId: '2',
  loserId: '1',
  rake: 6,
  credited: 194,
  challengerBalance: 900,
  acceptorBalance: 1_094,
  pot: 10_006,
  flipId: 1,
};

describe('botFlipCard', () => {
  it('shows a win with the flip again button', () => {
    const c = botFlipCard('1', flip());
    expect(accent(c)).toBe(accents.win);
    expect(json(c)).toContain('Heads');
    expect(json(c)).toContain('+94');
    expect(json(c)).toContain('balance 1,094 · pot 10,006');
    expect(buttonIds(c)).toEqual(['cf:again:1:100:heads']);
  });

  it('shows a loss', () => {
    const c = botFlipCard('1', flip({ result: 'tails', won: false, credited: 0, balance: 900 }));
    expect(accent(c)).toBe(accents.loss);
    expect(json(c)).toContain('Tails');
    expect(json(c)).toContain('-100');
  });
});

describe('flip frames', () => {
  const frames = (result: 'heads' | 'tails' = 'tails') =>
    botFlipFrames('1', { bet: 2_500, side: 'heads', result });

  it('botFlipFrames returns 4 frames in stage order', () => {
    expect(flipAnimation.stages).toEqual(['toss', 'spin', 'fall', 'edge']);
    const all = frames();
    expect(all).toHaveLength(flipAnimation.stages.length);
    expect(json(all[0] as never)).toContain('# 🪙 ⤴');
    expect(json(all[0] as never)).toContain('-# tossed');
    expect(json(all[2] as never)).toContain('# 🪙 ⤵');
    expect(json(all[2] as never)).toContain('-# falling');
    expect(json(all[3] as never)).toContain('-# teetering on its edge');
  });

  it('the spin frame shows one of ◐ ◓ ◑ ◒', () => {
    const spin = json(frames()[1] as never);
    expect(spin).toMatch(/# [◐◓◑◒]/);
    expect(spin).toContain('-# spinning');
  });

  it('the edge frame shows the losing side with the gold accent', () => {
    const edge = frames('tails')[3] as never;
    expect(json(edge)).toContain('# 🪙 Heads…?');
    expect(accent(edge)).toBe(accents.gold);
    expect(json(frames('heads')[3] as never)).toContain('# 🪙 Tails…?');
  });

  it('uses the brand accent and no buttons before the edge', () => {
    for (const frame of frames().slice(0, 3)) {
      expect(accent(frame)).toBe(accents.brand);
      expect(buttonIds(frame)).toEqual([]);
    }
  });

  it('no frame contains the result card net or "wins"', () => {
    const challenge = challengeFlipFrames(view(), '3', 'tails');
    for (const frame of [...frames(), ...challenge]) {
      expect(json(frame)).not.toMatch(/wins|[+-]\d|balance|pot/);
    }
  });

  it('frames carry the caption', () => {
    for (const frame of frames()) {
      expect(json(frame)).toContain('<@1> called **Heads** · 2,500');
    }
    const challenge = challengeFlipFrames(view({ bet: 100 }), '3', 'heads');
    expect(challenge).toHaveLength(flipAnimation.stages.length);
    for (const frame of challenge) {
      expect(json(frame)).toContain('<@1> vs <@3> · 100 each');
    }
  });
});

describe('challengeCard', () => {
  it('has accept, decline and cancel for a targeted challenge', () => {
    const c = challengeCard(view());
    const ids = buttonIds(c) as string[];
    expect(ids.map((id) => id.split(':').slice(0, 4).join(':'))).toEqual([
      'cf:accept:1:2',
      'cf:decline:1:2',
      'cf:cancel:1:2',
    ]);
    expect(accent(c)).toBe(accents.brand);
    expect(json(c)).toContain('<@2>');
    expect(json(c)).toContain('<t:1800000000:R>');
  });

  it('has accept and cancel for an open challenge', () => {
    const c = challengeCard(view({ opponentId: undefined }));
    const ids = buttonIds(c) as string[];
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^cf:accept:1:0:/);
    expect(json(c)).toContain('Anyone');
  });
});

describe('result and closed cards', () => {
  it('shows the winner and the rake with a rematch button', () => {
    const c = challengeResultCard(view(), settled);
    expect(accent(c)).toBe(accents.gold);
    expect(json(c)).toContain('<@2> wins **194**');
    expect(json(c)).toContain('rake 6 to the pot · pot 10,006');
    expect(buttonIds(c)).toEqual(['cf:rematch:1:2:100:heads']);
    expect(json(c)).toContain('"label":"Rematch"');
    expect(json(c)).toContain(`"style":${ButtonStyle.Secondary}`);
  });

  it('leaves the rake out of the result when none was taken', () => {
    const c = challengeResultCard(view(), { ...settled, rake: 0 });
    expect(json(c)).not.toContain('rake');
    expect(json(c)).toContain('-# pot 10,006');
  });

  it('names the acceptor in the rematch id whoever won', () => {
    const c = challengeResultCard(view({ opponentId: undefined }), {
      ...settled,
      winnerId: '1',
      loserId: '7',
    });
    expect(buttonIds(c)).toEqual(['cf:rematch:1:7:100:heads']);
  });

  it.each([
    ['expired', 'Challenge expired.'],
    ['declined', '<@2> declined.'],
    ['cancelled', '<@1> cancelled.'],
    ['challenger-short', "<@1> can't cover the bet anymore."],
  ] as const)('closes as %s', (reason, text) => {
    const c = challengeClosedCard(view(), reason);
    expect(json(c)).toContain(text);
    expect(buttonIds(c)).toEqual([]);
    expect(accent(c)).toBe(accents.loss);
  });
});

describe('flipErrorText', () => {
  it('explains a short acceptor', () => {
    expect(flipErrorText(new ShortStakeError('acceptor', '3', 5, 100))).toBe(
      'You need 100 coins to accept. You have 5.',
    );
  });

  it('explains a taken challenge', () => {
    expect(flipErrorText(new ChallengeTakenError())).toBe(challengeTaken);
  });

  it('falls back to the gamba texts', () => {
    const invalid = new InvalidBetError('range', '5', limits);
    expect(flipErrorText(invalid)).toBe(spinErrorText(invalid));
    const poor = new InsufficientFundsError(5, 10);
    expect(flipErrorText(poor)).toBe(spinErrorText(poor));
  });

  it('returns undefined for anything else', () => {
    expect(flipErrorText(new Error('boom'))).toBeUndefined();
  });
});

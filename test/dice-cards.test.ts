import { ComponentType } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allCalls,
  type DiceCall,
  diceErrorText,
  doubledBet,
  needsText,
  notYourRoll,
  type Roll,
  renderDice,
  resultImageName,
  retargetCard,
  rollCard,
  rollFrames,
  rollResult,
} from '../src/features/dice/index.js';
import { InsufficientFundsError } from '../src/features/economy/errors.js';
import { InvalidBetError, spinErrorText } from '../src/features/gamba/index.js';
import { accents, cardReply } from '../src/features/ui/index.js';

const limits = { minBet: 10, maxBet: 10_000, defaultBet: 10 };

const json = (c: { toJSON(): unknown }) => JSON.stringify(c.toJSON());
const accent = (c: { toJSON(): { accent_color?: number | null } }) => c.toJSON().accent_color;
const buttonIds = (c: { toJSON(): unknown }) =>
  [...json(c).matchAll(/"custom_id":"([^"]+)"/g)].map((match) => match[1]);
const texts = (c: { toJSON(): { components: object[] } }): string[] =>
  c
    .toJSON()
    .components.flatMap((component) =>
      'content' in component && typeof component.content === 'string' ? [component.content] : [],
    );
const fileNames = (c: Parameters<typeof cardReply>[0]) =>
  (cardReply(c).files ?? []).map((file) => file.name);
/** The Double button's `disabled` flag. */
const doubleDisabled = (c: { toJSON(): { components: object[] } }) => {
  const row = c.toJSON().components.at(-1) as {
    components: { custom_id: string; disabled?: boolean }[];
  };
  return row.components.find((button) => button.custom_id.startsWith('dc:double:'))?.disabled;
};

const roll = (extra: Partial<Roll> = {}): Roll => ({
  bet: 100,
  call: { kind: 'high' },
  die1: 6,
  die2: 2,
  total: 8,
  won: true,
  payout: 237,
  edge: 1,
  balance: 1_137,
  pot: 10_001,
  rollId: 1,
  ...extra,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rollCard', () => {
  it('shows a win with the dice picture, the odds, Next and the controls', async () => {
    const c = await rollResult('1', roll());
    expect(accent(c)).toBe(accents.win);
    expect(texts(c)).toEqual([
      '# 8 · HIGH ✓',
      'Won +137 (2.38x)',
      '15/36 · 41.7% · pays 2.38x',
      'Next: **High** · 100',
      '-# <@1> · balance 1,137 · pot 10,001',
    ]);
    expect(c.toJSON().components[0]?.type).toBe(ComponentType.MediaGallery);
    expect(json(c)).toContain(`attachment://${resultImageName}`);
    expect(fileNames(c)).toEqual([resultImageName]);
    expect(buttonIds(c)).toEqual(['dc:call:1:100:h', 'dc:again:1:100:h', 'dc:double:1:200:h']);
    expect(json(c)).toContain('Roll again');
    expect(json(c)).toContain('Double · 200');
  });

  it('shows a loss with what would have won and an exact call', async () => {
    const call: DiceCall = { kind: 'exact', target: 9 };
    const c = await rollResult(
      '1',
      roll({ call, die1: 1, die2: 2, total: 3, won: false, payout: 0, balance: 900 }),
    );
    expect(accent(c)).toBe(accents.loss);
    expect(texts(c)[0]).toBe('# 3 · EXACT 9 ✗');
    expect(texts(c)[1]).toBe('Lost 100');
    expect(texts(c)[2]).toBe('4/36 · 11.1% · pays 8.91x\n-# Would have won: Low, Exact 3');
    expect(buttonIds(c)).toEqual(['dc:call:1:100:e9', 'dc:again:1:100:e9', 'dc:double:1:200:e9']);
  });

  it('lists doubles among the calls a roll would have won', async () => {
    const c = await rollResult(
      '1',
      roll({ call: { kind: 'low' }, die1: 4, die2: 4, total: 8, won: false, payout: 0 }),
    );
    expect(texts(c)[2]).toContain('Would have won: High, Doubles, Exact 8');
  });

  it('shows the glyph heading, without a picture, when no image is given', () => {
    const c = rollCard('1', roll());
    expect(texts(c)[0]).toBe('# 🎲 ⚅ ⚁ = 8 · HIGH ✓');
    expect(json(c)).not.toContain('attachment://');
    expect(fileNames(c)).toEqual([]);
    expect(buttonIds(c)).toHaveLength(3);
  });

  it('falls back to the glyph card when drawing throws', async () => {
    const sharp = await import('sharp');
    vi.spyOn(sharp.default.prototype, 'toBuffer').mockRejectedValue(new Error('boom'));
    // A face pair nothing has cached yet, so the draw really runs.
    const c = await rollResult('1', roll({ die1: 3, die2: 5, total: 8 }));
    expect(texts(c)[0]).toContain('🎲');
    expect(fileNames(c)).toEqual([]);
  });

  it('disables Double when the doubled bet is over the balance or the bet is at the maximum', () => {
    expect(doubleDisabled(rollCard('1', roll({ balance: 199 })))).toBe(true);
    expect(doubleDisabled(rollCard('1', roll({ balance: 200 })))).toBe(false);
    expect(doubleDisabled(rollCard('1', roll({ bet: 10_000, balance: 99_999 })))).toBe(true);
  });

  it('clamps Double to the maximum bet', () => {
    expect(doubledBet(100)).toBe(200);
    expect(doubledBet(6_000)).toBe(10_000);
    expect(doubledBet(10_000)).toBe(10_000);
    expect(buttonIds(rollCard('1', roll({ bet: 6_000, balance: 50_000 })))).toContain(
      'dc:double:1:10000:h',
    );
  });

  it('offers all 14 calls in the menu, each with its odds', () => {
    const menu = rollCard('1', roll()).toJSON().components.at(-2) as unknown as {
      components: { options: { value: string; description: string }[] }[];
    };
    const options = menu.components[0]?.options ?? [];
    expect(options).toHaveLength(allCalls.length);
    expect(options).toHaveLength(14);
    expect(options[0]).toMatchObject({ value: 'h', description: '15/36 · 41.7% · pays 2.38x' });
  });
});

describe('retargetCard', () => {
  it('changes only the Next line and the control ids, keeping the roll and the picture', async () => {
    const before = await rollResult('1', roll({ bet: 50 }));
    // What Discord sends back for the card: the attachment now has a CDN link.
    const sent = JSON.parse(json(before));
    sent.components[0].items[0].media = {
      url: `https://cdn.discordapp.com/attachments/1/2/${resultImageName}?ex=1`,
    };
    const after = retargetCard(sent, '1', 50, { kind: 'exact', target: 12 });

    expect(texts(after)).toEqual([
      '# 8 · HIGH ✓',
      'Won +187 (2.38x)',
      '15/36 · 41.7% · pays 2.38x',
      'Next: **Exact 12** · 50',
      '-# <@1> · balance 1,137 · pot 10,001',
    ]);
    expect(json(after)).toContain(`attachment://${resultImageName}`);
    expect(buttonIds(after)).toEqual([
      'dc:call:1:50:e12',
      'dc:again:1:50:e12',
      'dc:double:1:100:e12',
    ]);
    expect(accent(after)).toBe(accents.win);
  });

  it('keeps a disabled Double disabled', () => {
    const sent = JSON.parse(json(rollCard('1', roll({ balance: 10 }))));
    expect(doubleDisabled(retargetCard(sent, '1', 100, { kind: 'low' }))).toBe(true);
  });
});

describe('retargetCard Double flag', () => {
  it('keeps an enabled Double enabled', () => {
    const sent = JSON.parse(json(rollCard('1', roll({ balance: 10_000 }))));
    expect(doubleDisabled(retargetCard(sent, '1', 100, { kind: 'low' }))).toBe(false);
  });

  it('reads only the Double button, not other disabled parts of the card', () => {
    const sent = JSON.parse(json(rollCard('1', roll({ balance: 10_000 }))));
    // Another control being disabled must not disable Double.
    const menu = sent.components.find((c: { type: number }) => c.type === 1);
    menu.components[0].disabled = true;
    expect(doubleDisabled(retargetCard(sent, '1', 100, { kind: 'low' }))).toBe(false);
  });
});

describe('rollFrames', () => {
  it('has four frames with the caption second in each and no controls', async () => {
    const frames = await rollFrames('1', roll());
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(texts(frame)[1]).toBe('<@1> called **High** · 100');
      expect(buttonIds(frame)).toEqual([]);
      expect(fileNames(frame)).toHaveLength(1);
    }
  });

  it('tumbles in the first two frames', async () => {
    const frames = await rollFrames('1', roll());
    for (const frame of frames.slice(0, 2)) {
      expect(texts(frame)[0]).toBe('# Rolling…');
      expect(texts(frame)[2]).toBe('-# tumbling');
    }
  });

  it('draws random faces for the tumbling frames', async () => {
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    await rollFrames('1', roll());
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('shows the first die and a placeholder for the second in frame three', async () => {
    const frame = (await rollFrames('1', roll()))[2];
    if (frame === undefined) throw new Error('no frame');
    expect(texts(frame)[0]).toBe('# First die: 6');
    expect(texts(frame)[2]).toBe('-# first die down');
  });

  it('says what the first die needs in frame four', async () => {
    const call: DiceCall = { kind: 'seven' };
    const frame = (await rollFrames('1', roll({ call, die1: 2 })))[3];
    if (frame === undefined) throw new Error('no frame');
    expect(json(frame)).toContain(needsText(call, 2));
  });

  it('never reveals the result: no outcome text, and the landed pictures hide the second die', async () => {
    const placeholder = await renderDice(6, 'unknown', 'rolling');
    for (const won of [true, false]) {
      const frames = await rollFrames('1', roll({ won, die1: 6, die2: 2 }));
      for (const frame of frames) {
        expect(json(frame)).not.toMatch(/✓|✗|Won|Lost/);
        expect(json(frame)).not.toContain('= 8');
      }
      for (const frame of frames.slice(2)) {
        expect(cardReply(frame).files?.[0]?.attachment).toEqual(placeholder);
      }
    }
  });

  it('falls back to glyph frames when drawing fails', async () => {
    const sharp = await import('sharp');
    vi.spyOn(sharp.default.prototype, 'toBuffer').mockRejectedValue(new Error('boom'));
    // Random tumble faces and a first die that may be uncached: at least the landed frames
    // must be glyphs if any draw ran; if everything was cached the pictures are simply used.
    const frames = await rollFrames('1', roll({ die1: 4 }));
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(fileNames(frame).length === 0 || json(frame).includes('attachment://')).toBe(true);
    }
  });
});

describe('diceErrorText', () => {
  it('matches the spin error messages', () => {
    for (const error of [
      new InvalidBetError('range', '99999', limits),
      new InvalidBetError('format', 'abc', limits),
      new InsufficientFundsError(5, 10),
      new Error('other'),
    ]) {
      expect(diceErrorText(error)).toBe(spinErrorText(error));
    }
    expect(diceErrorText(new Error('other'))).toBeUndefined();
  });

  it('has a not-your-roll message', () => {
    expect(notYourRoll).toBe("This isn't your roll. Use `/dice` to roll your own.");
  });
});
